// Gọi endpoint usage bằng bearer token đã có.
const { AuthRequired } = require('./oauth');

class Expired extends Error {}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

// Dò trường ngày gia hạn trong profile Claude (tên trường không công khai nên dò theo tên).
const RENEWAL_KEYS = /(renew|next_(billing|charge|payment)|current_period_end|billing_period_end|subscription_(end|until|expires)|expires_at|active_until)/i;
function findRenewal(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (RENEWAL_KEYS.test(k)) {
      const ms = toMs(v);
      if (ms && ms > Date.now() - 86400000) return ms;
    }
  }
  for (const v of Object.values(obj)) {
    const r = findRenewal(v, depth + 1);
    if (r) return r;
  }
  return null;
}

const CLAUDE_USAGE_URLS = [
  'https://api.anthropic.com/api/oauth/usage',
  'https://api.anthropic.com/api/oauth/organizations/me/usage',
];
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

async function withRetry(oauth, id, fn) {
  let tokens = await oauth.getTokens(id);
  try {
    return await fn(tokens);
  } catch (e) {
    if (!(e instanceof Expired)) throw e;
  }
  tokens = await oauth.getTokens(id, { force: true });
  try {
    return await fn(tokens);
  } catch (e) {
    if (e instanceof Expired) throw new AuthRequired('Token bị từ chối');
    throw e;
  }
}

async function fetchClaude(oauth, id, f = fetch) {
  return withRetry(oauth, id, async (t) => {
    const headers = {
      Authorization: `Bearer ${t.access_token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': 'claude-cli/2.1.0 (external, cli)',
    };
    let raw = null;
    for (const url of CLAUDE_USAGE_URLS) {
      const r = await f(url, { headers });
      if (r.status === 401) throw new Expired();
      if (r.status === 404) continue;
      if (!r.ok) throw Object.assign(new Error(`Claude trả về lỗi ${r.status}`), { code: 'http', httpStatus: r.status });
      raw = await r.json();
      break;
    }
    if (!raw) throw Object.assign(new Error('Không tìm thấy endpoint usage của Claude (có thể đã đổi)'), { code: 'no_endpoint' });

    let account = t.email || null;
    let plan = null;
    let renewal = null;
    try {
      const pr = await f(CLAUDE_PROFILE_URL, { headers });
      if (pr.ok) {
        const prof = await pr.json();
        account = account || (prof.account && (prof.account.email || prof.account.email_address)) || null;
        const type = prof.organization && prof.organization.organization_type;
        if (type) plan = String(type).replace(/^claude_/, '');
        renewal = findRenewal(prof);
      }
    } catch (_) { /* tuỳ chọn */ }
    return { raw, account, plan, renewal, email: t.email || null };
  });
}

async function fetchChatGPT(oauth, id, f = fetch) {
  return withRetry(oauth, id, async (t) => {
    const headers = {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'codex_cli_rs/0.1.0',
    };
    if (t.account_id) headers['ChatGPT-Account-ID'] = t.account_id;
    const r = await f(CHATGPT_USAGE_URL, { headers });
    if (r.status === 401) throw new Expired();
    if (!r.ok) throw Object.assign(new Error(`ChatGPT trả về lỗi ${r.status}`), { code: 'http', httpStatus: r.status });
    return { raw: await r.json(), account: t.email || null, email: t.email || null, workspace: t.account_id || null, renewal: toMs(t.subscription_until) };
  });
}

// ---------- Gemini (gói Google AI qua Antigravity) ----------
const GEMINI_HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
// Chỉ client nhận diện là "antigravity/hub/..." mới được đọc hạn mức theo gói.
const GEMINI_UA = 'antigravity/hub/2.33.0 windows/amd64';

function geminiErr(r, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (/SUBSCRIPTION_REQUIRED|not eligible|NOT_ELIGIBLE/i.test(text)) {
    return Object.assign(new Error('Tài khoản chưa đủ điều kiện dùng Antigravity'), { code: 'gemini_not_eligible' });
  }
  return Object.assign(new Error(`Gemini trả về lỗi ${r.status}`), { code: 'http', httpStatus: r.status });
}

async function postGemini(f, path, token, body) {
  let last = null;
  for (const host of GEMINI_HOSTS) {
    const r = await f(`${host}/v1internal:${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': GEMINI_UA,
      },
      body: JSON.stringify(body),
    });
    if (r.status === 401) throw new Expired();
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (r.ok) return data || {};
    last = geminiErr(r, data || text);
    if (last.code === 'gemini_not_eligible') throw last;
  }
  throw last;
}

function projectIdOf(load) {
  const p = load && load.cloudaicompanionProject;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object' && p.id) return p.id;
  return null;
}

function tierName(load) {
  const t = (load && (load.paidTier || load.currentTier)) || null;
  if (!t) return null;
  return t.name || t.id || null;
}

async function fetchGemini(oauth, id, f = fetch) {
  return withRetry(oauth, id, async (t) => {
    let project = t.gemini_project || null;
    let plan = t.plan || null;
    // Lần đầu (hoặc chưa có gói): hỏi Antigravity project + tên gói, rồi lưu lại.
    if (!project || !plan) {
      const load = await postGemini(f, 'loadCodeAssist', t.access_token, {
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      });
      project = projectIdOf(load) || project;
      plan = tierName(load) || plan;
      if (oauth.patchTokens) oauth.patchTokens(id, { gemini_project: project, plan });
    }
    if (!project) throw Object.assign(new Error('Chưa thiết lập Antigravity'), { code: 'gemini_no_project' });
    const raw = await postGemini(f, 'retrieveUserQuotaSummary', t.access_token, { project });
    return { raw, account: t.email || null, email: t.email || null, plan, renewal: null };
  });
}

module.exports = { fetchClaude, fetchChatGPT, fetchGemini, findRenewal, toMs, projectIdOf, tierName };
