'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig, updateRepo, DEB_DEPENDS } = require('../../scripts/builder-config');
const { updateSupport, updateErrorState, isConfigured, macBundleSigned, windowsInstalled } = require('../../src/main/updater');
const pkg = require('../../package.json');

const root = path.join(__dirname, '..', '..');

test('builder config: ids, artifacts, icons and targets for every OS', () => {
  const c = buildConfig({});
  assert.equal(c.appId, 'io.github.forja.launcher');
  assert.equal(c.productName, 'Forja Launcher');
  assert.ok(!/\s/.test(c.artifactName), 'artifact names without spaces');
  assert.match(c.artifactName, /\$\{version\}.*\$\{os\}.*\$\{arch\}/);
  for (const f of [c.win.icon, c.mac.icon, c.mac.entitlements, c.nsis.installerIcon]) assert.ok(fs.existsSync(path.join(root, f)), f);
  for (const s of [16, 32, 48, 128, 256, 512]) assert.ok(fs.existsSync(path.join(root, c.linux.icon, `${s}x${s}.png`)), `${s}px`);
  assert.deepEqual(c.win.target.map((t) => t.target), ['nsis', 'zip']);
  assert.deepEqual(c.mac.target.map((t) => t.target), ['dmg', 'zip']);
  for (const t of c.mac.target) assert.deepEqual(t.arch, ['x64', 'arm64']);
  assert.deepEqual(c.linux.target.map((t) => t.target), ['AppImage', 'deb', 'tar.gz']);
  assert.equal(c.mac.category, 'public.app-category.games');
  // NSIS: per-user, shortcuts, ru + en, keeps user data
  assert.equal(c.nsis.perMachine, false);
  assert.equal(c.nsis.oneClick, false);
  assert.ok(c.nsis.createDesktopShortcut && c.nsis.createStartMenuShortcut);
  assert.deepEqual(c.nsis.installerLanguages, ['ru_RU', 'en_US']);
  assert.equal(c.nsis.deleteAppDataOnUninstall, false);
  // deb runtime deps for Electron and the game
  for (const d of ['libegl1', 'libgl1', 'libxtst6', 'libxss1', 'libnss3', 'libgbm1']) assert.ok(DEB_DEPENDS.some((x) => x.split(' | ').includes(d)), d);
  assert.ok(c.deb.recommends.includes('libopenal1'));
  assert.ok(fs.existsSync(path.join(root, c.afterPack)));
});

test('builder config: signing and notarization are opt-in via env only', () => {
  const unsigned = buildConfig({});
  assert.equal(unsigned.mac.identity, null, 'no certificate → no signing identity lookup');
  assert.equal(unsigned.mac.notarize, false);
  assert.equal(unsigned.mac.hardenedRuntime, true);
  const signed = buildConfig({ CSC_LINK: 'x.p12' });
  assert.ok(!('identity' in signed.mac));
  assert.equal(signed.mac.notarize, false, 'notarize needs Apple credentials too');
  const notarized = buildConfig({ CSC_LINK: 'x.p12', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'T123' });
  assert.deepEqual(notarized.mac.notarize, { teamId: 'T123' });
});

test('update repo: single place in package.json, env override, placeholder disables publish', () => {
  assert.deepEqual(updateRepo({}), pkg.forja.updates);
  const c = buildConfig({});
  assert.deepEqual(c.publish, [{ provider: 'github', owner: pkg.forja.updates.owner, repo: pkg.forja.updates.repo, releaseType: 'release' }]);
  assert.deepEqual(c.extraMetadata.forja.updates, pkg.forja.updates);
  const o = buildConfig({ FORJA_UPDATE_REPO: 'someone/fork' });
  assert.equal(o.publish[0].owner, 'someone');
  assert.deepEqual(o.extraMetadata.forja.updates, { owner: 'someone', repo: 'fork' });
  assert.deepEqual(updateRepo({ FORJA_UPDATE_REPO: 'not a repo' }), pkg.forja.updates, 'invalid override ignored');
  assert.equal(buildConfig({ FORJA_UPDATE_REPO: 'OWNER/forja' }).publish, null);
});

test('auto-update support decision', () => {
  const updates = { owner: 'zhekanisher7-rgb', repo: 'Forja-launcher' };
  const base = { isPackaged: true, updates, env: {} };
  assert.deepEqual(updateSupport({ ...base, isPackaged: false, platform: 'win32' }), { enabled: false, reason: 'dev' });
  assert.equal(updateSupport({ ...base, platform: 'win32', winInstalled: true, env: { FORJA_DISABLE_UPDATES: '1' } }).reason, 'disabledByEnv');
  assert.equal(updateSupport({ ...base, platform: 'win32', winInstalled: true, updates: { owner: 'OWNER', repo: 'x' } }).reason, 'notConfigured');
  assert.equal(updateSupport({ ...base, platform: 'win32', winInstalled: true, updates: { owner: '', repo: '' } }).reason, 'notConfigured');
  assert.deepEqual(updateSupport({ ...base, platform: 'win32', winInstalled: true }), { enabled: true, reason: null });
  assert.equal(updateSupport({ ...base, platform: 'win32', winInstalled: false }).reason, 'unsupportedPackage', 'portable zip');
  assert.equal(updateSupport({ ...base, platform: 'darwin', macSigned: false }).reason, 'macUnsigned');
  assert.equal(updateSupport({ ...base, platform: 'darwin', macSigned: true }).enabled, true);
  assert.equal(updateSupport({ ...base, platform: 'linux' }).reason, 'unsupportedPackage', 'deb / tar.gz');
  assert.equal(updateSupport({ ...base, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } }).enabled, true);
  assert.equal(isConfigured({ owner: 'a b', repo: 'c' }), false);
});

test('macOS signature and Windows install detection', () => {
  const fake = (status, out) => () => ({ status, stdout: '', stderr: out });
  const exe = '/Applications/Forja Launcher.app/Contents/MacOS/Forja Launcher';
  assert.equal(macBundleSigned(exe, fake(0, 'Signature=adhoc\nTeamIdentifier=not set\n')), false);
  assert.equal(macBundleSigned(exe, fake(1, 'code object is not signed at all')), false);
  assert.equal(macBundleSigned(exe, fake(0, 'Authority=Developer ID Application: X (ABCDE12345)\nTeamIdentifier=ABCDE12345\n')), true);
  assert.equal(macBundleSigned('/usr/bin/node', fake(0, 'TeamIdentifier=ABCDE12345')), false);
  const dir = 'C:\\Users\\u\\AppData\\Local\\Programs\\forja-launcher';
  const seen = [];
  assert.equal(windowsInstalled(path.join(dir, 'Forja Launcher.exe'), 'Forja Launcher', (p) => { seen.push(p); return true; }), true);
  assert.match(seen[0], /Uninstall Forja Launcher\.exe$/);
  assert.equal(windowsInstalled(path.join(dir, 'Forja Launcher.exe'), 'Forja Launcher', () => false), false);
});

test('update errors: "no releases yet" is a normal state, other errors are shortened', () => {
  assert.deepEqual(updateErrorState(new Error('No published versions on GitHub')), { state: 'noReleases', error: null });
  assert.equal(updateErrorState(new Error('HttpError: 404 \n"method: GET url: https://github.com/x/y/releases.atom"')).state, 'noReleases');
  const e = updateErrorState(new Error(`net::ERR_INTERNET_DISCONNECTED\n${'x'.repeat(1000)}`));
  assert.equal(e.state, 'error');
  assert.equal(e.error, 'net::ERR_INTERNET_DISCONNECTED');
});
