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
