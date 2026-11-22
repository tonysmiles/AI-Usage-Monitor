const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, safeStorage, net, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeClaude, normalizeChatGPT } = require('./normalize');
const { createOAuth } = require('./oauth');
const { fetchClaude, fetchChatGPT } = require('./usage');

const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' };
const WIDTH = 248;
const MARGIN = 12;

// ---------- Cấu hình ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { intervalSec: 60, alwaysOnTop: true, openAtLogin: false, pos: null };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (_) {}
}

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
let refreshing = null;
const state = {
  claude: { status: 'idle' },
  chatgpt: { status: 'idle' },
  updatedAt: null,
};

async function fetchProvider(key) {
  try {
    if (key === 'claude') {
      const res = await fetchClaude(oauth, (...a) => net.fetch(...a));
      const norm = normalizeClaude(res.raw);
      if (!norm.windows.length) return { status: 'error', message: 'Không đọc được số liệu Claude (định dạng đã đổi?)' };
      return { status: 'ok', account: res.account, plan: res.plan, windows: norm.windows };
    }
    const res = await fetchChatGPT(oauth, (...a) => net.fetch(...a));
    const norm = normalizeChatGPT(res.raw);
    if (!norm.windows.length) return { status: 'error', message: 'Không đọc được số liệu ChatGPT (định dạng đã đổi?)' };
    return { status: 'ok', account: res.account, plan: norm.plan, windows: norm.windows };
  } catch (err) {
    if (err && err.name === 'AuthRequired') return { status: 'login' };
    // Lỗi mạng tạm thời: giữ số liệu cũ, chỉ đánh dấu.
    const prev = state[key];
    if (prev && prev.status === 'ok') return { ...prev, stale: true };
    return { status: 'error', message: String(err && err.message ? err.message : err) };
  }
}

async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const keys = Object.keys(NAMES).filter((k) => state[k].status !== 'waiting');
    const results = await Promise.all(keys.map(fetchProvider));
    keys.forEach((k, i) => { state[k] = results[i]; });
    state.updatedAt = Date.now();
    broadcast();
    updateTray();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(refreshAll, Math.max(30, settings.intervalSec) * 1000);
}

// ---------- Tray ----------
function summaryLine(label, s) {
  if (s.status !== 'ok') return `${label}: ${s.status === 'login' ? 'chưa đăng nhập' : '—'}`;
  return `${label}: ${s.windows.map((w) => `${Math.round(w.percent)}%`).join(' / ')}`;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`${summaryLine('Claude', state.claude)}\n${summaryLine('ChatGPT', state.chatgpt)}`);
}

function buildTrayMenu() {
  const interval = (sec, label) => ({
    label, type: 'radio', checked: settings.intervalSec === sec,
    click: () => applySettings({ intervalSec: sec }),
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Hiện / ẩn', click: toggleWindow },
    { label: 'Về góc dưới phải', click: () => { settings.pos = null; saveSettings(); placeWindow(); win.show(); } },
    { type: 'separator' },
    { label: 'Tự làm mới', submenu: [interval(30, '30 giây'), interval(60, '1 phút'), interval(120, '2 phút'), interval(300, '5 phút')] },
    { label: 'Luôn nằm trên cùng', type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => applySettings({ alwaysOnTop: i.checked }) },
    { label: 'Chạy cùng Windows', type: 'checkbox', checked: settings.openAtLogin, click: (i) => applySettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Đăng xuất Claude', enabled: state.claude.status === 'ok', click: () => logout('claude') },
    { label: 'Đăng xuất ChatGPT', enabled: state.chatgpt.status === 'ok', click: () => logout('chatgpt') },
    { type: 'separator' },
    { label: 'Thoát', click: () => { quitting = true; app.quit(); } },
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
  saveSettings();
  schedule();
  buildTrayMenu();
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
    height: 160,
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

// Renderer báo chiều cao nội dung; giữ nguyên mép dưới khi widget cao/thấp đi.
function fitHeight(h) {
  if (!win || win.isDestroyed()) return;
  const height = Math.max(60, Math.min(600, Math.ceil(h)));
  const [x, y] = win.getPosition();
  const [, oldH] = win.getSize();
  if (oldH === height) return;
  win.setBounds({ x, y: y + oldH - height, width: WIDTH, height });
}

async function logout(key) {
  oauth.logout(key);
  state[key] = { status: 'login' };
  broadcast();
  updateTray();
  buildTrayMenu();
}

// ---------- IPC ----------
ipcMain.handle('state:get', () => state);
ipcMain.on('fit', (_e, h) => fitHeight(h));
ipcMain.on('hide', () => win && win.hide());

ipcMain.handle('login', async (_e, key) => {
  if (!NAMES[key]) return;
  state[key] = { status: 'waiting' };
  broadcast();
  try {
    await oauth.login(key);
    state[key] = { status: 'idle' };
  } catch (err) {
    state[key] = err && err.message === 'Đã huỷ đăng nhập'
      ? { status: 'login' }
      : { status: 'error', message: String(err && err.message ? err.message : err) };
    broadcast();
    return;
  }
  await refreshAll();
  buildTrayMenu();
});

ipcMain.handle('cancel-login', (_e, key) => {
  if (NAMES[key]) oauth.cancelLogin(key);
});

// ---------- Vòng đời ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); refreshAll(); } });
  app.whenReady().then(() => {
    loadSettings();
    oauth = createOAuth({
      openUrl: (url) => shell.openExternal(url),
      storage,
      fetchImpl: (...a) => net.fetch(...a),
    });
    createWindow();
    createTray();
    schedule();
    win.webContents.once('did-finish-load', refreshAll);
    // Máy thức dậy / mở khoá: làm mới ngay.
    powerMonitor.on('resume', () => setTimeout(refreshAll, 5000));
    powerMonitor.on('unlock-screen', refreshAll);
    screen.on('display-metrics-changed', placeWindow);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* giữ app chạy ở khay hệ thống */ });
}
