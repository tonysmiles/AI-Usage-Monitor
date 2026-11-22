const PROVIDERS = [
  { key: 'claude', name: 'Claude' },
  { key: 'chatgpt', name: 'ChatGPT' },
];

let current = null;

function shortLabel(label) {
  return label
    .replace('Tuần · tất cả model', 'Tuần')
    .replace('Tuần · ', '')
    .replace('Dùng thêm (extra usage)', 'Extra')
    .replace(' · Phiên 5 giờ', ' 5h')
    .replace(' · Tuần', ' tuần')
    .replace('Phiên 5 giờ', '5h');
}

const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const pad = (n) => String(n).padStart(2, '0');

// Giờ reset theo múi giờ của máy (Date dùng múi giờ hệ thống).
function resetClock(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (ms - now.getTime() < 6 * 86400000) return `${DAYS[d.getDay()]} ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

function tzName() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

function countdown(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return 'sắp reset';
  const mins = Math.ceil(diff / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `còn ${d} ngày ${h} giờ`;
  if (h > 0) return `còn ${h} giờ ${m} phút`;
  return `còn ${m} phút`;
}

function resetTooltip(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `Reset ${DAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tzName()}) · ${countdown(ms)}`;
}

function level(p) {
  if (p >= 85) return 'bad';
  if (p >= 60) return 'warn';
  return '';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function message(text, isErr, btnText, onClick, ghost) {
  const m = el('div', 'msg');
  const span = el('span', isErr ? 'err' : '', text);
  span.title = text;
  m.append(span);
  if (btnText) {
    const b = el('button', ghost ? 'ghost' : '', btnText);
    b.onclick = onClick;
    m.append(b);
  }
  return m;
}

function renderCard(def, s) {
  const card = el('div', 'card');
  const head = el('div', 'head');
  head.append(el('span', 'name', def.name));
  if (s.plan) head.append(el('span', 'plan', s.plan));
  if (s.stale) head.append(el('span', 'stale', 'mất kết nối'));
  if (s.account) head.title = s.account;
  card.append(head);

  if (s.status === 'ok') {
    for (const w of s.windows) {
      const row = el('div', 'row');
      row.title = `${w.label}: ${Math.round(w.percent)}%${w.resetsAt ? `\n${resetTooltip(w.resetsAt)}` : ''}`;
      const bar = el('div', 'bar');
      const fill = el('i', level(w.percent));
      fill.style.width = `${w.percent}%`;
      bar.append(fill);
      row.append(
        el('span', 'label', shortLabel(w.label)),
        bar,
        el('span', 'pct', `${Math.round(w.percent)}%`),
        el('span', 'reset', resetClock(w.resetsAt)),
      );
      card.append(row);
    }
  } else if (s.status === 'waiting') {
    card.append(message('Chờ cho phép trên trình duyệt…', false, 'Huỷ', () => window.api.cancelLogin(def.key), true));
  } else if (s.status === 'login') {
    card.append(message('Chưa đăng nhập', false, 'Đăng nhập', () => window.api.login(def.key)));
  } else if (s.status === 'error') {
    card.append(message(s.message || 'Lỗi không rõ', true, 'Thử lại', () => window.api.login(def.key)));
  } else {
    card.append(message('Đang tải…', false));
  }
  return card;
}

function render(state) {
  current = state;
  document.getElementById('cards').replaceChildren(...PROVIDERS.map((p) => renderCard(p, state[p.key])));
  document.getElementById('updated').textContent = state.updatedAt
    ? `${resetClock(state.updatedAt)} · ${tzName()}`
    : '…';
  requestAnimationFrame(() => window.api.fit(document.getElementById('box').getBoundingClientRect().height));
}

document.getElementById('btn-hide').onclick = () => window.api.hide();

window.api.onState(render);
window.api.getState().then(render);

// Cập nhật đếm ngược mỗi 30 giây mà không gọi mạng.
setInterval(() => { if (current) render(current); }, 30000);
