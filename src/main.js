const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, safeStorage, net, screen, powerMonitor, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeClaude, normalizeChatGPT, diffEvents } = require('./normalize');
const { createOAuth } = require('./oauth');
const { fetchClaude, fetchChatGPT } = require('./usage');
const { STR, errText } = require('./i18n');
const { PROVIDER_NAMES, newId, migrate, findDuplicate, displayName } = require('./accounts');

const WIDTH = 256;
const MARGIN = 12;
const THRESHOLD = 70;
const DAY = 86400000;

// ---------- Cấu hình ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  intervalSec: 60,
  alwaysOnTop: true,
  openAtLogin: false,
  notify: true,
  compact: false,
  lang: null,
  pos: null,
  accounts: [],       // [{ id, provider, label, email, workspace }]
  renewal: {},        // ngày gia hạn nhập tay theo id tài khoản: 'YYYY-MM-DD'
  renewNotified: {},  // đã nhắc gia hạn cho ngày nào, theo id
};
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) {}
  if (!settings.lang) settings.lang = String(app.getLocale() || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
  settings.accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  settings.renewal = settings.renewal || {};
  settings.renewNotified = settings.renewNotified || {};
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (_) {}
}
const T = () => STR[settings.lang] || STR.vi;

// ---------- Lưu token (mã hoá bằng DPAPI của Windows qua safeStorage) ----------
const tokenFile = () => path.join(app.getPath('userData'), 'tokens.bin');
let memoryTokens = {};
const storage = {
  load() {
    if (!safeStorage.isEncryptionAvailable()) return memoryTokens;
    try {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenFile())));
    } catch (_) {
      return {};
    }
  },
  save(obj) {
    if (!safeStorage.isEncryptionAvailable()) { memoryTokens = obj; return; }
    fs.writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify(obj)));
  },
};

let oauth = null;

// ---------- Trạng thái ----------
let win = null;
let tray = null;
let quitting = false;
let timer = null;
let resetTimer = null;
let refreshing = null;
const usage = {};                                  // id -> { status, windows, plan, ... }
const pending = { claude: null, chatgpt: null };   // đăng nhập đang chờ: { url, target }
let addError = null;
let updatedAt = null;

const accountById = (id) => settings.accounts.find((a) => a.id === id);
const nameOf = (a) => {
  const n = displayName(a, settings.accounts);
  return n ? `${PROVIDER_NAMES[a.provider]} · ${n}` : PROVIDER_NAMES[a.provider];
};

// Ngày gia hạn: ưu tiên ngày nhập tay; ngày đã qua thì tự cộng thêm tháng.
function rollForward(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  let guard = 0;
  while (d.getTime() < Date.now() - DAY / 2 && guard++ < 36) d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
function renewalFor(id) {
  const manual = settings.renewal[id];
  if (manual) {
    const [y, m, dd] = manual.split('-').map(Number);
    return { at: rollForward(new Date(y, m - 1, dd, 12).getTime()), source: 'manual' };
  }
  const detected = usage[id] && usage[id].detectedRenewal;
  if (detected) return { at: rollForward(detected), source: 'auto' };
  return null;
}

function snapshot() {
  return {
    lang: settings.lang,
    compact: settings.compact,
    updatedAt,
    addError,
    pending: {
      claude: pending.claude ? { target: pending.claude.target } : null,
      chatgpt: pending.chatgpt ? { target: pending.chatgpt.target } : null,
    },
    accounts: settings.accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      label: a.label || null,
      email: a.email || null,
      shortName: displayName(a, settings.accounts),
      renewal: renewalFor(a.id),
      ...(usage[a.id] || { status: oauth && oauth.hasTokens(a.id) ? 'idle' : 'login' }),
    })),
  };
}

async function fetchAccount(a) {
  try {
    const f = (...x) => net.fetch(...x);
    const res = a.provider === 'claude' ? await fetchClaude(oauth, a.id, f) : await fetchChatGPT(oauth, a.id, f);
    const norm = a.provider === 'claude' ? normalizeClaude(res.raw) : normalizeChatGPT(res.raw);
    if (res.email && res.email !== a.email) { a.email = res.email; saveSettings(); }
    if (!norm.windows.length) return { status: 'error', message: errText(settings.lang, { code: 'parse' }) };
    return {
      status: 'ok',
      plan: norm.plan || res.plan || null,
      windows: norm.windows,
      detectedRenewal: res.renewal || null,
    };
  } catch (err) {
    if (err && err.name === 'AuthRequired') return { status: 'login' };
    // Lỗi mạng tạm thời: giữ số liệu cũ, chỉ đánh dấu.
    const prev = usage[a.id];
    if (prev && prev.status === 'ok') return { ...prev, stale: true };
    return { status: 'error', message: errText(settings.lang, err) };
  }
}

function notify(title, body) {
  if (!settings.notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false, icon: path.join(__dirname, '..', 'build', 'icon.png') });
  n.on('click', () => { if (win) win.show(); });
  n.show();
}

function windowName(w) {
  const en = settings.lang === 'en';
  if (w.kind === '5h') return w.name ? `${w.name} 5h` : (en ? '5-hour session' : 'Phiên 5 giờ');
  if (w.kind === 'week') return w.name ? `${w.name} (${en ? 'weekly' : 'tuần'})` : (en ? 'Weekly limit' : 'Giới hạn tuần');
  return w.name || (en ? 'Limit' : 'Giới hạn');
}

function handleEvents(a, prev, next) {
  if (!prev || prev.status !== 'ok' || next.status !== 'ok') return [];
  const events = diffEvents(prev.windows, next.windows, THRESHOLD);
  const byId = new Map(next.windows.map((w) => [w.id, w]));
  for (const ev of events) {
    const w = byId.get(ev.id);
    if (ev.type === 'reset') notify(T().resetTitle(nameOf(a)), T().resetBody(windowName(w)));
    else notify(T().warnTitle(nameOf(a)), T().warnBody(windowName(w), Math.round(ev.percent)));
  }
  return events.map((e) => ({ ...e, account: a.id, at: Date.now() }));
}

function checkRenewalReminder(a) {
  const r = renewalFor(a.id);
  if (!r || !r.at) return;
  const days = Math.ceil((r.at - Date.now()) / DAY);
  const tag = new Date(r.at).toISOString().slice(0, 10);
  if (days >= 0 && days <= 3 && settings.renewNotified[a.id] !== tag) {
    settings.renewNotified[a.id] = tag;
    saveSettings();
    const d = new Date(r.at).toLocaleDateString(settings.lang === 'en' ? 'en-US' : 'vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
    notify(T().renewTitle(nameOf(a)), T().renewBody(d));
  }
}

async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const list = settings.accounts.slice();
    const results = await Promise.all(list.map(fetchAccount));
    const events = [];
    list.forEach((a, i) => {
      if (!accountById(a.id)) return; // bị xoá trong lúc đang tải
      events.push(...handleEvents(a, usage[a.id], results[i]));
      usage[a.id] = results[i];
      checkRenewalReminder(a);
    });
    updatedAt = Date.now();
    broadcast();
    if (events.length && win && !win.isDestroyed()) win.webContents.send('events', events);
    updateTray();
    scheduleResetRefresh();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshOne(id) {
  const a = accountById(id);
  if (!a) return;
  const prev = usage[id];
  const next = await fetchAccount(a);
  if (!accountById(id)) return;
  const events = handleEvents(a, prev, next);
  usage[id] = next;
  checkRenewalReminder(a);
  updatedAt = Date.now();
  broadcast();
  if (events.length && win && !win.isDestroyed()) win.webContents.send('events', events);
  updateTray();
  scheduleResetRefresh();
}

// Đến đúng giờ reset gần nhất thì làm mới ngay để bắt hiệu ứng reset.
function scheduleResetRefresh() {
  clearTimeout(resetTimer);
  const now = Date.now();
  let next = Infinity;
  for (const u of Object.values(usage)) {
    if (!u || u.status !== 'ok') continue;
    for (const w of u.windows) if (w.resetsAt && w.resetsAt > now) next = Math.min(next, w.resetsAt);
  }
  const wait = next - now + 15000;
  if (wait > 0 && wait < settings.intervalSec * 1000 + 15000) resetTimer = setTimeout(refreshAll, wait);
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(refreshAll, Math.max(30, settings.intervalSec) * 1000);
}

// ---------- Thêm / đăng nhập lại / xoá tài khoản ----------
// target: id tài khoản cần đăng nhập lại, hoặc null để thêm mới.
async function startLogin(provider, target) {
  if (!PROVIDER_NAMES[provider]) return;
  addError = null;
  pending[provider] = { url: null, target: target || null };
  broadcast();
  let tokens;
  try {
    tokens = await oauth.login(provider, { onUrl: (url) => { if (pending[provider]) pending[provider].url = url; } });
  } catch (err) {
    pending[provider] = null;
    if (!(err && err.code === 'cancelled')) addError = { provider, message: errText(settings.lang, err) };
    broadcast();
    return;
  }
  pending[provider] = null;

  let acc = target ? accountById(target) : null;
  if (!acc) acc = findDuplicate(settings.accounts, provider, tokens.email, tokens.account_id);
  if (!acc) {
    acc = { id: newId(provider), provider, label: null, email: null, workspace: null };
    settings.accounts.push(acc);
  }
  acc.email = tokens.email || acc.email;
  acc.workspace = tokens.account_id || acc.workspace;
  oauth.saveTokens(acc.id, tokens);
  saveSettings();
  delete usage[acc.id];
  buildTrayMenu();
  await refreshOne(acc.id);
}

function removeAccount(id) {
  const i = settings.accounts.findIndex((a) => a.id === id);
  if (i < 0) return;
  oauth.logout(id);
  settings.accounts.splice(i, 1);
  delete settings.renewal[id];
  delete settings.renewNotified[id];
  delete usage[id];
  saveSettings();
  broadcast();
  updateTray();
  buildTrayMenu();
}

function moveAccount(id, dir) {
  const i = settings.accounts.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= settings.accounts.length) return;
  [settings.accounts[i], settings.accounts[j]] = [settings.accounts[j], settings.accounts[i]];
  saveSettings();
  broadcast();
  buildTrayMenu();
}

// ---------- Tray ----------
function updateTray() {
  if (!tray) return;
  const lines = settings.accounts.map((a) => {
    const u = usage[a.id];
    if (!u || u.status !== 'ok') return `${nameOf(a)}: ${u && u.status === 'login' ? T().notLogged : '—'}`;
    return `${nameOf(a)}: ${u.windows.map((w) => `${Math.round(w.percent)}%`).join(' / ')}`;
  });
  // Tooltip khay Windows giới hạn ~127 ký tự.
  let tip = 'AI Usage Monitor';
  if (lines.length) tip = lines.join('\n');
  tray.setToolTip(tip.length > 127 ? `${tip.slice(0, 124)}…` : tip);
}

function buildTrayMenu() {
  if (!tray) return;
  const t = T();
  const interval = (sec, label) => ({
    label, type: 'radio', checked: settings.intervalSec === sec,
    click: () => applySettings({ intervalSec: sec }),
  });
  const accItems = settings.accounts.map((a) => ({
    label: nameOf(a),
    submenu: [
      { label: t.relogin, click: () => startLogin(a.provider, a.id) },
      { label: t.remove, click: () => removeAccount(a.id) },
    ],
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.show, click: toggleWindow },
    { label: t.corner, click: () => { settings.pos = null; saveSettings(); placeWindow(); win.show(); } },
    { type: 'separator' },
    { label: t.addAccount, submenu: [
      { label: 'Claude', click: () => { win.show(); startLogin('claude', null); } },
      { label: 'ChatGPT', click: () => { win.show(); startLogin('chatgpt', null); } },
    ] },
    { label: t.accounts, enabled: accItems.length > 0, submenu: accItems.length ? accItems : [{ label: '—', enabled: false }] },
    { type: 'separator' },
    { label: t.compact, type: 'checkbox', checked: settings.compact, click: (i) => applySettings({ compact: i.checked }) },
    { label: t.language, submenu: [
      { label: 'Tiếng Việt', type: 'radio', checked: settings.lang === 'vi', click: () => applySettings({ lang: 'vi' }) },
      { label: 'English', type: 'radio', checked: settings.lang === 'en', click: () => applySettings({ lang: 'en' }) },
    ] },
    { label: t.interval, submenu: [interval(30, t.sec30), interval(60, t.min1), interval(120, t.min2), interval(300, t.min5)] },
    { label: t.notify, type: 'checkbox', checked: settings.notify, click: (i) => applySettings({ notify: i.checked }) },
    { label: t.onTop, type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => applySettings({ alwaysOnTop: i.checked }) },
    { label: t.startup, type: 'checkbox', checked: settings.openAtLogin, click: (i) => applySettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: t.quit, click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', toggleWindow);
  tray.on('right-click', buildTrayMenu);
  buildTrayMenu();
  updateTray();
}

function applySettings(patch) {
  if (typeof patch.intervalSec === 'number') settings.intervalSec = Math.max(30, Math.min(3600, patch.intervalSec));
  if (typeof patch.alwaysOnTop === 'boolean') {
    settings.alwaysOnTop = patch.alwaysOnTop;
    if (win) win.setAlwaysOnTop(patch.alwaysOnTop, 'screen-saver');
  }
  if (typeof patch.openAtLogin === 'boolean') {
    settings.openAtLogin = patch.openAtLogin;
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
  }
  if (typeof patch.notify === 'boolean') settings.notify = patch.notify;
  if (typeof patch.compact === 'boolean') settings.compact = patch.compact;
  if (patch.lang === 'vi' || patch.lang === 'en') settings.lang = patch.lang;
  saveSettings();
  schedule();
  buildTrayMenu();
  updateTray();
  broadcast();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); refreshAll(); }
}

// ---------- Cửa sổ widget ----------
function placeWindow() {
  const [, h] = win.getSize();
  const pos = settings.pos;
  if (pos) {
    const d = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: WIDTH, height: h });
    const a = d.workArea;
    const x = Math.min(Math.max(pos.x, a.x), a.x + a.width - WIDTH);
    const y = Math.min(Math.max(pos.y, a.y), a.y + a.height - h);
    win.setPosition(x, y);
    return;
  }
  const a = screen.getPrimaryDisplay().workArea;
  win.setPosition(a.x + a.width - WIDTH - MARGIN, a.y + a.height - h - MARGIN);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: 180,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: settings.alwaysOnTop,
    title: 'AI Usage Monitor',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { placeWindow(); win.showInactive(); });

  let moveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      settings.pos = { x, y };
      saveSettings();
    }, 300);
  });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

// Renderer báo chiều cao nội dung; giữ mép dưới cố định và không vượt quá màn hình.
function fitHeight(h) {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const height = Math.max(60, Math.min(area.height - MARGIN * 2, Math.ceil(h)));
  const [, oldH] = win.getSize();
  if (oldH === height) return;
  const ny = Math.max(area.y + MARGIN, y + oldH - height);
  win.setBounds({ x, y: ny, width: WIDTH, height });
}

// Windows chỉ hiện thông báo khi có shortcut Start Menu mang đúng AppUserModelId.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AI Usage Monitor.lnk');
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', {
      target,
      appUserModelId: 'local.ai-usage-monitor',
      description: 'AI Usage Monitor',
    });
  } catch (_) { /* không có shortcut thì chỉ mất thông báo */ }
}

// ---------- IPC ----------
ipcMain.handle('state:get', () => snapshot());
ipcMain.on('fit', (_e, h) => fitHeight(h));
ipcMain.on('hide', () => win && win.hide());
ipcMain.on('focus', () => win && win.focus());
ipcMain.handle('add', (_e, provider) => startLogin(provider, null));
ipcMain.handle('relogin', (_e, id) => { const a = accountById(id); if (a) return startLogin(a.provider, id); });
ipcMain.handle('cancel-login', (_e, provider) => { if (PROVIDER_NAMES[provider]) oauth.cancelLogin(provider); });
ipcMain.handle('copy-login-link', (_e, provider) => {
  const p = pending[provider];
  if (p && p.url) { clipboard.writeText(p.url); return true; }
  return false;
});
ipcMain.handle('remove', (_e, id) => removeAccount(id));
ipcMain.handle('move', (_e, id, dir) => moveAccount(id, dir === -1 ? -1 : 1));
ipcMain.handle('rename', (_e, id, label) => {
  const a = accountById(id);
  if (!a) return;
  a.label = typeof label === 'string' && label.trim() ? label.trim().slice(0, 24) : null;
  saveSettings();
  broadcast();
  updateTray();
  buildTrayMenu();
});
ipcMain.handle('dismiss-error', () => { addError = null; broadcast(); });
ipcMain.handle('set-compact', (_e, v) => applySettings({ compact: !!v }));
ipcMain.handle('renewal:set', (_e, id, value) => {
  const a = accountById(id);
  if (!a) return;
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) settings.renewal[id] = value;
  else delete settings.renewal[id];
  delete settings.renewNotified[id];
  saveSettings();
  checkRenewalReminder(a);
  broadcast();
});

// ---------- Vòng đời ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); refreshAll(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId('local.ai-usage-monitor'); // cần cho thông báo Windows
    ensureStartMenuShortcut();
    loadSettings();
    // Chuyển token của bản cũ (một tài khoản mỗi bên) sang danh sách tài khoản.
    const m = migrate(storage.load(), settings.accounts);
    if (m.changed) { storage.save(m.tokens); settings.accounts = m.accounts; saveSettings(); }
    oauth = createOAuth({
      openUrl: (url) => shell.openExternal(url),
      storage,
      fetchImpl: (...a) => net.fetch(...a),
    });
    createWindow();
    createTray();
    schedule();
    win.webContents.once('did-finish-load', refreshAll);
    powerMonitor.on('resume', () => setTimeout(refreshAll, 5000));
    powerMonitor.on('unlock-screen', refreshAll);
    screen.on('display-metrics-changed', placeWindow);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* giữ app chạy ở khay hệ thống */ });
}
