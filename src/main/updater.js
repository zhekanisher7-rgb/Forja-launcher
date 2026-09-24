'use strict';
/**
 * Auto-update via electron-updater against GitHub Releases
 * (owner/repo from config.updates ← package.json "forja.updates").
 *
 * Enabled only when it can actually work; otherwise the reason is reported
 * to the UI and nothing is downloaded:
 *  - dev run (not packaged)              → 'dev'
 *  - FORJA_DISABLE_UPDATES=1             → 'disabledByEnv'
 *  - owner/repo not set / placeholder    → 'notConfigured'
 *  - macOS build without a real signature (unsigned / ad-hoc): Squirrel.Mac
 *    refuses unsigned updates            → 'macUnsigned'
 *  - Linux other than AppImage (deb, tar.gz), Windows portable zip
 *                                         → 'unsupportedPackage'
 * Installing an update never happens while a game is running.
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const PLACEHOLDERS = new Set(['', 'owner', 'your-name', 'your-github-user', 'change-me']);

function isConfigured(updates) {
  const owner = String((updates && updates.owner) || '').trim();
  const repo = String((updates && updates.repo) || '').trim();
  return Boolean(owner && repo && !PLACEHOLDERS.has(owner.toLowerCase()) && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo));
}

/** Is this macOS app bundle signed with a real (non ad-hoc) Developer ID? */
function macBundleSigned(execPath, run = spawnSync) {
  const bundle = execPath.replace(/(\.app)\/Contents\/MacOS\/.*$/, '$1');
  if (!bundle.endsWith('.app')) return false;
  const r = run('codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) return false;
  if (/Signature=adhoc/i.test(out)) return false;
  const team = /TeamIdentifier=(\S+)/.exec(out);
  return Boolean(team && team[1] !== 'not' && team[1] !== 'not set');
}

/** Windows: installed by NSIS (has an uninstaller next to the exe) vs portable zip. */
function windowsInstalled(execPath, productName, exists = fs.existsSync) {
  return exists(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`));
}

/**
 * Pure decision: can auto-update run here?
 * @returns {{enabled: boolean, reason: string|null}}
 */
function updateSupport({ isPackaged, platform, env = {}, updates, macSigned = false, winInstalled = false }) {
  if (!isPackaged) return { enabled: false, reason: 'dev' };
  if (env.FORJA_DISABLE_UPDATES === '1') return { enabled: false, reason: 'disabledByEnv' };
  if (!isConfigured(updates)) return { enabled: false, reason: 'notConfigured' };
  if (platform === 'darwin' && !macSigned) return { enabled: false, reason: 'macUnsigned' };
  if (platform === 'linux' && !env.APPIMAGE) return { enabled: false, reason: 'unsupportedPackage' };
  if (platform === 'win32' && !winInstalled) return { enabled: false, reason: 'unsupportedPackage' };
  return { enabled: true, reason: null };
}

/** Map an electron-updater error to a UI state (no releases yet is not an error). */
function updateErrorState(e) {
  const msg = String((e && e.message) || e || '');
  if (/No published versions on GitHub|Unable to find latest version on GitHub|HttpError: 404/i.test(msg)) {
    return { state: 'noReleases', error: null };
  }
  return { state: 'error', error: msg.split('\n')[0].slice(0, 300) };
}

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.app electron app
   * @param {{owner, repo}} o.updates
   * @param {string} o.productName
   * @param {() => boolean} o.canInstall returns false while games are running
   * @param {(line: string) => void} [o.log]
   */
  constructor({ app, updates, productName, canInstall = () => true, log = () => {} }) {
    super();
    this.app = app;
    this.updates = updates;
    this.productName = productName;
    this.canInstall = canInstall;
    this.log = log;
    this.autoUpdater = null;
    this.timer = null;
    const platform = process.platform;
    const isPackaged = Boolean(app && app.isPackaged);
    this.support = updateSupport({
      isPackaged,
      platform,
      env: process.env,
      updates,
      macSigned: isPackaged && platform === 'darwin' ? macBundleSigned(process.execPath) : false,
      winInstalled: isPackaged && platform === 'win32' ? windowsInstalled(process.execPath, productName) : false,
    });
    this.state = { state: this.support.enabled ? 'idle' : 'disabled', reason: this.support.reason, version: null, percent: 0, error: null };
  }

  status() {
    return { ...this.state, current: this.app ? this.app.getVersion() : null, repo: isConfigured(this.updates) ? `${this.updates.owner}/${this.updates.repo}` : null };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.status());
  }

  /** Start background checks (first after a short delay, then every 6 h). */
  start({ firstDelayMs = 15000, intervalMs = 6 * 3600 * 1000 } = {}) {
    if (!this.support.enabled) return false;
    // Loaded lazily: dev runs and unsupported packages never touch electron-updater.
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = { info: (m) => this.log(`[update] ${m}`), warn: (m) => this.log(`[update] ${m}`), error: (m) => this.log(`[update] ${m}`), debug: () => {} };
    autoUpdater.setFeedURL({ provider: 'github', owner: this.updates.owner, repo: this.updates.repo, releaseType: 'release' });
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i && i.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'upToDate' }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'downloaded', version: i && i.version, percent: 100 }));
    autoUpdater.on('error', (e) => this.set(updateErrorState(e)));
    this.timer = setTimeout(() => {
      this.check().catch(() => {});
      this.timer = setInterval(() => this.check().catch(() => {}), intervalMs);
      if (this.timer.unref) this.timer.unref();
    }, firstDelayMs);
    if (this.timer.unref) this.timer.unref();
    return true;
  }

  async check() {
    if (!this.autoUpdater) return this.status();
    if (['checking', 'downloading', 'downloaded'].includes(this.state.state)) return this.status();
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (e) {
      this.set(updateErrorState(e));
    }
    return this.status();
  }

  /** Restart into the downloaded update (refused while a game is running). */
  install() {
    if (!this.autoUpdater || this.state.state !== 'downloaded') {
      throw Object.assign(new Error('no update'), { code: 'UPDATE_NOT_READY' });
    }
    if (!this.canInstall()) throw Object.assign(new Error('game running'), { code: 'UPDATE_GAME_RUNNING' });
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return true;
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { Updater, updateSupport, updateErrorState, isConfigured, macBundleSigned, windowsInstalled };
