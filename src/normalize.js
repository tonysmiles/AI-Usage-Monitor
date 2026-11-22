// Chuẩn hoá dữ liệu thô của claude.ai và chatgpt.com về một dạng chung:
// { plan, windows: [{ id, label, percent, resetsAt (ms) | null }] }

function pct(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function normalizeClaude(raw) {
  const defs = [
    ['five_hour', 'Phiên 5 giờ'],
    ['seven_day', 'Tuần · tất cả model'],
    ['seven_day_sonnet', 'Tuần · Sonnet'],
    ['seven_day_opus', 'Tuần · Opus'],
    ['seven_day_oauth_apps', 'Tuần · ứng dụng OAuth'],
  ];
  const windows = [];
  for (const [key, label] of defs) {
    const w = raw && raw[key];
    if (w && typeof w.utilization === 'number') {
      windows.push({
        id: key,
        label,
        percent: pct(w.utilization),
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      });
    }
  }
  const e = raw && raw.extra_usage;
  if (e && e.is_enabled && typeof e.utilization === 'number') {
    windows.push({ id: 'extra', label: 'Dùng thêm (extra usage)', percent: pct(e.utilization), resetsAt: null });
  }
  return { windows };
}

function windowLabel(seconds) {
  if (!seconds) return 'Giới hạn';
  if (seconds === 18000) return 'Phiên 5 giờ';
  if (seconds === 604800) return 'Tuần';
  const hours = seconds / 3600;
  if (hours < 48) return `${Math.round(hours)} giờ`;
  return `${Math.round(seconds / 86400)} ngày`;
}

function windowFrom(prefix, key, w, now) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = null;
  if (typeof w.reset_at === 'number') resetsAt = w.reset_at * 1000;
  else if (typeof w.reset_after_seconds === 'number') resetsAt = now + w.reset_after_seconds * 1000;
  const base = windowLabel(w.limit_window_seconds);
  return {
    id: `${prefix}${key}`,
    label: prefix ? `${prefix.replace(/:$/, '')} · ${base}` : base,
    percent: pct(w.used_percent),
    resetsAt,
  };
}

function normalizeChatGPT(raw, now = Date.now()) {
  const windows = [];
  const rl = (raw && raw.rate_limit) || {};
  for (const [key, w] of [['primary', rl.primary_window], ['secondary', rl.secondary_window]]) {
    const item = windowFrom('', key, w, now);
    if (item) windows.push(item);
  }
  const extras = raw && Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : [];
  for (const ex of extras) {
    const name = ex.limit_name || ex.metered_feature || 'Khác';
    const r = ex.rate_limit || {};
    for (const [key, w] of [['primary', r.primary_window], ['secondary', r.secondary_window]]) {
      const item = windowFrom(`${name}:`, key, w, now);
      if (item) windows.push(item);
    }
  }
  return { plan: raw && raw.plan_type ? String(raw.plan_type) : null, windows };
}

module.exports = { normalizeClaude, normalizeChatGPT, windowLabel };
