// OAuth PKCE qua trình duyệt máy + callback localhost.
// Dùng client_id công khai của Claude Code và Codex CLI (không có client riêng cho app bên thứ ba).
const crypto = require('crypto');
const http = require('http');

// Cấu hình client OAuth riêng của máy (không commit). Thiếu file thì provider đó báo lỗi khi đăng nhập.
function loadLocalClients() {
  try { return require('./oauth-clients.local.json'); } catch (_) { return {}; }
}
const LOCAL = loadLocalClients();

const PROVIDERS = {
  claude: {
    name: 'Claude',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    port: 54545,
    callbackPath: '/callback',
    scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers',
    tokenFormat: 'json',
    tokenFallbackFormat: 'form',
    tokenHeaders: { 'User-Agent': 'axios/1.8.4', Accept: 'application/json, text/plain, */*' },
    extraAuth: { code: 'true' },
  },
  chatgpt: {
    name: 'ChatGPT',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    port: 1455,
    callbackPath: '/auth/callback',
    scope: 'openid profile email offline_access',
    tokenFormat: 'form',
    extraAuth: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    accountFromIdToken: true,
  },
  // Gói Google AI (Gemini) cá nhân: hạn mức nằm ở Antigravity, dùng OAuth client công khai của Antigravity.
  gemini: {
    name: 'Gemini',
    tool: 'Antigravity',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Client ID/secret nằm trong src/oauth-clients.local.json (không đưa lên git), xem oauth-clients.example.json.
    clientId: LOCAL.gemini && LOCAL.gemini.clientId,
    clientSecret: LOCAL.gemini && LOCAL.gemini.clientSecret,
    port: 51121,
    callbackPath: '/oauth-callback',
    scope: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '),
    tokenFormat: 'form',
    // select_account: luôn cho chọn tài khoản Google (tiện khi thêm nhiều tài khoản); consent: để nhận refresh_token.
    extraAuth: { access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true' },
    userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },
};

class AuthRequired extends Error {
  constructor(msg = 'Cần đăng nhập') {
    super(msg);
    this.name = 'AuthRequired';
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function parseJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function toolName(p) {
  return p.tool || (p.name === 'Claude' ? 'Claude Code' : 'Codex');
}

function codeErr(code, msg, extra = {}) {
  const e = new Error(msg);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function resultPage(ok, msg) {
  const title = ok ? 'Đăng nhập thành công · Signed in' : 'Đăng nhập thất bại · Sign-in failed';
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title>
<body style="font-family:Segoe UI,sans-serif;background:#14161a;color:#e8eaed;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

function createOAuth({ openUrl, storage, fetchImpl = fetch, providers = PROVIDERS, loginTimeoutMs = 5 * 60 * 1000 }) {
  const cancelers = {};

  async function postTokenOnce(p, params, format) {
    const json = format === 'json';
    const r = await fetchImpl(p.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...(p.tokenHeaders || {}),
      },
      body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (!r.ok || !data || !data.access_token) {
      const e = r.status === 429
        ? codeErr('rate_limited', 'Đang bị giới hạn số lần đăng nhập (HTTP 429). Đợi vài phút rồi thử lại.')
        : codeErr('token_failed', `Đổi token thất bại (HTTP ${r.status})`, { httpStatus: r.status });
      e.status = r.status;
      const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
      if (ra > 0) e.retryAfter = ra;
      throw e;
    }
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function postTokenWithFormat(p, params, format) {
    // Bị 429 thì chờ rồi thử lại (mã xác thực còn hạn vài phút).
    const waits = [3000, 8000, 15000];
    for (let i = 0; ; i++) {
      try {
        return await postTokenOnce(p, params, format);
      } catch (e) {
        if (e.status !== 429 || i >= waits.length) throw e;
        await sleep(Math.min(30000, e.retryAfter ? e.retryAfter * 1000 : waits[i]));
      }
    }
  }

  async function postToken(p, params) {
    try {
      return await postTokenWithFormat(p, params, p.tokenFormat);
    } catch (e) {
      if (p.tokenFallbackFormat && (e.status === 400 || e.status === 415)) {
        return postTokenWithFormat(p, params, p.tokenFallbackFormat);
      }
      throw e;
    }
  }

  function toTokens(p, data, prev) {
    const t = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || (prev && prev.refresh_token) || null,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      id_token: data.id_token || (prev && prev.id_token) || null,
      email: (prev && prev.email) || null,
      account_id: (prev && prev.account_id) || null,
      subscription_until: (prev && prev.subscription_until) || null,
      plan: (prev && prev.plan) || null,
    };
    if (data.account && data.account.email_address) t.email = data.account.email_address;
    if (p.accountFromIdToken && t.id_token) {
      const claims = parseJwt(t.id_token) || {};
      if (claims.email) t.email = claims.email;
      const auth = claims['https://api.openai.com/auth'] || {};
      if (auth.chatgpt_account_id) t.account_id = auth.chatgpt_account_id;
      if (auth.chatgpt_subscription_active_until) t.subscription_until = auth.chatgpt_subscription_active_until;
      if (auth.chatgpt_plan_type) t.plan = auth.chatgpt_plan_type;
    }
    return t;
  }

  function waitForCode(key, p, state, onListening) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://localhost:${p.port}`);
        if (u.pathname !== p.callbackPath) { res.writeHead(404); res.end(); return; }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const st = u.searchParams.get('state');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        if (err || !code || st !== state) {
          res.end(resultPage(false, 'Quay lại app và thử lại · Go back to the app and try again.'));
          finish(err ? codeErr('denied', `Bị từ chối: ${err}`) : codeErr('bad_state', 'Phản hồi không hợp lệ (sai state)'));
          return;
        }
        res.end(resultPage(true, 'Có thể đóng tab này · You can close this tab.'));
        finish(null, code);
      });
      function finish(err, code) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete cancelers[key];
        server.close();
        setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 300).unref();
        if (err) reject(err); else resolve(code);
      }
      cancelers[key] = () => finish(codeErr('cancelled', 'Đã huỷ đăng nhập'));
      timer = setTimeout(() => finish(codeErr('timeout', 'Hết thời gian chờ đăng nhập')), loginTimeoutMs);
      server.on('error', (e) => finish(
        e.code === 'EADDRINUSE'
          ? codeErr('port_in_use', `Cổng ${p.port} đang bị chiếm. Đóng ${toolName(p)} rồi thử lại.`, { port: p.port, tool: toolName(p) })
          : e,
      ));
      server.listen(p.port, '127.0.0.1', onListening);
    });
  }

  // Đăng nhập một tài khoản của `provider`. Không tự lưu: trả token để main gắn vào tài khoản.
  // onUrl(url): báo link xin quyền để người dùng có thể tự sao chép sang trình duyệt khác.
  async function login(provider, { onUrl, open = true } = {}) {
    const p = providers[provider];
    if (!p) throw new Error('Nhà cung cấp không hợp lệ');
    if (!p.clientId) throw codeErr('missing_client', `Thiếu client OAuth cho ${p.name} (src/oauth-clients.local.json)`, { provider: p.name });
    if (cancelers[provider]) cancelers[provider]();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(32));
    const redirectUri = `http://localhost:${p.port}${p.callbackPath}`;

    const code = await waitForCode(provider, p, state, () => {
      const url = new URL(p.authorizeUrl);
      const params = {
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: redirectUri,
        scope: p.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        ...p.extraAuth,
      };
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (onUrl) onUrl(url.toString());
      if (open) openUrl(url.toString());
    });

    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: p.clientId,
      code_verifier: verifier,
    };
    if (p.tokenFallbackFormat) body.state = state;
    if (p.clientSecret) body.client_secret = p.clientSecret;
    const data = await postToken(p, body);
    const tokens = { provider, ...toTokens(p, data, null) };
    if (p.userinfoUrl && !tokens.email) {
      try {
        const r = await fetchImpl(p.userinfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        if (r.ok) { const u = await r.json(); tokens.email = u.email || null; }
      } catch (_) { /* email chỉ để hiển thị */ }
    }
    return tokens;
  }

  function cancelLogin(provider) {
    if (cancelers[provider]) cancelers[provider]();
  }

  function saveTokens(id, tokens) {
    const all = storage.load();
    all[id] = tokens;
    storage.save(all);
  }

  function hasTokens(id) {
    return !!storage.load()[id];
  }

  async function getTokens(id, { force = false } = {}) {
    const all = storage.load();
    let t = all[id];
    if (!t) throw new AuthRequired();
    const p = providers[t.provider];
    if (!p) throw new AuthRequired();
    if (force || t.expires_at - 60000 < Date.now()) {
      if (!t.refresh_token) throw new AuthRequired('Phiên hết hạn');
      try {
        const params = { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: p.clientId };
        if (p.clientSecret) params.client_secret = p.clientSecret;
        const data = await postToken(p, params);
        t = { ...t, ...toTokens(p, data, t) };
        const latest = storage.load();
        latest[id] = t;
        storage.save(latest);
      } catch (e) {
        if (e.status === 400 || e.status === 401 || e.status === 403) {
          const latest = storage.load();
          delete latest[id];
          storage.save(latest);
          throw new AuthRequired('Phiên hết hạn');
        }
        throw e;
      }
    }
    return t;
  }

  function logout(id) {
    const all = storage.load();
    delete all[id];
    storage.save(all);
  }

  // Ghi thêm trường vào token đã lưu (vd. project id của Gemini) mà không đụng tài khoản khác.
  function patchTokens(id, patch) {
    const all = storage.load();
    if (!all[id]) return;
    all[id] = { ...all[id], ...patch };
    storage.save(all);
  }

  return { login, cancelLogin, saveTokens, hasTokens, getTokens, patchTokens, logout };
}

module.exports = { createOAuth, AuthRequired, PROVIDERS, parseJwt };
