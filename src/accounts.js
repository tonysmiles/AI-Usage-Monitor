// Danh sách tài khoản (không chứa token): [{ id, provider, label, email, workspace }]
const crypto = require('crypto');

const PROVIDER_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

function newId(provider) {
  return `${provider}-${crypto.randomBytes(4).toString('hex')}`;
}

// Bản cũ lưu token theo { claude: {...}, chatgpt: {...} }: gắn provider và đưa vào danh sách.
function migrate(tokens, accounts) {
  const list = Array.isArray(accounts) ? accounts.slice() : [];
  let changed = false;
  for (const [id, t] of Object.entries(tokens || {})) {
    if (!t || typeof t !== 'object') continue;
    if (!t.provider && PROVIDER_NAMES[id]) {
      t.provider = id;
      changed = true;
    }
    if (t.provider && !list.some((a) => a.id === id)) {
      list.push({ id, provider: t.provider, label: null, email: t.email || null, workspace: t.account_id || null });
      changed = true;
    }
  }
  return { tokens, accounts: list, changed };
}

// Cùng bên + cùng email (+ cùng workspace với ChatGPT) thì coi là một tài khoản.
function findDuplicate(accounts, provider, email, workspace) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  return accounts.find((a) => a.provider === provider
    && a.email && a.email.toLowerCase() === e
    && (provider !== 'chatgpt' || !workspace || !a.workspace || a.workspace === workspace)) || null;
}

function shortEmail(email) {
  if (!email) return null;
  const local = String(email).split('@')[0];
  return local.length > 16 ? `${local.slice(0, 15)}…` : local;
}

function displayName(account, accounts) {
  if (account.label) return account.label;
  const se = shortEmail(account.email);
  if (se) return se;
  const same = accounts.filter((a) => a.provider === account.provider);
  return same.length > 1 ? `#${same.indexOf(account) + 1}` : '';
}

module.exports = { PROVIDER_NAMES, newId, migrate, findDuplicate, shortEmail, displayName };
