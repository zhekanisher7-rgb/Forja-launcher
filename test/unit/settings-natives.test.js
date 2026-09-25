'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, SCHEMA_VERSION, sanitize, DEFAULTS } = require('../../src/main/core/settings');
const { createNativesDir, cleanupNativesDir, sweepStaleNativesDirs, writeOwner } = require('../../src/main/core/natives');
const { extractNatives } = require('../../src/main/core/install');
const AdmZip = require('adm-zip');
const { parseArgString } = require('../../src/main/core/launch');
const { classifyError } = require('../../src/main/core/errors');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('settings: defaults, persistence, sanitizing', () => {
  const file = path.join(tmp('forja-set-'), 'settings.json');
  const s = new Settings(file);
  assert.equal(s.get().language, 'ru');
  assert.equal(s.get().onGameStart, 'keep');
  assert.equal(s.get().glowColor, '#e5534b');
  assert.equal(s.get().glowStrength, 70);
  assert.equal(s.get().glowDurationSec, 3.5);
  assert.equal(s.get().glowAnimations, true);
  assert.equal(s.get().performanceMode, true);
  s.update({ language: 'en', concurrency: 99, onGameStart: 'hide', defaultMemoryMb: 3072, showSnapshots: 1, bogus: 1 });
  const r = new Settings(file).get();
  assert.equal(r.language, 'en');
  assert.equal(r.concurrency, 32, 'clamped');
  assert.equal(r.onGameStart, 'hide');
  assert.equal(r.defaultMemoryMb, 3072);
  assert.equal(r.showSnapshots, true);
  assert.equal(r.bogus, undefined);
  s.update({ onGameStart: 'explode', language: 'de', concurrency: 0 });
  assert.equal(s.get().onGameStart, 'keep');
  assert.equal(s.get().language, 'ru');
  assert.equal(s.get().concurrency, 1);
});


test('settings: glow fields sanitize and persist', () => {
  const file = path.join(tmp('forja-glow-'), 'settings.json');
  const s = new Settings(file);
  s.update({
    glowColor: '#5B9DFF',
    glowStrength: 150,
    glowDurationSec: 0.5,
    glowAnimations: 0,
  });
  let d = s.get();
  assert.equal(d.glowColor, '#5b9dff');
  assert.equal(d.glowStrength, 100);
  assert.equal(d.glowDurationSec, 1.5);
  assert.equal(d.glowAnimations, false);
  s.update({ glowColor: 'red', glowStrength: -10, glowDurationSec: 99, glowAnimations: 1 });
  d = s.get();
  assert.equal(d.glowColor, DEFAULTS.glowColor);
  assert.equal(d.glowStrength, 0);
  assert.equal(d.glowDurationSec, 8);
  assert.equal(d.glowAnimations, true);
  const filled = sanitize({ schemaVersion: SCHEMA_VERSION });
  assert.equal(filled.glowColor, DEFAULTS.glowColor);
  assert.equal(filled.glowStrength, DEFAULTS.glowStrength);
  assert.equal(filled.glowDurationSec, DEFAULTS.glowDurationSec);
  assert.equal(filled.glowAnimations, true);
  const r = new Settings(file).get();
  assert.equal(r.glowColor, DEFAULTS.glowColor);
  assert.equal(r.glowStrength, 0);
  assert.equal(r.glowDurationSec, 8);
  assert.equal(r.glowAnimations, true);
});

test('settings: migrates phase-1 (v1) file', () => {
  const file = path.join(tmp('forja-set-'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    language: 'ru', username: 'ForjaUI', authType: 'offline', memoryMaxMb: 3072, selectedVersion: '1.16.5',
    filters: { release: true, snapshot: true, old: false }, resolution: null, javaPath: null, extraJvmArgs: '-Dfoo=1',
  }));
  const s = new Settings(file);
  const d = s.get();
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.equal(d.defaultMemoryMb, 3072);
  assert.equal(d.showSnapshots, true);
  assert.equal(d.username, 'ForjaUI');
  assert.equal(d.memoryMaxMb, undefined);
  assert.deepEqual(s.legacy, { selectedVersion: '1.16.5', extraJvmArgs: '-Dfoo=1', resolution: null });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, SCHEMA_VERSION, 'rewritten');
});

test('natives: unique dir per launch, owner file, cleanup', async () => {
  const base = tmp('forja-nat-');
  const a = await createNativesDir(base, '1.20.1');
  const b = await createNativesDir(base, '1.20.1');
  assert.notEqual(a, b, 'two launches of the same version get different dirs');
  assert.ok(path.basename(a).startsWith('1.20.1-'));
  const owner = JSON.parse(fs.readFileSync(path.join(a, '.forja-owner.json'), 'utf8'));
  assert.equal(owner.launcherPid, process.pid);
  fs.writeFileSync(path.join(a, 'liblwjgl.so'), 'x');
  await cleanupNativesDir(a);
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(b));
  const weird = await createNativesDir(base, '../../evil version');
  assert.equal(path.dirname(weird), base, 'version id cannot escape base dir');
});

test('natives: sweep removes stale dirs only', async () => {
  const base = tmp('forja-sweep-');
  const stale = await createNativesDir(base, 'old');
  await writeOwner(stale, { launcherPid: 999991, gamePid: 999992, created: Date.now() - 3600e3 });
  const liveGame = await createNativesDir(base, 'live');
  await writeOwner(liveGame, { launcherPid: 999991, gamePid: 424242, created: Date.now() - 3600e3 });
  const fresh = await createNativesDir(base, 'fresh');
  const removed = await sweepStaleNativesDirs(base, { isAlive: (pid) => pid === 424242 });
  assert.deepEqual(removed, [stale]);
  assert.ok(fs.existsSync(liveGame));
  assert.ok(fs.existsSync(fresh));
});

test('parseArgString handles quotes', () => {
  assert.deepEqual(parseArgString('-Xss2M  -Dfoo="a b" \'-Dbar=c d\' -Dempty=""'), ['-Xss2M', '-Dfoo=a b', '-Dbar=c d', '-Dempty=']);
  assert.deepEqual(parseArgString(''), []);
  assert.deepEqual(parseArgString('  '), []);
});

test('classifyError maps to friendly codes', () => {
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ENOSPC', neededBytes: 5e8, freeBytes: 1e8 })).code, 'disk');
  assert.equal(classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code, 'network');
  assert.equal(classifyError(new Error('stalled')).code, 'network');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'EACCES', path: '/x' })).params.path, '/x');
  assert.equal(classifyError(new Error('SHA1 mismatch for u')).code, 'checksum');
  assert.equal(classifyError(Object.assign(new Error('HTTP 404 for u'), { status: 404 })).code, 'notFound');
  assert.equal(classifyError(Object.assign(new Error('c'), { cancelled: true })).code, 'cancelled');
  assert.equal(classifyError(new Error('???')).code, 'unknown');
});

test('extractNatives: shared cache + parallel extract, launch dir is a copy not the cache', async () => {
  const base = tmp('forja-natcache-');
  const cacheBase = path.join(base, 'cache');
  const jar = path.join(base, 'natives.jar');
  const zip = new AdmZip();
  zip.addFile('libfoo.so', Buffer.from('SO_CONTENT'));
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('x'));
  zip.writeZip(jar);
  const resolved = [{ native: { path: jar }, extract: { exclude: ['META-INF/'] } }];
  const launch1 = path.join(base, 'launch1');
  const n1 = await extractNatives(resolved, launch1, { cacheBase, versionId: '1.20.1' });
  assert.equal(n1, 1);
  assert.ok(fs.existsSync(path.join(launch1, 'libfoo.so')));
  const caches = fs.readdirSync(cacheBase);
  assert.equal(caches.length, 1);
  const cacheDir = path.join(cacheBase, caches[0]);
  assert.ok(fs.existsSync(path.join(cacheDir, '.forja-natives-ok')));
  assert.notEqual(path.resolve(launch1), path.resolve(cacheDir));

  const launch2 = path.join(base, 'launch2');
  const n2 = await extractNatives(resolved, launch2, { cacheBase, versionId: '1.20.1' });
  assert.equal(n2, 1);
  assert.equal(fs.readFileSync(path.join(launch2, 'libfoo.so'), 'utf8'), 'SO_CONTENT');
  // still a single cache dir
  assert.equal(fs.readdirSync(cacheBase).length, 1);
});


test('settings: appearance / ui-pack fields sanitize and persist', () => {
  const file = path.join(tmp('forja-ui-'), 'settings.json');
  const s = new Settings(file);
  s.update({
    theme: 'oled',
    uiScale: 110,
    heroBackground: 'https://example.com/bg.png',
    heroBlur: 99,
    heroDim: -5,
    uiSounds: 1,
    onboardingDone: 1,
    favoriteMods: ['a', 'a', 'b', ''],
    modSearchHistory: [' sodium ', '', 'iris', 'sodium'],
  });
  let d = s.get();
  assert.equal(d.theme, 'oled');
  assert.equal(d.uiScale, 110);
  assert.equal(d.heroBackground, 'https://example.com/bg.png');
  assert.equal(d.heroBlur, 40);
  assert.equal(d.heroDim, 0);
  assert.equal(d.uiSounds, true);
  assert.equal(d.performanceMode, true); // default ON; not cleared by unrelated update
  assert.equal(d.onboardingDone, true);
  assert.deepEqual(d.favoriteMods, ['a', 'b']);
  assert.deepEqual(d.modSearchHistory, ['sodium', 'iris']);
  s.update({ theme: 'neon', uiScale: 50, heroBlur: 'x', favoriteMods: 'nope', modSearchHistory: null });
  d = s.get();
  assert.equal(d.theme, DEFAULTS.theme);
  assert.equal(d.uiScale, DEFAULTS.uiScale);
  assert.equal(d.heroBlur, DEFAULTS.heroBlur);
  assert.deepEqual(d.favoriteMods, []);
  assert.deepEqual(d.modSearchHistory, []);
  const filled = sanitize({ schemaVersion: SCHEMA_VERSION });
  assert.equal(filled.theme, DEFAULTS.theme);
  assert.equal(filled.uiScale, DEFAULTS.uiScale);
  assert.equal(filled.onboardingDone, false);
  assert.equal(filled.uiSounds, false);
  assert.equal(filled.performanceMode, true);
  assert.equal(DEFAULTS.performanceMode, true);
  s.update({ performanceMode: 0 });
  assert.equal(s.get().performanceMode, false);
  s.update({ performanceMode: 1 });
  assert.equal(s.get().performanceMode, true);
  assert.equal(new Settings(file).get().theme, DEFAULTS.theme);
});
