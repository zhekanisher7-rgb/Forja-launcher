'use strict';
// Narrow, explicit API surface for the renderer (contextIsolation on).
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const handler = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('forja', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  getI18n: (lang) => ipcRenderer.invoke('i18n:get', lang),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listVersions: (opts) => ipcRenderer.invoke('versions:list', opts),
  launch: (opts) => ipcRenderer.invoke('game:launch', opts),
  cancel: () => ipcRenderer.invoke('game:cancel'),
  killGame: () => ipcRenderer.invoke('game:kill'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  onProgress: subscribe('game:progress'),
  onLog: subscribe('game:log'),
  onState: subscribe('game:state'),
});
