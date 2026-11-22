const PROVIDER_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const BADGE = { claude: 'CL', chatgpt: 'GPT', gemini: 'GEM' };
const PROVIDERS = Object.keys(PROVIDER_NAMES);
const THRESHOLD = 70;
const DAY = 86400000;

const L = {
  vi: {
    days: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'],
    week: 'Tuần', extra: 'Extra', limit: 'Giới hạn',
    hide: 'Ẩn xuống khay', addTip: 'Thêm tài khoản', compactTip: 'Thu gọn / mở rộng',
    addTitle: 'Thêm tài khoản', noAccounts: 'Chưa có tài khoản nào. Thêm một tài khoản để bắt đầu.',
    addHint: 'Claude/ChatGPT dùng tài khoản đang đăng nhập trên trình duyệt: muốn thêm tài khoản khác thì đổi tài khoản trước, hoặc "Sao chép link" rồi dán vào cửa sổ ẩn danh. Gemini sẽ cho chọn tài khoản Google.',
    waiting: (n) => `${n}: chờ cho phép trên trình duyệt…`,
    reloginWaiting: (n) => `${n}: đang đăng nhập lại…`,
    copyLink: 'Sao chép link', copied: 'Đã chép', cancel: 'Huỷ',
    notLogged: 'Cần đăng nhập lại', login: 'Đăng nhập', retry: 'Thử lại',
    loading: 'Đang tải…', stale: 'mất kết nối', unknown: 'Lỗi không rõ',
    resetNow: 'Reset!',
    tipReset: (when, tz, left) => `Reset ${when} (${tz}) · ${left}`,
    left: (d, h, m) => (d > 0 ? `còn ${d} ngày ${h} giờ` : h > 0 ? `còn ${h} giờ ${m} phút` : `còn ${m} phút`),
    resetPending: 'sắp reset',
    renew: 'Gia hạn', renewToday: 'Gia hạn hôm nay',
    renewIn: (n) => `còn ${n} ngày`,
    renewSet: '+ Đặt ngày gia hạn', renewManual: 'tự nhập', renewTip: 'Bấm để sửa ngày gia hạn',
    save: 'Lưu', clear: 'Xoá',
    menu: 'Tuỳ chọn', rename: 'Đổi tên', relogin: 'Đăng nhập lại', remove: 'Xoá', confirm: 'Chắc chưa?',
    up: 'Lên', down: 'Xuống', namePh: 'Tên gợi nhớ',
  },
  en: {
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    week: 'Week', extra: 'Extra', limit: 'Limit',
    hide: 'Hide to tray', addTip: 'Add account', compactTip: 'Compact / expand',
    addTitle: 'Add account', noAccounts: 'No accounts yet. Add one to get started.',
    addHint: 'Claude/ChatGPT use the account signed in to your browser: switch accounts first, or "Copy link" into a private window. Gemini lets you pick a Google account.',
    waiting: (n) => `${n}: waiting for browser approval…`,
    reloginWaiting: (n) => `${n}: signing in again…`,
    copyLink: 'Copy link', copied: 'Copied', cancel: 'Cancel',
    notLogged: 'Sign-in required', login: 'Sign in', retry: 'Retry',
    loading: 'Loading…', stale: 'offline', unknown: 'Unknown error',
    resetNow: 'Reset!',
    tipReset: (when, tz, left) => `Resets ${when} (${tz}) · ${left}`,
    left: (d, h, m) => (d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`),
    resetPending: 'resetting soon',
    renew: 'Renews', renewToday: 'Renews today',
    renewIn: (n) => (n === 1 ? 'in 1 day' : `in ${n} days`),
    renewSet: '+ Set renewal date', renewManual: 'manual', renewTip: 'Click to edit the renewal date',
    save: 'Save', clear: 'Clear',
    menu: 'Options', rename: 'Rename', relogin: 'Sign in again', remove: 'Remove', confirm: 'Sure?',
    up: 'Up', down: 'Down', namePh: 'Nickname',
  },
};

let current = null;
let lang = 'vi';
let addOpen = false;
let menuOpen = null;         // id tài khoản đang mở menu
let confirmRemove = null;    // id đang chờ xác nhận xoá
let renaming = null;         // id đang đổi tên
const editingRenewal = new Set();
const expanded = new Set();  // tài khoản mở rộng khi đang ở chế độ thu gọn
const fx = new Map();        // "account:window" -> { type, start, dur }
const t = () => L[lang] || L.vi;
const pad = (n) => String(n).padStart(2, '0');
const busy = () => editingRenewal.size > 0 || renaming !== null;

// ---------- Định dạng ----------
function shortLabel(w) {
  if (w.kind === 'extra') return t().extra;
  if (w.name) return w.kind === '5h' ? `${w.name} 5h` : w.name;
  if (w.kind === '5h') return '5h';
  if (w.kind === 'week') return t().week;
  return w.hours ? `${w.hours}h` : t().limit;
}

function longLabel(w) {
  if (lang === 'vi') return w.label;
  const base = w.kind === '5h' ? '5-hour session' : w.kind === 'week' ? 'Weekly' : w.kind === 'extra' ? 'Extra usage' : (w.hours ? `${w.hours}-hour` : 'Limit');
  return w.name ? `${w.name} · ${base}` : base;
}

function tzName() {
  const off = -new Date().getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${off >= 0 ? '+' : '-'}${h}${m ? `:${pad(m)}` : ''}`;
}

function dateShort(d) {
  return lang === 'en' ? `${d.getMonth() + 1}/${d.getDate()}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function resetClock(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (ms - now.getTime() < 6 * DAY) return `${t().days[d.getDay()]} ${hm}`;
  return `${t().days[d.getDay()]} ${dateShort(d)}`;
}

function resetTooltip(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const diff = ms - Date.now();
  let left = t().resetPending;
  if (diff > 0) {
    const mins = Math.ceil(diff / 60000);
    left = t().left(Math.floor(mins / 1440), Math.floor((mins % 1440) / 60), mins % 60);
  }
  return t().tipReset(`${t().days[d.getDay()]} ${dateShort(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, tzName(), left);
}

function level(p) {
  if (p >= 90) return 'bad';
  if (p >= THRESHOLD) return 'warn';
  return '';
}

const fullName = (a) => (a.shortName ? `${PROVIDER_NAMES[a.provider]} · ${a.shortName}` : PROVIDER_NAMES[a.provider]);

// ---------- DOM ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function btn(text, cls, onClick, title) {
  const b = el('button', cls || '', text);
  b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  if (title) b.title = title;
  return b;
}

function message(text, isErr, ...buttons) {
  const m = el('div', 'msg');
  const span = el('span', isErr ? 'err' : '', text);
  span.title = text;
  m.append(span, ...buttons.filter(Boolean));
  return m;
}

// Giữ hiệu ứng chạy liền mạch dù DOM được dựng lại.
function applyFx(node, key) {
  const f = fx.get(key);
  if (!f) return null;
  const elapsed = Date.now() - f.start;
  if (elapsed > f.dur) { fx.delete(key); return null; }
  node.classList.add(`fx-${f.type}`);
  node.style.setProperty('--fx-delay', `-${elapsed}ms`);
  return f;
}

function renderRow(a, w) {
  const key = `${a.id}:${w.id}`;
  const lv = level(w.percent);
  const row = el('div', `row${lv ? ` hot ${lv}` : ''}`);
  row.title = `${longLabel(w)}: ${Math.round(w.percent)}%${w.resetsAt ? `\n${resetTooltip(w.resetsAt)}` : ''}`;
  const bar = el('div', 'bar');
  const fill = el('i', lv);
  fill.style.width = `${w.percent}%`;
  bar.append(fill);
  const f = applyFx(row, key);
  const reset = el('span', 'reset', f && f.type === 'reset' ? t().resetNow : resetClock(w.resetsAt));
  row.append(el('span', 'label', shortLabel(w)), bar, el('span', 'pct', `${Math.round(w.percent)}%`), reset);
  if (f && f.type === 'reset') {
    const burst = el('span', 'burst');
    for (let i = 0; i < 8; i++) burst.append(el('b'));
    row.append(burst);
  }
  return row;
}

function renderRenewal(a) {
  const box = el('div', 'renew');
  if (editingRenewal.has(a.id)) {
    box.classList.add('editing');
    const input = el('input');
    input.type = 'date';
    if (a.renewal && a.renewal.at) {
      const d = new Date(a.renewal.at);
      input.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const done = (v) => { editingRenewal.delete(a.id); window.api.setRenewal(a.id, v); render(current); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value || null);
      if (e.key === 'Escape') { editingRenewal.delete(a.id); render(current); }
    };
    box.append(input, btn(t().save, '', () => done(input.value || null)), btn(t().clear, 'ghost', () => done(null)));
    setTimeout(() => { window.api.focus(); input.focus(); }, 0);
    return box;
  }
  box.title = t().renewTip;
  box.onclick = () => { editingRenewal.add(a.id); render(current); };
  const r = a.renewal;
  if (!r || !r.at) {
    box.classList.add('empty');
    box.textContent = t().renewSet;
    return box;
  }
  const d = new Date(r.at);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const days = Math.round((day - start) / DAY);
  if (days <= 3) box.classList.add('soon');
  box.append(el('span', 'ico', '↻'));
  box.append(el('span', '', days <= 0 ? t().renewToday : `${t().renew} ${t().days[d.getDay()]} ${dateShort(d)}`));
  if (days > 0) box.append(el('span', 'left', `· ${t().renewIn(days)}`));
  if (r.source === 'manual') box.append(el('span', 'tag', t().renewManual));
  return box;
}

function renderMenu(a, index, total) {
  const m = el('div', 'acts');
  m.append(
    btn(t().rename, 'ghost', () => { renaming = a.id; menuOpen = null; render(current); }),
    btn('↑', 'ghost icon', () => window.api.move(a.id, -1), t().up),
    btn('↓', 'ghost icon', () => window.api.move(a.id, 1), t().down),
    btn(t().relogin, 'ghost', () => { menuOpen = null; window.api.relogin(a.id); }),
    confirmRemove === a.id
      ? btn(t().confirm, 'danger', () => { confirmRemove = null; menuOpen = null; window.api.remove(a.id); })
      : btn(t().remove, 'ghost danger-text', () => { confirmRemove = a.id; render(current); }),
  );
  if (index === 0) m.children[1].disabled = true;
  if (index === total - 1) m.children[2].disabled = true;
  return m;
}

function renderHead(a) {
  const head = el('div', 'head');
  if (renaming === a.id) {
    head.classList.add('renaming');
    head.append(el('span', 'name', PROVIDER_NAMES[a.provider]));
    const input = el('input');
    input.placeholder = a.email ? a.email.split('@')[0] : t().namePh;
    input.value = a.label || '';
    input.maxLength = 24;
    const done = (save) => { renaming = null; if (save) window.api.rename(a.id, input.value); render(current); };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    head.append(input, btn(t().save, '', () => done(true)));
    setTimeout(() => { window.api.focus(); input.focus(); input.select(); }, 0);
    return head;
  }
  head.append(el('span', 'name', PROVIDER_NAMES[a.provider]));
  if (a.shortName) head.append(el('span', 'who', a.shortName));
  if (a.plan) head.append(el('span', 'plan', String(a.plan).replace(/^Google\s+/i, '')));
  if (a.stale) head.append(el('span', 'stale', t().stale));
  head.title = a.email || '';
  const more = btn('⋯', `more${menuOpen === a.id ? ' on' : ''}`, () => {
    menuOpen = menuOpen === a.id ? null : a.id;
    confirmRemove = null;
    render(current);
  }, t().menu);
  head.append(more);
  return head;
}

function renderBody(card, a) {
  if (a.status === 'ok') {
    for (const w of a.windows) card.append(renderRow(a, w));
  } else if (a.status === 'login') {
    card.append(message(t().notLogged, false, btn(t().login, '', () => window.api.relogin(a.id))));
  } else if (a.status === 'error') {
    card.append(message(a.message || t().unknown, true, btn(t().retry, '', () => window.api.relogin(a.id))));
  } else {
    card.append(message(t().loading, false));
  }
  if (a.status === 'ok' || a.renewal) card.append(renderRenewal(a));
}

function renderCompact(a) {
  const card = el('div', 'card compact');
  card.dataset.provider = a.provider;
  card.onclick = () => { expanded.add(a.id); render(current); };
  const row = el('div', `crow${a.status === 'ok' && a.windows.length ? '' : ' msgrow'}`);
  row.append(el('span', `badge ${a.provider}`, BADGE[a.provider] || '?'));
  const name = el('span', 'cname', a.shortName || PROVIDER_NAMES[a.provider]);
  name.title = `${fullName(a)}${a.email ? `\n${a.email}` : ''}`;
  row.append(name);
  if (a.status === 'ok' && a.windows.length) {
    const top = a.windows.reduce((m, w) => (w.percent > m.percent ? w : m), a.windows[0]);
    const nearest = a.windows.filter((w) => w.resetsAt).sort((x, y) => x.resetsAt - y.resetsAt)[0];
    const lv = level(top.percent);
    const bar = el('div', `bar${lv ? ` ${lv}` : ''}`);
    const fill = el('i', lv);
    fill.style.width = `${top.percent}%`;
    bar.append(fill);
    const pct = el('span', `pct${lv ? ` ${lv}` : ''}`, `${Math.round(top.percent)}%`);
    pct.title = a.windows.map((w) => `${shortLabel(w)}: ${Math.round(w.percent)}%`).join('\n');
    const rs = el('span', 'reset', nearest ? resetClock(nearest.resetsAt) : '');
    if (nearest) rs.title = resetTooltip(nearest.resetsAt);
    row.append(bar, pct, rs);
    if (lv) card.classList.add('hot', lv);
    if (a.windows.some((w) => fx.has(`${a.id}:${w.id}`))) {
      const f = a.windows.map((w) => fx.get(`${a.id}:${w.id}`)).find(Boolean);
      if (f && Date.now() - f.start < f.dur) {
        card.classList.add(`fx-${f.type}`);
        card.style.setProperty('--fx-delay', `-${Date.now() - f.start}ms`);
      }
    }
  } else {
    const msg = a.status === 'login' ? t().notLogged : a.status === 'error' ? (a.message || t().unknown) : t().loading;
    const s = el('span', `cmsg${a.status === 'error' ? ' err' : ''}`, msg);
    s.title = msg;
    row.append(s);
    if (a.status === 'login' || a.status === 'error') row.append(btn(a.status === 'login' ? t().login : t().retry, 'mini', () => window.api.relogin(a.id)));
  }
  card.append(row);
  return card;
}

function renderCard(a, index, total) {
  if (current.compact && !expanded.has(a.id) && menuOpen !== a.id && renaming !== a.id && !editingRenewal.has(a.id)) {
    return renderCompact(a);
  }
  const card = el('div', 'card');
  card.dataset.provider = a.provider;
  card.append(renderHead(a));
  if (menuOpen === a.id) card.append(renderMenu(a, index, total));
  renderBody(card, a);
  if (a.status === 'ok' && a.windows.some((w) => w.percent >= THRESHOLD)) card.classList.add('hot');
  if (current.compact) {
    const fold = btn('︿', 'fold', () => { expanded.delete(a.id); menuOpen = null; render(current); });
    card.append(fold);
  }
  return card;
}

function renderAdd() {
  const box = el('div', 'add');
  const noAcc = !current.accounts.length;
  box.append(el('div', 'add-title', noAcc ? t().noAccounts : t().addTitle));
  const row = el('div', 'add-row');
  for (const p of PROVIDERS) {
    const b = btn(PROVIDER_NAMES[p], `prov ${p}`, () => { addOpen = false; window.api.add(p); });
    b.disabled = !!(current.pending && current.pending[p]);
    row.append(b);
  }
  box.append(row, el('div', 'hint', t().addHint));
  return box;
}

function renderPending(p, info) {
  const name = PROVIDER_NAMES[p];
  const target = info.target && current.accounts.find((a) => a.id === info.target);
  const text = target ? t().reloginWaiting(fullName(target)) : t().waiting(name);
  const copy = btn(t().copyLink, 'ghost', async (e) => {
    const ok = await window.api.copyLoginLink(p);
    if (ok) { e.target.textContent = t().copied; setTimeout(() => { e.target.textContent = t().copyLink; }, 1500); }
  });
  const m = message(text, false, copy, btn(t().cancel, 'ghost', () => window.api.cancelLogin(p)));
  m.classList.add('pending');
  return m;
}

function render(state) {
  current = state;
  lang = state.lang || 'vi';
  document.documentElement.lang = lang;
  document.getElementById('btn-hide').title = t().hide;
  document.getElementById('btn-add').title = t().addTip;
  document.getElementById('btn-add').classList.toggle('on', addOpen);
  const cb = document.getElementById('btn-compact');
  cb.title = t().compactTip;
  cb.classList.toggle('on', !!state.compact);
  cb.style.display = state.accounts.length ? '' : 'none';
  document.getElementById('updated').textContent = state.updatedAt ? `${resetClock(state.updatedAt)} · ${tzName()}` : '…';

  if (menuOpen && !state.accounts.some((a) => a.id === menuOpen)) menuOpen = null;
  const parts = [];
  if (addOpen || !state.accounts.length) parts.push(renderAdd());
  for (const p of PROVIDERS) if (state.pending && state.pending[p]) parts.push(renderPending(p, state.pending[p]));
  if (state.addError) {
    const e = message(`${PROVIDER_NAMES[state.addError.provider]}: ${state.addError.message}`, true, btn('×', 'ghost icon', () => window.api.dismissError()));
    e.classList.add('adderr');
    parts.push(e);
  }
  state.accounts.forEach((a, i) => parts.push(renderCard(a, i, state.accounts.length)));

  const scroll = document.getElementById('scroll');
  const keep = scroll.scrollTop;
  scroll.style.maxHeight = `${Math.max(200, window.screen.availHeight - 60)}px`;
  scroll.replaceChildren(...parts);
  scroll.scrollTop = keep;
  scroll.classList.toggle('scrolls', scroll.scrollHeight > scroll.clientHeight + 1);
  requestAnimationFrame(() => window.api.fit(document.getElementById('box').getBoundingClientRect().height + 6));
}

// ---------- Sự kiện ----------
window.api.onEvents((events) => {
  const now = Date.now();
  for (const ev of events) {
    fx.set(`${ev.account}:${ev.id}`, { type: ev.type === 'reset' ? 'reset' : 'alert', start: now, dur: ev.type === 'reset' ? 6000 : 4000 });
  }
  if (current && !busy()) render(current);
  setTimeout(() => { if (current && !busy()) render(current); }, 6100);
});

document.getElementById('btn-hide').onclick = () => window.api.hide();
document.getElementById('btn-add').onclick = () => { addOpen = !addOpen; render(current); };
document.getElementById('btn-compact').onclick = () => { expanded.clear(); window.api.setCompact(!current.compact); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (menuOpen || addOpen)) { menuOpen = null; addOpen = false; confirmRemove = null; render(current); }
});

window.api.onState((s) => { if (!busy()) render(s); else current = s; });
window.api.getState().then(render);

// Cập nhật giờ mỗi 30 giây mà không gọi mạng (bỏ qua khi đang nhập liệu).
setInterval(() => { if (current && !busy()) render(current); }, 30000);
