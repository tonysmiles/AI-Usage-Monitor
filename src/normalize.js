// Chuẩn hoá dữ liệu thô của claude.ai và chatgpt.com về một dạng chung:
// { plan, windows: [{ id, label, kind, hours, name, percent, resetsAt (ms) | null }] }
// kind: '5h' | 'week' | 'extra' | 'other'; name: tên model/tính năng riêng (nếu có).

function pct(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function normalizeClaude(raw) {
  const defs = [
    ['five_hour', 'Phiên 5 giờ', '5h', null],
    ['seven_day', 'Tuần · tất cả model', 'week', null],
    ['seven_day_sonnet', 'Tuần · Sonnet', 'week', 'Sonnet'],
    ['seven_day_opus', 'Tuần · Opus', 'week', 'Opus'],
    ['seven_day_oauth_apps', 'Tuần · ứng dụng OAuth', 'week', 'OAuth'],
  ];
  const windows = [];
  for (const [key, label, kind, name] of defs) {
    const w = raw && raw[key];
    if (w && typeof w.utilization === 'number') {
      windows.push({
        id: key,
        label,
        kind,
        hours: kind === '5h' ? 5 : 168,
        name,
        percent: pct(w.utilization),
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      });
    }
  }
  const e = raw && raw.extra_usage;
  if (e && e.is_enabled && typeof e.utilization === 'number') {
    windows.push({ id: 'extra', label: 'Dùng thêm (extra usage)', kind: 'extra', hours: null, name: null, percent: pct(e.utilization), resetsAt: null });
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

function windowKind(seconds) {
  if (seconds === 18000) return '5h';
  if (seconds === 604800) return 'week';
  return 'other';
}

function windowFrom(name, key, w, now) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = null;
  if (typeof w.reset_at === 'number') resetsAt = w.reset_at * 1000;
  else if (typeof w.reset_after_seconds === 'number') resetsAt = now + w.reset_after_seconds * 1000;
  const base = windowLabel(w.limit_window_seconds);
  return {
    id: name ? `${name}:${key}` : key,
    label: name ? `${name} · ${base}` : base,
    kind: windowKind(w.limit_window_seconds),
    hours: w.limit_window_seconds ? Math.round(w.limit_window_seconds / 3600) : null,
    name: name || null,
    percent: pct(w.used_percent),
    resetsAt,
  };
}

function normalizeChatGPT(raw, now = Date.now()) {
  const windows = [];
  const rl = (raw && raw.rate_limit) || {};
  for (const [key, w] of [['primary', rl.primary_window], ['secondary', rl.secondary_window]]) {
    const item = windowFrom(null, key, w, now);
    if (item) windows.push(item);
  }
  const extras = raw && Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : [];
  for (const ex of extras) {
    const name = ex.limit_name || ex.metered_feature || 'Khác';
    const r = ex.rate_limit || {};
    for (const [key, w] of [['primary', r.primary_window], ['secondary', r.secondary_window]]) {
      const item = windowFrom(name, key, w, now);
      if (item) windows.push(item);
    }
  }
  return { plan: raw && raw.plan_type ? String(raw.plan_type) : null, windows };
}

// So sánh hai lần đọc để tìm sự kiện: reset (số đã về lại) và vượt ngưỡng.
function diffEvents(prevWindows, nextWindows, threshold = 70) {
  const events = [];
  if (!Array.isArray(prevWindows) || !Array.isArray(nextWindows)) return events;
  const prev = new Map(prevWindows.map((w) => [w.id, w]));
  for (const w of nextWindows) {
    const p = prev.get(w.id);
    if (!p || p.percent == null || w.percent == null) continue;
    const movedWindow = p.resetsAt && w.resetsAt && w.resetsAt - p.resetsAt > 60000;
    const dropped = p.percent - w.percent >= 5 || (p.percent > 0 && w.percent === 0);
    if (dropped && (movedWindow || (p.resetsAt && p.resetsAt <= Date.now()) || p.percent - w.percent >= 20)) {
      events.push({ type: 'reset', id: w.id, kind: w.kind, from: p.percent, to: w.percent });
    } else if (p.percent < threshold && w.percent >= threshold) {
      events.push({ type: 'threshold', id: w.id, kind: w.kind, percent: w.percent });
    }
  }
  return events;
}

module.exports = { normalizeClaude, normalizeChatGPT, windowLabel, diffEvents };
