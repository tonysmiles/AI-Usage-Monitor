// Gọi endpoint usage bằng bearer token đã có.
const { AuthRequired } = require('./oauth');

class Expired extends Error {}

const CLAUDE_USAGE_URLS = [
  'https://api.anthropic.com/api/oauth/usage',
  'https://api.anthropic.com/api/oauth/organizations/me/usage',
];
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

async function withRetry(oauth, key, fn) {
  let tokens = await oauth.getTokens(key);
  try {
    return await fn(tokens);
  } catch (e) {
    if (!(e instanceof Expired)) throw e;
  }
  tokens = await oauth.getTokens(key, { force: true });
  try {
    return await fn(tokens);
  } catch (e) {
    if (e instanceof Expired) throw new AuthRequired('Token bị từ chối');
    throw e;
  }
}

async function fetchClaude(oauth, f = fetch) {
  return withRetry(oauth, 'claude', async (t) => {
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
      if (!r.ok) throw new Error(`Claude trả về lỗi ${r.status}`);
      raw = await r.json();
      break;
    }
    if (!raw) throw new Error('Không tìm thấy endpoint usage của Claude (có thể đã đổi)');

    let account = t.email || null;
    let plan = null;
    try {
      const pr = await f(CLAUDE_PROFILE_URL, { headers });
      if (pr.ok) {
        const prof = await pr.json();
        account = account || (prof.account && (prof.account.email || prof.account.email_address)) || null;
        const type = prof.organization && prof.organization.organization_type;
        if (type) plan = String(type).replace(/^claude_/, '');
      }
    } catch (_) { /* tuỳ chọn */ }
    return { raw, account, plan };
  });
}

async function fetchChatGPT(oauth, f = fetch) {
  return withRetry(oauth, 'chatgpt', async (t) => {
    const headers = {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'codex_cli_rs/0.1.0',
    };
    if (t.account_id) headers['ChatGPT-Account-ID'] = t.account_id;
    const r = await f(CHATGPT_USAGE_URL, { headers });
    if (r.status === 401) throw new Expired();
    if (!r.ok) throw new Error(`ChatGPT trả về lỗi ${r.status}`);
    return { raw: await r.json(), account: t.email || null };
  });
}

module.exports = { fetchClaude, fetchChatGPT };
