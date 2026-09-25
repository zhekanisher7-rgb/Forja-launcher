'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLayout } = require('../../src/main/core/paths');
const { ProfileStore, normalizeProfile, slugify, SCHEMA_VERSION } = require('../../src/main/core/profiles');

function tmpLayout() {
  return createLayout(fs.mkdtempSync(path.join(os.tmpdir(), 'forja-prof-')));
}

test('first run migrates instances/default into a Default profile (phase-1 upgrade)', () => {
  const layout = tmpLayout();
  fs.mkdirSync(path.join(layout.root, 'instances', 'default'), { recursive: true });
  fs.writeFileSync(path.join(layout.root, 'instances', 'default', 'options.txt'), 'lang:en_us');
  const store = new ProfileStore(layout, { legacy: { selectedVersion: '1.16.5', extraJvmArgs: '-Dx=1', resolution: { width: 1280, height: 720 } } });
  assert.equal(store.migrated, true);
  const [p] = store.list();
  assert.equal(p.id, 'default');
  assert.equal(p.name, 'Default');
  assert.equal(p.versionId, '1.16.5');
  assert.equal(p.jvmArgs, '-Dx=1');
  assert.deepEqual(p.resolution, { width: 1280, height: 720, fullscreen: false });
  assert.equal(p.gameDir, path.join(layout.root, 'instances', 'default'));
  assert.ok(fs.existsSync(path.join(p.gameDir, 'options.txt')), 'existing files kept');
  const file = JSON.parse(fs.readFileSync(path.join(layout.root, 'profiles.json'), 'utf8'));
  assert.equal(file.schemaVersion, SCHEMA_VERSION);
  // second load: no re-migration
  const again = new ProfileStore(layout);
  assert.equal(again.migrated, false);
  assert.equal(again.list().length, 1);
});

test('create / update / duplicate / delete with separate game dirs, persisted', () => {
  const layout = tmpLayout();
  const store = new ProfileStore(layout);
  const a = store.create({ name: 'Выживание 1.20', versionId: '1.20.1', memoryMaxMb: 4096, icon: { type: 'preset', preset: 'gem', color: '#3b82f6' } });
  assert.match(a.id, /^vyzhivanie-1-20-[0-9a-f]{6}$/);
  assert.equal(a.gameDir, path.join(layout.root, 'instances', a.id));
  assert.ok(fs.existsSync(a.gameDir));
  assert.equal(a.memoryMaxMb, 4096);
  assert.equal(a.icon.preset, 'gem');
  const b = store.create({ name: 'PvP 1.8.9', versionId: '1.8.9', icon: { type: 'letter', letter: 'p', color: '#d9534f' } });
  assert.notEqual(a.gameDir, b.gameDir);
  assert.equal(b.icon.letter, 'P');

  const u = store.update(a.id, { name: 'Survival', resolution: { width: 1600, height: 900, fullscreen: true }, java: { mode: 'custom', path: '/opt/java/bin/java' }, jvmArgs: '-XX:+UseG1GC' });
  assert.equal(u.name, 'Survival');
  assert.equal(u.id, a.id, 'id stable on rename');
  assert.deepEqual(u.resolution, { width: 1600, height: 900, fullscreen: true });
  assert.deepEqual(u.java, { mode: 'custom', path: '/opt/java/bin/java' });
  assert.throws(() => store.update(a.id, { name: '  ' }), { code: 'PROFILE_NAME_REQUIRED' });
  assert.throws(() => store.update('nope', { name: 'x' }), { code: 'PROFILE_NOT_FOUND' });

  fs.writeFileSync(path.join(a.gameDir, 'options.txt'), 'x');
  const d1 = store.duplicate(a.id, { name: 'Survival (copy)' });
  assert.equal(d1.versionId, '1.20.1');
  assert.equal(d1.memoryMaxMb, 4096);
  assert.equal(d1.lastPlayed, null);
  assert.ok(!fs.existsSync(path.join(d1.gameDir, 'options.txt')), 'config-only duplicate');
  const d2 = store.duplicate(a.id, { copyFiles: true });
  assert.ok(fs.existsSync(path.join(d2.gameDir, 'options.txt')), 'duplicate with files');

  const touched = store.touch(b.id);
  assert.ok(Date.now() - new Date(touched.lastPlayed).getTime() < 5000);

  // persistence
  const reloaded = new ProfileStore(layout);
  assert.equal(reloaded.list().length, 5); // default + a + b + d1 + d2
  assert.equal(reloaded.get(a.id).name, 'Survival');
  assert.equal(reloaded.get(b.id).lastPlayed, touched.lastPlayed);

  store.remove(d2.id, { deleteFiles: true });
  assert.ok(!fs.existsSync(d2.gameDir));
  store.remove(d1.id);
  assert.ok(fs.existsSync(d1.gameDir), 'files kept unless requested');
  assert.equal(new ProfileStore(layout).list().length, 3);
});

test('cannot delete the last profile; create requires a version', () => {
  const store = new ProfileStore(tmpLayout());
  assert.throws(() => store.remove('default'), { code: 'PROFILE_LAST' });
  assert.throws(() => store.create({ name: 'x' }), { code: 'PROFILE_VERSION_REQUIRED' });
});

test('atomic writes: corrupt profiles.json falls back to .bak', () => {
  const layout = tmpLayout();
  const store = new ProfileStore(layout);
  store.create({ name: 'One', versionId: '1.20.1' });
  store.create({ name: 'Two', versionId: '1.20.1' }); // .bak now has default + One
  const file = path.join(layout.root, 'profiles.json');
  fs.writeFileSync(file, '{"schemaVersion":1,"profiles":[{"trunc');
  const recovered = new ProfileStore(layout);
  assert.equal(recovered.migrated, false);
  assert.deepEqual(recovered.list().map((p) => p.name), ['Default', 'One']);
  assert.ok(fs.readdirSync(layout.root).some((f) => f.startsWith('profiles.json.corrupt-')));
  assert.ok(!fs.readdirSync(layout.root).some((f) => f.endsWith('.tmp')), 'no temp files left');
});

test('normalizeProfile sanitizes input', () => {
  const p = normalizeProfile({ name: 'X', icon: { type: 'preset', preset: 'evil<script>', color: 'red' }, memoryMaxMb: 100, resolution: { width: 5, height: 'abc' } });
  assert.equal(p.icon.type, 'letter');
  assert.match(p.icon.color, /^#[0-9a-f]{6}$/i);
  assert.equal(p.memoryMaxMb, null);
  assert.deepEqual(p.resolution, { width: null, height: null, fullscreen: false });
  assert.deepEqual(p.java, { mode: 'auto', path: null });
  assert.equal(slugify('Мой Мир!'), 'moy-mir');
  assert.equal(slugify('***'), 'profile');
});


test('normalizeProfile: coverImage, pinned, playTimeSec', () => {
  const p = normalizeProfile({
    name: 'Covered',
    versionId: '1.20.1',
    coverImage: 'https://example.com/c.png',
    pinned: 1,
    playTimeSec: 12.6,
  });
  assert.equal(p.coverImage, 'https://example.com/c.png');
  assert.equal(p.pinned, true);
  assert.equal(p.playTimeSec, 13);
  const blank = normalizeProfile({ name: 'X', versionId: '1.20.1', coverImage: 12, pinned: 0, playTimeSec: -3 });
  assert.equal(blank.coverImage, null);
  assert.equal(blank.pinned, false);
  assert.equal(blank.playTimeSec, 0);
});

test('ProfileStore addPlayTime and pin', () => {
  const store = new ProfileStore(tmpLayout());
  const a = store.create({ name: 'Timed', versionId: '1.20.1' });
  store.addPlayTime(a.id, 65);
  assert.equal(store.get(a.id).playTimeSec, 65);
  store.setPinned(a.id, true);
  assert.equal(store.get(a.id).pinned, true);
  store.update(a.id, { coverImage: 'data:image/png;base64,xxx' });
  assert.ok(store.get(a.id).coverImage.startsWith('data:image/'));
});
