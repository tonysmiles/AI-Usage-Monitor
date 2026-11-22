// Chuỗi dùng chung cho main và renderer.
const STR = {
  vi: {
    show: 'Hiện / ẩn',
    corner: 'Về góc dưới phải',
    interval: 'Tự làm mới',
    sec30: '30 giây', min1: '1 phút', min2: '2 phút', min5: '5 phút',
    onTop: 'Luôn nằm trên cùng',
    startup: 'Chạy cùng Windows',
    notify: 'Thông báo Windows',
    language: 'Ngôn ngữ / Language',
    logout: (n) => `Đăng xuất ${n}`,
    addAccount: 'Thêm tài khoản',
    accounts: 'Tài khoản',
    relogin: 'Đăng nhập lại',
    remove: 'Xoá tài khoản',
    compact: 'Chế độ thu gọn',
    quit: 'Thoát',
    notLogged: 'chưa đăng nhập',
    // thông báo
    resetTitle: (n) => `${n}: đã reset`,
    resetBody: (l) => `${l} đã về lại. Dùng thoải mái!`,
    warnTitle: (n) => `${n}: sắp chạm giới hạn`,
    warnBody: (l, p) => `${l} đã dùng ${p}%.`,
    renewTitle: (n) => `${n}: sắp gia hạn`,
    renewBody: (d) => `Gói sẽ gia hạn ${d}.`,
    // lỗi
    err: {
      rate_limited: 'Bị giới hạn đăng nhập (429). Đợi vài phút rồi thử lại.',
      token_failed: (e) => `Đổi token thất bại (HTTP ${e.httpStatus || '?'})`,
      denied: 'Bị từ chối trên trình duyệt',
      bad_state: 'Phản hồi đăng nhập không hợp lệ',
      timeout: 'Hết thời gian chờ đăng nhập',
      port_in_use: (e) => `Cổng ${e.port} bị chiếm. Đóng ${e.tool} rồi thử lại.`,
      http: (e) => `Máy chủ trả về lỗi ${e.httpStatus || '?'}`,
      no_endpoint: 'Không tìm thấy endpoint usage (có thể đã đổi)',
      parse: 'Không đọc được số liệu (định dạng đã đổi?)',
      gemini_not_eligible: 'Tài khoản Google này chưa có gói AI Pro/Ultra hoặc chưa dùng được Antigravity',
      missing_client: (e) => `Bản build này thiếu cấu hình đăng nhập ${e.provider || ''} (src/oauth-clients.local.json)`,
      gemini_no_project: 'Chưa thiết lập Antigravity: mở Antigravity, đăng nhập một lần rồi thử lại',
    },
  },
  en: {
    show: 'Show / hide',
    corner: 'Snap to bottom-right',
    interval: 'Auto refresh',
    sec30: '30 seconds', min1: '1 minute', min2: '2 minutes', min5: '5 minutes',
    onTop: 'Always on top',
    startup: 'Start with Windows',
    notify: 'Windows notifications',
    language: 'Ngôn ngữ / Language',
    logout: (n) => `Sign out of ${n}`,
    addAccount: 'Add account',
    accounts: 'Accounts',
    relogin: 'Sign in again',
    remove: 'Remove account',
    compact: 'Compact mode',
    quit: 'Quit',
    notLogged: 'not signed in',
    resetTitle: (n) => `${n}: limit reset`,
    resetBody: (l) => `${l} is back to full. Go wild!`,
    warnTitle: (n) => `${n}: nearing the limit`,
    warnBody: (l, p) => `${l} is at ${p}%.`,
    renewTitle: (n) => `${n}: renewal coming up`,
    renewBody: (d) => `Your plan renews ${d}.`,
    err: {
      rate_limited: 'Sign-in rate limited (429). Wait a few minutes and retry.',
      token_failed: (e) => `Token exchange failed (HTTP ${e.httpStatus || '?'})`,
      denied: 'Access was denied in the browser',
      bad_state: 'Invalid sign-in response',
      timeout: 'Sign-in timed out',
      port_in_use: (e) => `Port ${e.port} is busy. Close ${e.tool} and retry.`,
      http: (e) => `Server returned error ${e.httpStatus || '?'}`,
      no_endpoint: 'Usage endpoint not found (it may have changed)',
      parse: 'Could not read usage data (format changed?)',
      gemini_not_eligible: 'This Google account has no AI Pro/Ultra plan or cannot use Antigravity yet',
      missing_client: (e) => `This build is missing ${e.provider || ''} sign-in config (src/oauth-clients.local.json)`,
      gemini_no_project: 'Antigravity is not set up: open Antigravity, sign in once, then retry',
    },
  },
};

function errText(lang, err) {
  const table = (STR[lang] || STR.vi).err;
  const entry = err && err.code && table[err.code];
  if (typeof entry === 'function') return entry(err);
  if (typeof entry === 'string') return entry;
  return String(err && err.message ? err.message : err);
}

module.exports = { STR, errText };
