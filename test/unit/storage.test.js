'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLayout } = require('../../src/main/core/paths');
const storage = require('../../src/main/core/storage');

const ctx = { platform: 'linux', osName: 'linux', arch: 'x64', osArch: 'x86_64', osVersion: '6', features: {} };

function put(file, data = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function fixture() {
  const layout = createLayout(fs.mkdtempSync(path.join(os.tmpdir(), 'forja-storage-')));
  const lib = (rel) => path.join(layout.libraries, ...rel.split('/'));
  const version = (id, json) => put(layout.versionJson(id), JSON.stringify({ id, ...json }));
  version('1.20.1', { assetIndex: { id: '5' }, javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    libraries: [{ name: 'com.mojang:brigadier:1.1.8' }, { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux' }] });
  put(layout.versionJar('1.20.1'), 'jar');
  version('fabric-loader-0.19.5-1.20.1', { inheritsFrom: '1.20.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' }] });
  version('1.8.9', { assetIndex: { id: '1.8' }, libraries: [{ name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { linux: 'natives-linux' } }] });
  version('1.12.2', { assetIndex: { id: '1.12' }, libraries: [{ name: 'old:only:1' }] });
  version('1.12.2-forge-14.23.5.2859', { inheritsFrom: '1.12.2', libraries: [] });
  for (const r of ['com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar', 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar',
    'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar', 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar',
    'old/only/1/only-1.jar', 'net/minecraft/client/1.20.1-srg/client-1.20.1-srg.jar', 'unused/lib/1/lib-1.jar']) put(lib(r), 'L');
  put(path.join(layout.runtime, 'java-runtime-gamma', 'linux', 'bin', 'java'), 'J');
  put(path.join(layout.runtime, 'jre-legacy', 'linux', 'bin', 'java'), 'J8');
  put(path.join(layout.runtime, 'java-runtime-delta', 'linux', 'bin', 'java'), 'J21');
  const obj = (h) => put(path.join(layout.assetObjects, h.slice(0, 2), h), 'A');
  put(path.join(layout.assetIndexes, '5.json'), JSON.stringify({ objects: { a: { hash: 'aa11' }, b: { hash: 'bb22' } } }));
  put(path.join(layout.assetIndexes, '1.8.json'), JSON.stringify({ objects: { c: { hash: 'cc33' }, b: { hash: 'bb22' } } }));
  put(path.join(layout.assetIndexes, '1.12.json'), JSON.stringify({ objects: { d: { hash: 'dd44' } } }));
  ['aa11', 'bb22', 'cc33', 'dd44', 'ee55'].forEach(obj);
  return { layout, lib };
}

const profiles = [
  { versionId: '1.20.1', loader: { type: 'fabric', version: null } },
  { versionId: '1.8.9', loader: { type: 'vanilla' } },
  { versionId: '1.21.9', loader: { type: 'vanilla' } }, // not installed yet
];
const loaderEntries = [
  { key: 'fabric:1.20.1:0.19.5', versionId: 'fabric-loader-0.19.5-1.20.1', extraFiles: ['net/minecraft/client/1.20.1-srg/client-1.20.1-srg.jar'] },
  { key: 'forge:1.12.2:14.23.5.2859', versionId: '1.12.2-forge-14.23.5.2859', extraFiles: [] },
];

test('cleanup reference counting: everything reachable from profiles is kept, the rest is planned for removal', async () => {
  const { layout, lib } = fixture();
  const plan = await storage.planCleanup({ layout, profiles, loaderEntries, ctx });
  const ids = (kind) => plan.items.filter((i) => i.kind === kind).map((i) => i.id).sort();
  assert.deepEqual(ids('version'), ['1.12.2', '1.12.2-forge-14.23.5.2859']);
  assert.deepEqual(ids('library'), ['old/only/1/only-1.jar', 'unused/lib/1/lib-1.jar']);
  assert.deepEqual(ids('runtime'), ['java-runtime-delta']); // gamma (1.20.1) + jre-legacy (1.8.9 default) kept
  assert.deepEqual(ids('assetIndex'), ['1.12']);
  assert.deepEqual(ids('asset'), ['dd44', 'ee55']); // bb22 shared by 5 and 1.8 → kept
  assert.ok(plan.totalBytes > 0);

  const res = await storage.executeCleanup(layout, plan);
  assert.equal(res.removed, plan.items.length);
  assert.ok(fs.existsSync(layout.versionJson('fabric-loader-0.19.5-1.20.1')));
  assert.ok(fs.existsSync(layout.versionJar('1.20.1')));
  assert.ok(fs.existsSync(lib('net/minecraft/client/1.20.1-srg/client-1.20.1-srg.jar')), 'loader extra files kept');
  assert.ok(fs.existsSync(lib('org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar')), 'legacy natives kept');
  assert.ok(!fs.existsSync(layout.versionDir('1.12.2')));
  assert.ok(!fs.existsSync(path.join(layout.libraries, 'unused')), 'empty dirs removed');
  // Second plan after cleanup: nothing left to remove
  const again = await storage.planCleanup({ layout, profiles, loaderEntries, ctx });
  assert.equal(again.items.length, 0);
});

test('pinned loader version keeps only that entry; running versions are protected', async () => {
  const { layout } = fixture();
  const plan = await storage.planCleanup({
    layout, ctx, loaderEntries,
    profiles: [{ versionId: '1.20.1', loader: { type: 'fabric', version: '0.18.0' } }],
    protectVersions: new Set(['1.12.2-forge-14.23.5.2859']),
  });
  const versions = plan.items.filter((i) => i.kind === 'version').map((i) => i.id).sort();
  assert.deepEqual(versions, ['1.8.9', 'fabric-loader-0.19.5-1.20.1']);
});

test('unreadable version chain → libraries/runtimes/assets are not touched (conservative)', async () => {
  const { layout } = fixture();
  fs.writeFileSync(layout.versionJson('1.8.9'), '{broken');
  const plan = await storage.planCleanup({ layout, profiles, loaderEntries, ctx });
  assert.ok(plan.skipped.some((s) => s.startsWith('1.8.9')));
  assert.equal(plan.items.filter((i) => i.kind !== 'version').length, 0);
  assert.ok(plan.items.every((i) => i.id !== '1.8.9'), 'referenced version kept even if unreadable');
});

test('usage sums the data folders', async () => {
  const { layout } = fixture();
  const u = await storage.usage(layout);
  assert.ok(u.versions > 0 && u.libraries > 0 && u.assets > 0 && u.runtime > 0);
  assert.equal(u.total, u.versions + u.libraries + u.assets + u.runtime + u.instances);
});

test('usage cache: returns cached value within TTL, force refreshes, invalidate clears', async () => {
  const { layout } = fixture();
  storage.invalidateUsageCache();
  const a = await storage.usage(layout);
  const b = await storage.usage(layout);
  assert.equal(a, b, 'same object from cache');
  // mutate disk then cached value stays until invalidate/force
  fs.writeFileSync(path.join(layout.versions, 'extra.bin'), 'zzzzzzzzzz');
  const cached = await storage.usage(layout);
  assert.equal(cached.versions, a.versions);
  const forced = await storage.usage(layout, { force: true });
  assert.ok(forced.versions > a.versions);
  storage.invalidateUsageCache();
  const again = await storage.usage(layout);
  assert.equal(again.versions, forced.versions);
});
