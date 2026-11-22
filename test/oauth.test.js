const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createOAuth, AuthRequired } = require('../src/oauth');
const { fetchClaude, fetchChatGPT } = require('../src/usage');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `x.${b64url(Buffer.from(JSON.stringify(claims)))}.y`;

async function main() {
  // --- Máy chủ token giả ---
  let challengeSeen = null;
  let revoke = false;
  let refreshCount = 0;
  const tokenServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = req.headers['content-type'].includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      res.setHeader('Content-Type', 'application/json');
      if (body.grant_type === 'authorization_code') {
        const ok = b64url(crypto.createHash('sha256').update(body.code_verifier).digest()) === challengeSeen && body.code === 'abc';
        if (!ok) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({
          access_token: 'at1', refresh_token: 'rt1', expires_in: 3600,
          id_token: jwt({ email: 'a@b.c', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-9' } }),
          account: { email_address: 'claude@x.y' },
        }));
      } else if (body.grant_type === 'refresh_token') {
        refreshCount++;
        if (revoke) { res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return; }
        res.end(JSON.stringify({ access_token: `at${refreshCount + 1}`, expires_in: 3600 }));
      } else { res.statusCode = 400; res.end('{}'); }
    });
  });
  await new Promise((r) => tokenServer.listen(54700, '127.0.0.1', r));

  const providers = {
    claude: { name: 'Claude', authorizeUrl: 'http://x/authorize', tokenUrl: 'http://127.0.0.1:54700/t', clientId: 'cid', port: 54601, callbackPath: '/callback', scope: 's', tokenFormat: 'json', extraAuth: {} },
    chatgpt: { name: 'ChatGPT', authorizeUrl: 'http://x/authorize', tokenUrl: 'http://127.0.0.1:54700/t', clientId: 'cid2', port: 54602, callbackPath: '/auth/callback', scope: 'openid', tokenFormat: 'form', extraAuth: { codex_cli_simplified_flow: 'true' }, accountFromIdToken: true },
  };

  let store = {};
  const storage = { load: () => JSON.parse(JSON.stringify(store)), save: (o) => { store = JSON.parse(JSON.stringify(o)); } };

  // "Trình duyệt" giả: đọc URL xin quyền rồi gọi lại redirect_uri.
  let badState = false;
  const openUrl = (url) => {
    const u = new URL(url);
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    challengeSeen = u.searchParams.get('code_challenge');
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'abc');
    cb.searchParams.set('state', badState ? 'sai' : u.searchParams.get('state'));
    setTimeout(() => http.get(cb.toString(), (r) => r.resume()), 20);
  };
  const oauth = createOAuth({ openUrl, storage, providers, loginTimeoutMs: 2000 });

  // 1. Đăng nhập Claude
  const t1 = await oauth.login('claude');
  assert.strictEqual(t1.access_token, 'at1');
  assert.strictEqual(t1.email, 'claude@x.y');

  // 2. Đăng nhập ChatGPT: lấy account_id + email từ id_token, có tham số riêng của Codex
  const t2 = await oauth.login('chatgpt');
  assert.strictEqual(t2.account_id, 'acc-9');
  assert.strictEqual(t2.email, 'a@b.c');

  // 3. Sai state bị từ chối
  badState = true;
  await assert.rejects(() => oauth.login('claude'), /state/);
  badState = false;

  // 4. Token còn hạn thì không refresh; hết hạn thì refresh và giữ refresh_token cũ
  assert.strictEqual((await oauth.getTokens('claude')).access_token, 'at1');
  assert.strictEqual(refreshCount, 0);
  store.claude.expires_at = Date.now() - 1000;
  const t3 = await oauth.getTokens('claude');
  assert.strictEqual(t3.access_token, 'at2');
  assert.strictEqual(t3.refresh_token, 'rt1');

  // 5. Refresh bị từ chối -> AuthRequired và xoá token
  revoke = true;
  store.claude.expires_at = Date.now() - 1000;
  await assert.rejects(() => oauth.getTokens('claude'), (e) => e instanceof AuthRequired);
  assert.strictEqual(store.claude, undefined);
  await assert.rejects(() => oauth.getTokens('claude'), (e) => e instanceof AuthRequired);

  // 6. Huỷ đăng nhập
  const pending = oauth.login.call(null, 'claude');
  // không có "trình duyệt" trả lời: openUrl vẫn gọi, nên đổi sang no-op
  const oauth2 = createOAuth({ openUrl: () => {}, storage, providers, loginTimeoutMs: 5000 });
  const p2 = oauth2.login('chatgpt');
  setTimeout(() => oauth2.cancelLogin('chatgpt'), 50);
  await assert.rejects(() => p2, /huỷ/);
  await pending.catch(() => {});

  // 7. Đăng xuất
  store = { chatgpt: { access_token: 'x', expires_at: Date.now() + 1e6 } };
  oauth.logout('chatgpt');
  assert.strictEqual(store.chatgpt, undefined);

  // --- usage.js với fetch giả ---
  // Claude: 404 ở URL đầu thì thử URL sau; 401 thì refresh rồi thử lại
  revoke = false;
  refreshCount = 0;
  store = { claude: { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 1e6, email: null } };
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push([url, opt.headers.Authorization]);
    if (url.endsWith('/profile')) return { ok: true, status: 200, json: async () => ({ account: { email: 'p@q.r' }, organization: { organization_type: 'claude_max' } }) };
    if (opt.headers.Authorization === 'Bearer old') return { ok: false, status: 401 };
    if (url === 'https://api.anthropic.com/api/oauth/usage') return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10, resets_at: '2026-11-21T16:00:00Z' } }) };
  };
  const cu = await fetchClaude(oauth, fakeFetch);
  assert.strictEqual(cu.plan, 'max');
  assert.strictEqual(cu.account, 'p@q.r');
  assert.strictEqual(cu.raw.five_hour.utilization, 10);
  assert.ok(calls.some(([u, a]) => u.includes('organizations/me') && a === 'Bearer at2'));

  // ChatGPT: gửi header account id
  store = { chatgpt: { access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 1e6, account_id: 'acc-1', email: 'e@f.g' } };
  let seen = null;
  const gu = await fetchChatGPT(oauth, async (url, opt) => {
    seen = opt.headers;
    return { ok: true, status: 200, json: async () => ({ plan_type: 'plus', rate_limit: {} }) };
  });
  assert.strictEqual(seen['ChatGPT-Account-ID'], 'acc-1');
  assert.strictEqual(seen.Authorization, 'Bearer tok');
  assert.strictEqual(gu.account, 'e@f.g');

  // 401 liên tục -> AuthRequired
  await assert.rejects(
    () => fetchChatGPT(oauth, async () => ({ ok: false, status: 401 })),
    (e) => e instanceof AuthRequired,
  );

  tokenServer.close();
  console.log('oauth + usage: tất cả test đạt');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
