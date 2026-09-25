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
  updaterStatus: call('updater:status'),
  updaterCheck: call('updater:check'),
  updaterInstall: call('updater:install'),
  openReleases: call('shell:openReleases'),
  onUpdaterState: subscribe('updater:state'),
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
  loaderVersions: call('loaders:versions'),
  modrinthSearch: call('modrinth:search'),
  modrinthCategories: call('modrinth:categories'),
  modrinthProject: call('modrinth:project'),
  contentList: call('content:list'),
  contentToggle: call('content:toggle'),
  contentRemove: call('content:remove'),
  contentInstall: call('content:install'),
  contentCheckUpdates: call('content:checkUpdates'),
  contentUpdate: call('content:update'),
  modpackImportFile: call('modpack:importFile'),
  modpackInstallModrinth: call('modpack:installModrinth'),
  modpackCancel: call('modpack:cancel'),
  storageUsage: call('storage:usage'),
  storagePlan: call('storage:plan'),
  storageClean: call('storage:clean'),
  openModrinth: call('shell:openModrinth'),
  onContentProgress: subscribe('content:progress'),
  onModpackProgress: subscribe('modpack:progress'),
  onProgress: subscribe('game:progress'),
  onLog: subscribe('game:log'),
  onState: subscribe('game:state'),
  onCrash: subscribe('game:crash'),
  onProfilesChanged: subscribe('profiles:changed'),
  // window / appearance (0.3.3)
  windowMinimize: call('window:minimize'),
  windowMaximize: call('window:maximize'),
  windowClose: call('window:close'),
  windowIsMaximized: call('window:isMaximized'),
  windowPlatform: call('window:platform'),
  pickImage: call('dialog:pickImage'),
  pickFile: call('dialog:pickFile'),
  fetchNews: call('news:fetch'),
  addPlayTime: call('profiles:addPlayTime'),
  onWindowMaximized: subscribe('window:maximized'),
});
