'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, SCHEMA_VERSION } = require('../../src/main/core/settings');
const { createNativesDir, cleanupNativesDir, sweepStaleNativesDirs, writeOwner } = require('../../src/main/core/natives');
const { parseArgString } = require('../../src/main/core/launch');
const { classifyError } = require('../../src/main/core/errors');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('settings: defaults, persistence, sanitizing', () => {
  const file = path.join(tmp('forja-set-'), 'settings.json');
  const s = new Settings(file);
  assert.equal(s.get().language, 'ru');
  assert.equal(s.get().onGameStart, 'keep');
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
