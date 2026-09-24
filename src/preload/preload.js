'use strict';
// Narrow, explicit API surface for the renderer (contextIsolation on).
// Every invoke resolves to { ok: true, data } or { ok: false, error: {code, message, params} }.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const handler = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('forja', {
  appInfo: call('app:info'),
  getI18n: call('i18n:get'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  listProfiles: call('profiles:list'),
  createProfile: call('profiles:create'),
  updateProfile: call('profiles:update'),
  duplicateProfile: call('profiles:duplicate'),
  deleteProfile: call('profiles:delete'),
  listVersions: call('versions:list'),
  gamesStatus: call('games:status'),
  gameLogs: call('games:logs'),
  launch: call('game:launch'),
  cancel: call('game:cancel'),
  kill: call('game:kill'),
  repair: call('profile:repair'),
  openDataDir: call('shell:openDataDir'),
  openProfileDir: call('shell:openProfileDir'),
  openCrashReports: call('shell:openCrashReports'),
  pickJava: call('dialog:pickJava'),
  onProgress: subscribe('game:progress'),
  onLog: subscribe('game:log'),
  onState: subscribe('game:state'),
  onCrash: subscribe('game:crash'),
  onProfilesChanged: subscribe('profiles:changed'),
});
