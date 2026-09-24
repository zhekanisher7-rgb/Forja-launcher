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
const { repairProfile } = require('./core/repair');
const { classifyError } = require('./core/errors');
const { createSession, providers } = require('./auth');
const { listLoaderVersions, LoaderRegistry, LOADER_TYPES } = require('./core/loaders');
const { ModrinthClient, primaryFile, loadersFor, CONTENT_TYPES } = require('./core/modrinth');
const content = require('./core/content');
const { installMrpack } = require('./core/mrpack');
const storage = require('./core/storage');
const { downloadAll } = require('./core/download');
const os = require('node:os');

const layout = createLayout();
fs.mkdirSync(layout.root, { recursive: true });
const settings = new Settings(layout.settingsFile);
const profiles = new ProfileStore(layout, { legacy: settings.legacy });
const games = new GameManager({ launchFn: prepareAndLaunch });
const repairs = new Map(); // profileId -> AbortController
const modrinth = new ModrinthClient();
const contentTasks = new Map(); // profileId -> AbortController (mod installs/updates)
let modpackTask = null;
let lastCleanupPlan = null;
const coded = (code, msg = code) => Object.assign(new Error(msg), { code });
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
      loader: profile.loader,
      // "Latest stable" resolves once and is then pinned, so mods don't break on loader updates
      onLoaderResolved: ({ loaderVersion }) => {
        const cur = profiles.get(profileId);
        if (cur && cur.loader && cur.loader.type !== 'vanilla' && !cur.loader.version && loaderVersion) {
          profiles.update(profileId, { loader: { type: cur.loader.type, version: loaderVersion } });
          send('profiles:changed', profiles.list());
        }
      },
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
    const result = await repairProfile({
      layout,
      profile,
      concurrency: s.concurrency,
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

// ---- mod loaders ----
handle('loaders:versions', async (type, mcVersion) => {
  if (!LOADER_TYPES.includes(type) || type === 'vanilla' || !mcVersion) return [];
  const list = await listLoaderVersions(type, String(mcVersion));
  return list.slice(0, 200);
});

// ---- Modrinth content ----
function profileOr404(profileId) {
  const p = profiles.get(profileId);
  if (!p) throw coded('PROFILE_NOT_FOUND');
  return p;
}
function checkType(type) {
  if (!CONTENT_TYPES[type]) throw coded('UNSAFE_PATH', `bad type ${type}`);
  return type;
}
const loaderOf = (p) => (p.loader && p.loader.type) || 'vanilla';

handle('modrinth:search', async ({ query = '', type = 'mod', profileId, category = null, index = 'relevance', offset = 0, limit = 20, ignoreProfile = false } = {}) => {
  const p = profileId ? profiles.get(profileId) : null;
  const allowed = ['mod', 'resourcepack', 'shader', 'modpack'];
  const t = allowed.includes(type) ? type : 'mod';
  const res = await modrinth.search({
    query: String(query).slice(0, 200), type: t, category, index, offset: Math.max(0, Number(offset) || 0), limit: Math.min(50, Number(limit) || 20),
    gameVersion: p && !ignoreProfile && t !== 'modpack' ? p.versionId : undefined,
    loader: p && !ignoreProfile && t === 'mod' ? loaderOf(p) : undefined,
  });
  return res;
});
handle('modrinth:categories', async () => (await modrinth.categories()) || []);
handle('modrinth:project', async ({ id, profileId, type } = {}) => {
  const p = profileId ? profiles.get(profileId) : null;
  const project = await modrinth.project(id);
  if (!project) throw coded('NO_COMPATIBLE_VERSION', 'project not found');
  const t = project.project_type === 'shader' ? 'shader' : project.project_type;
  const filterByProfile = p && t !== 'modpack';
  const versions = await modrinth.projectVersions(id, filterByProfile
    ? { loaders: loadersFor(type || t, loaderOf(p)), gameVersions: [p.versionId] } : {});
  return { project, versions: (versions || []).slice(0, 30), filtered: Boolean(filterByProfile) };
});
handle('content:list', async (profileId, type, { identify = true } = {}) => {
  const p = profileOr404(profileId);
  const list = await content.listContent(p.gameDir, checkType(type));
  if (!identify) return { items: list, offline: false };
  try {
    return { items: await content.identifyContent(modrinth, p.gameDir, list), offline: false };
  } catch (err) {
    return { items: list, offline: true, error: serializeError(err) };
  }
});
handle('content:toggle', async (profileId, type, file, enabled) => content.setEnabled(profileOr404(profileId).gameDir, checkType(type), file, Boolean(enabled)));
handle('content:remove', async (profileId, type, file) => content.removeContent(profileOr404(profileId).gameDir, checkType(type), file));
handle('content:install', async (profileId, type, projectId, versionId = null) => {
  const p = profileOr404(profileId);
  if (contentTasks.has(profileId)) throw coded('ALREADY_RUNNING');
  const controller = new AbortController();
  contentTasks.set(profileId, controller);
  try {
    return await content.installProject(modrinth, {
      gameDir: p.gameDir, type: checkType(type), projectId, versionId, loader: loaderOf(p), gameVersion: p.versionId, signal: controller.signal,
      onLog: (line) => games.pushLog(profileId, line, 'launcher'),
      onProgress: (pr) => send('content:progress', { profileId, ...pr }),
    });
  } finally {
    contentTasks.delete(profileId);
  }
});
handle('content:checkUpdates', async (profileId, type) => {
  const p = profileOr404(profileId);
  return content.checkUpdates(modrinth, p.gameDir, checkType(type), { loader: loaderOf(p), gameVersion: p.versionId });
});
handle('content:update', async (profileId, type, files = null) => {
  const p = profileOr404(profileId);
  if (contentTasks.has(profileId)) throw coded('ALREADY_RUNNING');
  const controller = new AbortController();
  contentTasks.set(profileId, controller);
  try {
    let updates = await content.checkUpdates(modrinth, p.gameDir, checkType(type), { loader: loaderOf(p), gameVersion: p.versionId, signal: controller.signal });
    if (Array.isArray(files)) updates = updates.filter((u) => files.includes(u.file));
    return await content.applyUpdates(modrinth, p.gameDir, type, updates, { signal: controller.signal, onLog: (line) => games.pushLog(profileId, line, 'launcher') });
  } finally {
    contentTasks.delete(profileId);
  }
});

// ---- Modpacks (.mrpack) ----
async function runModpackInstall(file, source) {
  if (modpackTask) throw coded('ALREADY_RUNNING');
  const controller = new AbortController();
  modpackTask = controller;
  try {
    const s = settings.get();
    const res = await installMrpack({
      file, profiles, signal: controller.signal, concurrency: s.concurrency, source,
      onProgress: (p) => send('modpack:progress', p),
      onLog: (line) => send('modpack:progress', { log: line }),
    });
    send('profiles:changed', profiles.list());
    return { profileId: res.profile.id, files: res.files, overrides: res.overrides, skipped: res.skipped.length };
  } finally {
    modpackTask = null;
  }
}
handle('modpack:importFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return runModpackInstall(r.filePaths[0], { type: 'file', name: path.basename(r.filePaths[0]) });
});
handle('modpack:installModrinth', async (projectId, versionId = null) => {
  let version = versionId ? await modrinth.version(versionId) : null;
  if (!version) {
    const list = await modrinth.projectVersions(projectId, {});
    version = (list || []).find((v) => v.version_type === 'release') || (list || [])[0];
  }
  if (!version) throw coded('NO_COMPATIBLE_VERSION');
  const f = primaryFile(version);
  if (!f || !/\.mrpack$/i.test(f.filename)) throw coded('MRPACK_INVALID', 'no .mrpack file');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-mrpack-'));
  const file = path.join(tmpDir, 'pack.mrpack');
  try {
    await downloadAll([{ url: f.url, path: file, sha1: f.hashes && f.hashes.sha1, size: f.size }], {
      onProgress: (p) => send('modpack:progress', { step: 'download', ...p }),
    });
    return await runModpackInstall(file, { type: 'modrinth', projectId, versionId: version.id });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
handle('modpack:cancel', () => { if (modpackTask) modpackTask.abort(); return true; });

// ---- Storage ----
handle('storage:usage', () => storage.usage(layout));
function busyVersions() {
  const st = games.status();
  return st.filter((g) => g.state !== 'exited');
}
handle('storage:plan', async () => {
  const running = busyVersions();
  const protect = new Set();
  const registry = new LoaderRegistry(layout);
  for (const g of running) {
    const p = profiles.get(g.profileId);
    if (p && p.versionId) protect.add(p.versionId);
  }
  const plan = await storage.planCleanup({ layout, profiles: profiles.list(), loaderEntries: registry.all(), protectVersions: protect });
  lastCleanupPlan = { plan, at: Date.now() };
  const summary = {};
  for (const it of plan.items) {
    summary[it.kind] = summary[it.kind] || { count: 0, bytes: 0 };
    summary[it.kind].count++;
    summary[it.kind].bytes += it.bytes;
  }
  return {
    totalBytes: plan.totalBytes, count: plan.items.length, summary, skipped: plan.skipped,
    versions: plan.items.filter((i) => i.kind === 'version').map((i) => ({ id: i.id, bytes: i.bytes })),
    runtimes: plan.items.filter((i) => i.kind === 'runtime').map((i) => ({ id: i.id, bytes: i.bytes })),
  };
});
handle('storage:clean', async () => {
  if (busyVersions().length || repairs.size || modpackTask) throw coded('CLEANUP_BUSY');
  if (!lastCleanupPlan || Date.now() - lastCleanupPlan.at > 10 * 60 * 1000) throw coded('CLEANUP_STALE');
  // Re-plan right before deleting and only delete items present in both plans
  const registry = new LoaderRegistry(layout);
  const fresh = await storage.planCleanup({ layout, profiles: profiles.list(), loaderEntries: registry.all() });
  const approved = new Set(lastCleanupPlan.plan.items.map((i) => i.path));
  const plan = { ...fresh, items: fresh.items.filter((i) => approved.has(i.path)) };
  // Drop registry entries of deleted loader versions
  const deletedVersions = new Set(plan.items.filter((i) => i.kind === 'version').map((i) => i.id));
  for (const e of registry.all()) if (deletedVersions.has(e.versionId)) registry.remove(e.key);
  const res = await storage.executeCleanup(layout, plan);
  lastCleanupPlan = null;
  return res;
});

handle('shell:openModrinth', (slugOrId, type = 'mod') => {
  const safe = String(slugOrId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const t = ['mod', 'resourcepack', 'shader', 'modpack'].includes(type) ? type : 'mod';
  if (!safe) return false;
  return shell.openExternal(`https://modrinth.com/${t}/${safe}`);
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
