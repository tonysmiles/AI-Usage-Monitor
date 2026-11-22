const assert = require('assert');
const { normalizeClaude, normalizeChatGPT, windowLabel } = require('../src/normalize');

// Claude
const c = normalizeClaude({
  five_hour: { utilization: 42.5, resets_at: '2026-11-21T16:00:00Z' },
  seven_day: { utilization: 77, resets_at: '2026-11-25T00:00:00Z' },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, utilization: 10 },
});
assert.strictEqual(c.windows.length, 3);
assert.strictEqual(c.windows[0].percent, 42.5);
assert.strictEqual(c.windows[0].resetsAt, Date.parse('2026-11-21T16:00:00Z'));
assert.strictEqual(c.windows[2].id, 'extra');
assert.deepStrictEqual(normalizeClaude(null).windows, []);
assert.strictEqual(normalizeClaude({ five_hour: { utilization: 150 } }).windows[0].percent, 100);

// ChatGPT
const now = 1_000_000;
const g = normalizeChatGPT({
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 2000000000 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 3600 },
  },
  additional_rate_limits: [
    { limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } } },
  ],
}, now);
assert.strictEqual(g.plan, 'plus');
assert.strictEqual(g.windows.length, 3);
assert.strictEqual(g.windows[0].label, 'Phiên 5 giờ');
assert.strictEqual(g.windows[0].resetsAt, 2000000000 * 1000);
assert.strictEqual(g.windows[1].label, 'Tuần');
assert.strictEqual(g.windows[1].resetsAt, now + 3600 * 1000);
assert.strictEqual(g.windows[2].label, 'Spark · Phiên 5 giờ');
assert.deepStrictEqual(normalizeChatGPT({}).windows, []);
assert.strictEqual(windowLabel(86400), '24 giờ');
assert.strictEqual(windowLabel(86400 * 3), '3 ngày');

console.log('normalize: tất cả test đạt');

// diffEvents
const { diffEvents } = require('../src/normalize');
const { findRenewal, toMs } = require('../src/usage');
const T0 = Date.now();
const prevW = [
  { id: 'five_hour', kind: '5h', percent: 88, resetsAt: T0 - 1000 },
  { id: 'seven_day', kind: 'week', percent: 65, resetsAt: T0 + 5 * 86400000 },
  { id: 'opus', kind: 'week', percent: 50, resetsAt: T0 + 86400000 },
];
const nextW = [
  { id: 'five_hour', kind: '5h', percent: 0, resetsAt: T0 + 5 * 3600000 },
  { id: 'seven_day', kind: 'week', percent: 71, resetsAt: T0 + 5 * 86400000 },
  { id: 'opus', kind: 'week', percent: 52, resetsAt: T0 + 86400000 },
];
const ev = diffEvents(prevW, nextW, 70);
assert.deepStrictEqual(ev.map((e) => `${e.type}:${e.id}`), ['reset:five_hour', 'threshold:seven_day']);
// Không phát lại khi vẫn ở trên ngưỡng, và không coi dao động nhỏ là reset
assert.strictEqual(diffEvents(nextW, nextW.map((w) => ({ ...w, percent: w.percent + 1 }))).length, 0);
assert.strictEqual(diffEvents([{ id: 'a', percent: 40, resetsAt: T0 + 1e6 }], [{ id: 'a', percent: 38, resetsAt: T0 + 1e6 }]).length, 0);
// Tuần reset mà không qua đúng giờ (cửa sổ dịch đi) vẫn bắt được
assert.strictEqual(diffEvents([{ id: 'w', percent: 60, resetsAt: T0 + 1000 }], [{ id: 'w', percent: 3, resetsAt: T0 + 7 * 86400000 }])[0].type, 'reset');
assert.strictEqual(diffEvents(null, nextW).length, 0);

// findRenewal / toMs
const future = new Date(T0 + 10 * 86400000).toISOString();
assert.strictEqual(findRenewal({ account: {}, organization: { billing: { current_period_end: future } } }), Date.parse(future));
assert.strictEqual(findRenewal({ organization: { created_at: future } }), null);
assert.strictEqual(toMs(1800000000), 1800000000000);
assert.strictEqual(toMs('bad'), null);
console.log('diffEvents + renewal: tất cả test đạt');
