const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createOAuth, AuthRequired } = require('../src/oauth');
const { fetchClaude, fetchChatGPT } = require('../src/usage');
const { migrate, findDuplicate, displayName, newId } = require('../src/accounts');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `x.${b64url(Buffer.from(JSON.stringify(claims)))}.y`;

async function main() {
  // --- Máy chủ token giả ---
  let challengeSeen = null;
  let revoke = false;
  let refreshCount = 0;
  let nextEmail = 'a@b.c';
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
          id_token: jwt({ email: nextEmail, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-9', chatgpt_subscription_active_until: '2026-12-09T00:00:00Z' } }),
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
    challengeSeen = u.searchParams.get('code_challenge');
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'abc');
    cb.searchParams.set('state', badState ? 'sai' : u.searchParams.get('state'));
    setTimeout(() => http.get(cb.toString(), (r) => r.resume()), 20);
  };
  const oauth = createOAuth({ openUrl, storage, providers, loginTimeoutMs: 2000 });

  // 1. Đăng nhập trả token kèm provider, báo link qua onUrl, không tự lưu
  let urlSeen = null;
  const t1 = await oauth.login('claude', { onUrl: (u) => { urlSeen = u; } });
  assert.ok(urlSeen && urlSeen.startsWith('http://x/authorize'));
  assert.strictEqual(t1.provider, 'claude');
  assert.strictEqual(t1.email, 'claude@x.y');
  assert.deepStrictEqual(store, {});

  // 2. Hai tài khoản ChatGPT lưu song song theo id
  const g1 = await oauth.login('chatgpt');
  assert.strictEqual(g1.account_id, 'acc-9');
  assert.strictEqual(g1.subscription_until, '2026-12-09T00:00:00Z');
  nextEmail = 'second@b.c';
  const g2 = await oauth.login('chatgpt');
  assert.strictEqual(g2.email, 'second@b.c');
  oauth.saveTokens('chatgpt-1', g1);
  oauth.saveTokens('chatgpt-2', g2);
  oauth.saveTokens('claude-1', t1);
  assert.deepStrictEqual(Object.keys(store).sort(), ['chatgpt-1', 'chatgpt-2', 'claude-1']);
  assert.ok(oauth.hasTokens('chatgpt-2'));

  // 3. Sai state bị từ chối
  badState = true;
  await assert.rejects(() => oauth.login('claude'), (e) => e.code === 'bad_state');
  badState = false;

  // 4. Refresh theo id, dùng đúng provider, không đụng tài khoản khác
  store['claude-1'].expires_at = Date.now() - 1000;
  const t3 = await oauth.getTokens('claude-1');
  assert.strictEqual(t3.access_token, 'at2');
  assert.strictEqual(t3.provider, 'claude');
  assert.strictEqual(t3.refresh_token, 'rt1');
  assert.strictEqual(store['chatgpt-1'].access_token, 'at1');

  // 5. Refresh bị thu hồi -> AuthRequired, chỉ xoá token của tài khoản đó
  revoke = true;
  store['chatgpt-2'].expires_at = Date.now() - 1000;
  await assert.rejects(() => oauth.getTokens('chatgpt-2'), (e) => e instanceof AuthRequired);
  assert.strictEqual(store['chatgpt-2'], undefined);
  assert.ok(store['chatgpt-1']);
  revoke = false;

  // 6. Huỷ đăng nhập
  const oauth2 = createOAuth({ openUrl: () => {}, storage, providers, loginTimeoutMs: 5000 });
  const p2 = oauth2.login('chatgpt');
  setTimeout(() => oauth2.cancelLogin('chatgpt'), 50);
  await assert.rejects(() => p2, (e) => e.code === 'cancelled');

  // 7. Xoá một tài khoản
  oauth.logout('chatgpt-1');
  assert.strictEqual(store['chatgpt-1'], undefined);

  // --- usage.js với fetch giả, theo id ---
  refreshCount = 0;
  store = { 'claude-a': { provider: 'claude', access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 1e6, email: null } };
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push([url, opt.headers.Authorization]);
    if (url.endsWith('/profile')) return { ok: true, status: 200, json: async () => ({ account: { email: 'p@q.r' }, organization: { organization_type: 'claude_max' } }) };
    if (opt.headers.Authorization === 'Bearer old') return { ok: false, status: 401 };
    if (url === 'https://api.anthropic.com/api/oauth/usage') return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10, resets_at: '2026-11-21T16:00:00Z' } }) };
  };
  const cu = await fetchClaude(oauth, 'claude-a', fakeFetch);
  assert.strictEqual(cu.plan, 'max');
  assert.strictEqual(cu.account, 'p@q.r');
  assert.ok(calls.some(([u, a]) => u.includes('organizations/me') && a === 'Bearer at2'));

  store = { 'gpt-a': { provider: 'chatgpt', access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 1e6, account_id: 'acc-1', email: 'e@f.g', subscription_until: '2026-12-09T00:00:00Z' } };
  let seen = null;
  const gu = await fetchChatGPT(oauth, 'gpt-a', async (url, opt) => {
    seen = opt.headers;
    return { ok: true, status: 200, json: async () => ({ plan_type: 'plus', rate_limit: {} }) };
  });
  assert.strictEqual(seen['ChatGPT-Account-ID'], 'acc-1');
  assert.strictEqual(gu.renewal, Date.parse('2026-12-09T00:00:00Z'));
  await assert.rejects(() => fetchChatGPT(oauth, 'gpt-a', async () => ({ ok: false, status: 401 })), (e) => e instanceof AuthRequired);
  await assert.rejects(() => fetchChatGPT(oauth, 'khong-co', async () => ({ ok: true })), (e) => e instanceof AuthRequired);

  // --- accounts.js ---
  // Chuyển dữ liệu bản cũ
  const old = { claude: { access_token: 'x', email: 'me@x.y' }, chatgpt: { access_token: 'y', email: 'me@g.c', account_id: 'w1' } };
  const m = migrate(old, []);
  assert.ok(m.changed);
  assert.strictEqual(m.tokens.claude.provider, 'claude');
  assert.deepStrictEqual(m.accounts.map((a) => `${a.id}/${a.provider}/${a.email}`), ['claude/claude/me@x.y', 'chatgpt/chatgpt/me@g.c']);
  assert.strictEqual(migrate(m.tokens, m.accounts).changed, false);

  // Gộp trùng: cùng email; ChatGPT phân biệt theo workspace
  const accs = [
    { id: 'a', provider: 'claude', email: 'Me@X.y' },
    { id: 'b', provider: 'chatgpt', email: 'me@g.c', workspace: 'w1' },
  ];
  assert.strictEqual(findDuplicate(accs, 'claude', 'me@x.y').id, 'a');
  assert.strictEqual(findDuplicate(accs, 'chatgpt', 'me@g.c', 'w1').id, 'b');
  assert.strictEqual(findDuplicate(accs, 'chatgpt', 'me@g.c', 'w2'), null);
  assert.strictEqual(findDuplicate(accs, 'chatgpt', 'other@g.c', 'w1'), null);
  assert.strictEqual(findDuplicate(accs, 'claude', null), null);

  // Tên hiển thị
  const list = [
    { id: '1', provider: 'claude', label: 'Công ty', email: 'x@y.z' },
    { id: '2', provider: 'claude', email: 'andy.nguyen.very.long.name@y.z' },
    { id: '3', provider: 'claude' },
    { id: '4', provider: 'chatgpt' },
  ];
  assert.strictEqual(displayName(list[0], list), 'Công ty');
  assert.strictEqual(displayName(list[1], list), 'andy.nguyen.ver…');
  assert.strictEqual(displayName(list[2], list), '#3');
  assert.strictEqual(displayName(list[3], list), '');
  assert.match(newId('claude'), /^claude-[0-9a-f]{8}$/);

  tokenServer.close();
  console.log('oauth + usage + accounts: tất cả test đạt');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
