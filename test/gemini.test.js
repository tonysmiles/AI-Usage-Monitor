const assert = require('assert');
const { normalizeGemini } = require('../src/normalize');
const { fetchGemini, projectIdOf, tierName } = require('../src/usage');
const { AuthRequired } = require('../src/oauth');

async function main() {
  // --- normalizeGemini ---
  const raw = {
    groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.2725, resetTime: '2026-11-25T00:00:00Z' },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.9302, resetTime: '2026-11-22T12:00:00Z' },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', resetTime: '2026-11-26T00:00:00Z' }, // hết quota: trường bị bỏ
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 1, disabled: true },
      ] },
    ],
  };
  const g = normalizeGemini(raw);
  assert.deepStrictEqual(g.windows.map((w) => w.id), ['gemini-5h', 'gemini-weekly', '3p-weekly']);
  assert.strictEqual(Math.round(g.windows[0].percent * 100) / 100, 6.98);
  assert.strictEqual(g.windows[0].kind, '5h');
  assert.strictEqual(Math.round(g.windows[1].percent * 100) / 100, 72.75);
  assert.strictEqual(g.windows[1].kind, 'week');
  assert.strictEqual(g.windows[2].percent, 100);
  assert.strictEqual(g.windows[2].name, 'C/GPT');
  assert.strictEqual(g.windows[1].resetsAt, Date.parse('2026-11-25T00:00:00Z'));
  assert.deepStrictEqual(normalizeGemini({}).windows, []);
  assert.deepStrictEqual(normalizeGemini(null).windows, []);

  // --- helpers ---
  assert.strictEqual(projectIdOf({ cloudaicompanionProject: 'p-1' }), 'p-1');
  assert.strictEqual(projectIdOf({ cloudaicompanionProject: { id: 'p-2' } }), 'p-2');
  assert.strictEqual(projectIdOf({}), null);
  assert.strictEqual(tierName({ paidTier: { name: 'Google AI Pro' }, currentTier: { name: 'Free' } }), 'Google AI Pro');
  assert.strictEqual(tierName({ currentTier: { id: 'standard-tier' } }), 'standard-tier');

  // --- fetchGemini với oauth + fetch giả ---
  let tok = { provider: 'gemini', access_token: 'a1', email: 'me@gmail.com' };
  const fakeOauth = {
    getTokens: async (_id, { force } = {}) => { if (force) tok = { ...tok, access_token: 'a2' }; return tok; },
    patchTokens: (_id, p) => { tok = { ...tok, ...p }; },
  };
  const calls = [];
  const f = async (url, opt) => {
    calls.push([url, opt.headers.Authorization, opt.headers['User-Agent'], opt.body]);
    const json = (o, s = 200) => ({ ok: s < 400, status: s, text: async () => JSON.stringify(o) });
    if (opt.headers.Authorization === 'Bearer a1') return json({}, 401);
    if (url.startsWith('https://daily-')) return json({ error: 'unavailable' }, 503); // host daily lỗi -> thử host chính
    if (url.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: { id: 'proj-9' }, paidTier: { name: 'Google AI Pro' } });
    if (url.endsWith(':retrieveUserQuotaSummary')) return json(raw);
    return json({}, 404);
  };
  const res = await fetchGemini(fakeOauth, 'gem-1', f);
  assert.strictEqual(res.plan, 'Google AI Pro');
  assert.strictEqual(res.email, 'me@gmail.com');
  assert.strictEqual(tok.gemini_project, 'proj-9');
  const q = calls.find(([u, a]) => u === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary' && a === 'Bearer a2');
  assert.ok(q, 'phải gọi quota ở host chính bằng token mới');
  assert.match(q[2], /^antigravity\/hub\//);
  assert.deepStrictEqual(JSON.parse(q[3]), { project: 'proj-9' });

  // Lần sau đã có project + gói: không gọi loadCodeAssist nữa
  calls.length = 0;
  await fetchGemini(fakeOauth, 'gem-1', f);
  assert.ok(!calls.some(([u]) => u.includes('loadCodeAssist')));

  // Tài khoản không đủ điều kiện
  tok = { provider: 'gemini', access_token: 'a2', email: 'x@y.z' };
  await assert.rejects(
    () => fetchGemini(fakeOauth, 'gem-2', async () => ({ ok: false, status: 403, text: async () => '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SUBSCRIPTION_REQUIRED"}]}}' })),
    (e) => e.code === 'gemini_not_eligible',
  );
  // Không có project
  await assert.rejects(
    () => fetchGemini(fakeOauth, 'gem-3', async () => ({ ok: true, status: 200, text: async () => '{}' })),
    (e) => e.code === 'gemini_no_project',
  );
  // 401 liên tục -> đăng nhập lại
  await assert.rejects(
    () => fetchGemini({ getTokens: async () => ({ access_token: 'z', gemini_project: 'p', plan: 'x' }) }, 'g', async () => ({ ok: false, status: 401, text: async () => '' })),
    (e) => e instanceof AuthRequired,
  );
  console.log('gemini: tất cả test đạt');
}
main().catch((e) => { console.error(e); process.exit(1); });
