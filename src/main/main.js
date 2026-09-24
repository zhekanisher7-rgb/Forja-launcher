'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const config = require('./config');
const { createLayout } = require('./core/paths');
const { fetchManifest, filterVersions, listInstalled } = require('./core/versions');
const { prepareAndLaunch } = require('./core/launcher');
const { createSession, providers } = require('./auth');
const { Settings, totalMemoryMb } = require('./settings');

const layout = createLayout();
const settings = new Settings(layout.settingsFile);
let win = null;
let job = null; // { controller, child }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    title: config.name,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    show: false,
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

// ---- IPC ----
ipcMain.handle('app:info', () => ({
  name: config.name,
  version: config.version,
  platform: process.platform,
  arch: process.arch,
  dataDir: layout.root,
  totalMemoryMb: totalMemoryMb(),
  auth: Object.values(providers).map((p) => ({ id: p.id, available: p.available })),
}));

ipcMain.handle('i18n:get', (_e, lang) => {
  const safe = ['ru', 'en'].includes(lang) ? lang : config.defaultLanguage;
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n', `${safe}.json`), 'utf8'));
});

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => settings.update(patch));

ipcMain.handle('versions:list', async (_e, { filters = {}, force = false } = {}) => {
  const installed = await listInstalled(layout);
  const installedIds = new Set(installed.map((v) => v.id));
  try {
    const manifest = await fetchManifest({ cacheDir: layout.cache, force });
    const list = filterVersions(manifest.versions, filters).map((v) => ({
      id: v.id, type: v.type, releaseTime: v.releaseTime, installed: installedIds.has(v.id),
    }));
    return { latest: manifest.latest, versions: list, offline: Boolean(manifest._offline) };
  } catch (err) {
    // No network and no cache: show installed versions only
    return {
      latest: null,
      versions: filterVersions(installed.map((v) => ({ ...v, installed: true })), { ...filters, release: true, snapshot: true, old: true }),
      offline: true,
      error: err.message,
    };
  }
});

ipcMain.handle('game:launch', async (_e, opts) => {
  if (job) return { ok: false, error: 'busy' };
  const controller = new AbortController();
  job = { controller, child: null };
  send('game:state', { state: 'preparing' });
  try {
    const s = settings.get();
    const session = await createSession(opts.authType || 'offline', { username: opts.username });
    const extraJvmArgs = String(s.extraJvmArgs || '').split(/\s+/).filter(Boolean);
    const { child, exited } = await prepareAndLaunch({
      layout,
      versionId: opts.versionId,
      session,
      memory: { min: Math.min(512, opts.memoryMaxMb), max: opts.memoryMaxMb },
      resolution: s.resolution,
      javaPath: s.javaPath || null,
      extraJvmArgs,
      signal: controller.signal,
      onProgress: (p) => send('game:progress', p),
      onLog: (line) => send('game:log', { line, source: 'launcher' }),
      onGameLog: (line, stream) => send('game:log', { line, source: stream }),
    });
    job.child = child;
    send('game:state', { state: 'running', pid: child.pid });
    exited.then((r) => {
      send('game:state', { state: 'exited', code: r.code, signal: r.signal });
      job = null;
    }).catch((err) => {
      send('game:state', { state: 'error', error: err.message });
      job = null;
    });
    return { ok: true };
  } catch (err) {
    const cancelled = Boolean(err && err.cancelled);
    send('game:state', cancelled ? { state: 'cancelled' } : { state: 'error', error: err.message, code: err.code });
    job = null;
    return { ok: false, cancelled, error: err.message, code: err.code };
  }
});

ipcMain.handle('game:cancel', () => {
  if (!job) return false;
  job.controller.abort();
  return true;
});

ipcMain.handle('game:kill', () => {
  if (job && job.child) {
    job.child.kill();
    return true;
  }
  return false;
});

ipcMain.handle('app:openDataDir', () => {
  fs.mkdirSync(layout.root, { recursive: true });
  return shell.openPath(layout.root);
});

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (job && job.controller) job.controller.abort();
    if (process.platform !== 'darwin') app.quit();
  });
}
