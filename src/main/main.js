'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const config = require('./config');
const { createLayout } = require('./core/paths');
const { fetchManifest, filterVersions, listInstalled } = require('./core/versions');
const { prepareAndLaunch } = require('./core/launcher');
const { parseArgString } = require('./core/launch');
const { GameManager } = require('./core/games');
const { ProfileStore, ICON_PRESETS, COLORS } = require('./core/profiles');
const { Settings, totalMemoryMb } = require('./core/settings');
const { sweepStaleNativesDirs } = require('./core/natives');
const { repairVersion } = require('./core/repair');
const { classifyError } = require('./core/errors');
const { createSession, providers } = require('./auth');

const layout = createLayout();
fs.mkdirSync(layout.root, { recursive: true });
const settings = new Settings(layout.settingsFile);
const profiles = new ProfileStore(layout, { legacy: settings.legacy });
const games = new GameManager({ launchFn: prepareAndLaunch });
const repairs = new Map(); // profileId -> AbortController
let win = null;
let hiddenForGame = false;

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function serializeError(err) {
  const c = classifyError(err);
  return { code: c.code, message: c.message, params: c.params || {} };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: config.name,
    backgroundColor: '#101217',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---- game manager events → renderer ----
games.on('progress', (p) => send('game:progress', p));
games.on('log', (l) => send('game:log', l));
games.on('crash', (c) => {
  if (win && hiddenForGame) { win.show(); hiddenForGame = false; }
  send('game:crash', c);
});
games.on('state', (s) => {
  const payload = { ...s };
  if (s.error) payload.error = serializeError(s.error);
  send('game:state', payload);
  if (s.state === 'running') {
    profiles.touch(s.profileId);
    send('profiles:changed', profiles.list());
    const mode = settings.get().onGameStart;
    if (mode === 'hide' && win) { win.hide(); hiddenForGame = true; }
    if (mode === 'close') setTimeout(() => app.quit(), 1500);
  }
  if (s.state === 'exited' && hiddenForGame && games.runningCount() === 0 && win) {
    win.show();
    hiddenForGame = false;
  }
});

// ---- IPC ----
const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
});

handle('app:info', () => ({
  name: config.name,
  version: config.version,
  platform: process.platform,
  arch: process.arch,
  dataDir: layout.root,
  totalMemoryMb: totalMemoryMb(),
  iconPresets: ICON_PRESETS,
  colors: COLORS,
  profilesMigrated: profiles.migrated,
  auth: Object.values(providers).map((p) => ({ id: p.id, available: p.available })),
}));

handle('i18n:get', (lang) => {
  const safe = ['ru', 'en'].includes(lang) ? lang : config.defaultLanguage;
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n', `${safe}.json`), 'utf8'));
});

handle('settings:get', () => settings.get());
handle('settings:set', (patch) => settings.update(patch));

handle('profiles:list', () => profiles.list());
handle('profiles:create', (data) => profiles.create(data));
handle('profiles:update', (id, patch) => profiles.update(id, patch));
handle('profiles:duplicate', (id, opts) => profiles.duplicate(id, opts));
handle('profiles:delete', (id, opts) => {
  if (games.isBusy(id)) {
    const err = new Error('running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  return profiles.remove(id, opts);
});

handle('versions:list', async ({ filters = {}, force = false } = {}) => {
  const installed = await listInstalled(layout);
  const installedIds = new Set(installed.map((v) => v.id));
  try {
    const manifest = await fetchManifest({ cacheDir: layout.cache, force });
    const list = filterVersions(manifest.versions, filters).map((v) => ({
      id: v.id, type: v.type, releaseTime: v.releaseTime, installed: installedIds.has(v.id),
    }));
    return { latest: manifest.latest, versions: list, offline: Boolean(manifest._offline) };
  } catch (err) {
    return {
      latest: null,
      versions: filterVersions(installed.map((v) => ({ ...v, installed: true })), { release: true, snapshot: true, old: true, query: filters.query }),
      offline: true,
      error: serializeError(err),
    };
  }
});

handle('games:status', () => games.status());
handle('games:logs', (profileId) => games.getLogs(profileId));

handle('game:launch', async (profileId) => {
  const profile = profiles.get(profileId);
  if (!profile) throw Object.assign(new Error('not found'), { code: 'PROFILE_NOT_FOUND' });
  if (!profile.versionId) throw Object.assign(new Error('no version'), { code: 'PROFILE_VERSION_REQUIRED' });
  if (repairs.has(profileId)) throw Object.assign(new Error('busy'), { code: 'ALREADY_RUNNING' });
  const s = settings.get();
  const session = await createSession(s.authType || 'offline', { username: s.username });
  const maxMem = profile.memoryMaxMb || s.defaultMemoryMb;
  const javaPath = profile.java.mode === 'custom' ? profile.java.path : (s.defaultJavaPath || null);
  return games.start({
    profileId,
    versionId: profile.versionId,
    gameDir: profile.gameDir,
    launchOptions: {
      layout,
      session,
      memory: { min: Math.min(512, maxMem), max: maxMem },
      resolution: profile.resolution,
      javaPath,
      extraJvmArgs: parseArgString(profile.jvmArgs),
      concurrency: s.concurrency,
      detached: s.onGameStart === 'close',
    },
  });
});
handle('game:cancel', (profileId) => {
  if (repairs.has(profileId)) { repairs.get(profileId).abort(); return true; }
  return games.cancel(profileId);
});
handle('game:kill', (profileId) => games.kill(profileId));

handle('profile:repair', async (profileId) => {
  const profile = profiles.get(profileId);
  if (!profile || !profile.versionId) throw Object.assign(new Error('no version'), { code: 'PROFILE_VERSION_REQUIRED' });
  if (games.isBusy(profileId) || repairs.has(profileId)) throw Object.assign(new Error('busy'), { code: 'ALREADY_RUNNING' });
  const controller = new AbortController();
  repairs.set(profileId, controller);
  send('game:state', { profileId, state: 'repairing' });
  try {
    const s = settings.get();
    const result = await repairVersion({
      layout,
      versionId: profile.versionId,
      gameDir: profile.gameDir,
      concurrency: s.concurrency,
      skipJava: profile.java.mode === 'custom',
      signal: controller.signal,
      onProgress: (p) => send('game:progress', { profileId, ...p }),
      onLog: (line) => games.pushLog(profileId, line, 'launcher'),
    });
    send('game:state', { profileId, state: 'repaired', result });
    return result;
  } catch (err) {
    send('game:state', err.cancelled ? { profileId, state: 'cancelled' } : { profileId, state: 'error', error: serializeError(err) });
    throw err;
  } finally {
    repairs.delete(profileId);
  }
});

handle('shell:openDataDir', () => shell.openPath(layout.root));
handle('shell:openProfileDir', (profileId) => {
  const p = profiles.get(profileId);
  fs.mkdirSync(p.gameDir, { recursive: true });
  return shell.openPath(p.gameDir);
});
handle('shell:openCrashReports', (profileId) => {
  const p = profiles.get(profileId);
  const dir = path.join(p.gameDir, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
handle('dialog:pickJava', async () => {
  const filters = process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    sweepStaleNativesDirs(layout.nativesTmp).catch(() => {});
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    games.shutdown();
    for (const c of repairs.values()) c.abort();
    if (process.platform !== 'darwin') app.quit();
  });
}
