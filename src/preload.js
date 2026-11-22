const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  add: (provider) => ipcRenderer.invoke('add', provider),
  relogin: (id) => ipcRenderer.invoke('relogin', id),
  cancelLogin: (provider) => ipcRenderer.invoke('cancel-login', provider),
  copyLoginLink: (provider) => ipcRenderer.invoke('copy-login-link', provider),
  remove: (id) => ipcRenderer.invoke('remove', id),
  move: (id, dir) => ipcRenderer.invoke('move', id, dir),
  rename: (id, label) => ipcRenderer.invoke('rename', id, label),
  dismissError: () => ipcRenderer.invoke('dismiss-error'),
  setCompact: (v) => ipcRenderer.invoke('set-compact', v),
  setRenewal: (id, value) => ipcRenderer.invoke('renewal:set', id, value),
  fit: (height) => ipcRenderer.send('fit', height),
  hide: () => ipcRenderer.send('hide'),
  focus: () => ipcRenderer.send('focus'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEvents: (cb) => ipcRenderer.on('events', (_e, ev) => cb(ev)),
});
