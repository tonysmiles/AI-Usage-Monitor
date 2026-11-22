const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  login: (provider) => ipcRenderer.invoke('login', provider),
  cancelLogin: (provider) => ipcRenderer.invoke('cancel-login', provider),
  fit: (height) => ipcRenderer.send('fit', height),
  hide: () => ipcRenderer.send('hide'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
