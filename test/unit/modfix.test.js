'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeMods, applyFixes, listBackups, restoreBackup, fingerprint, builtFor } = require('../../src/main/core/modfix');

const V = (id, pid, { gv = ['1.20.1'], loaders = ['fabric'], deps = [], date = '2024-01-01', type = 'release' } = {}) => ({
  id, project_id: pid, version_number: id, name: id, game_versions: gv, loaders, dependencies: deps,
  date_published: date, version_type: type, files: [{ primary: true, filename: `${id}.jar`, url: `https://x/${id}.jar`, hashes: { sha1: `h-${id}` } }],
});

function mockClient({ byHash = {}, versions = {}, projects = [] } = {}) {
  const calls = { projectVersions: [] };
  return {
    calls,
    versionsByHashes: async (hashes) => Object.fromEntries(hashes.filter((h) => byHash[h]).map((h) => [h, byHash[h]])),
    projectVersions: async (pid, q) => {
      calls.projectVersions.push({ pid, q });
      return (versions[pid] || []).filter((v) => (!q.gameVersions || !q.gameVersions.length || q.gameVersions.some((g) => v.game_versions.includes(g)))
        && (!q.loaders || !q.loaders.length || q.loaders.some((l) => v.loaders.includes(l))));
    },
    version: async () => null,
    projects: async (ids) => projects.filter((p) => ids.includes(p.id)),
  };
}
const E = (file, sha1, enabled = true) => ({ file, sha1, enabled });

test('builtFor checks game version and loader', () => {
  assert.equal(builtFor(V('a', 'A'), '1.20.1', ['fabric']), true);
  assert.equal(builtFor(V('a', 'A', { gv: ['1.19.2'] }), '1.20.1', ['fabric']), false);
  assert.equal(builtFor(V('a', 'A', { loaders: ['forge'] }), '1.20.1', ['quilt', 'fabric']), false);
});

test('incompatible mod gets replaced by best compatible version', async () => {
  const old = V('sodium-old', 'SOD', { gv: ['1.19.2'] });
  const client = mockClient({
    byHash: { s1: old },
    versions: { SOD: [V('sodium-beta', 'SOD', { type: 'beta' }), V('sodium-new', 'SOD'), V('sodium-forge', 'SOD', { loaders: ['forge'] })] },
  });
  const r = await analyzeMods(client, { entries: [E('sodium.jar', 's1')], loader: 'fabric', gameVersion: '1.20.1' });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].kind, 'incompatible');
  assert.equal(r.issues[0].fix.action, 'replace');
  assert.equal(r.issues[0].fix.version.id, 'sodium-new');
  assert.deepEqual(client.calls.projectVersions[0].q, { loaders: ['fabric'], gameVersions: ['1.20.1'], signal: undefined });
});

test('no compatible version → suggest disable; unknown mods are only reported', async () => {
  const client = mockClient({ byHash: { s1: V('x', 'X', { gv: ['1.12.2'] }) } });
  const r = await analyzeMods(client, { entries: [E('x.jar', 's1'), E('mystery.jar', 'zzz')], loader: 'fabric', gameVersion: '1.20.1' });
  assert.equal(r.issues[0].fix.action, 'disable');
  assert.deepEqual(r.unknown.map((u) => u.file), ['mystery.jar']);
});

test('missing required dependency is installed; unavailable dep has no fix', async () => {
  const mod = V('mod1', 'M', { deps: [{ project_id: 'FAPI', dependency_type: 'required' }, { project_id: 'GONE', dependency_type: 'required' }, { project_id: 'OPT', dependency_type: 'optional' }] });
  const client = mockClient({
    byHash: { s1: mod }, versions: { FAPI: [V('fapi-1', 'FAPI')] },
    projects: [{ id: 'FAPI', title: 'Fabric API' }, { id: 'GONE', title: 'Gone Lib' }],
  });
  const r = await analyzeMods(client, { entries: [E('m.jar', 's1')], loader: 'fabric', gameVersion: '1.20.1' });
  const fapi = r.issues.find((i) => i.projectId === 'FAPI');
  assert.equal(fapi.kind, 'missingDep');
  assert.equal(fapi.fix.action, 'install');
  assert.equal(fapi.title, 'Fabric API');
  assert.equal(r.issues.find((i) => i.projectId === 'GONE').fix.action, 'none');
  assert.equal(r.issues.length, 2);
});

test('dependency already installed is not reported; disabled mods ignored', async () => {
  const mod = V('mod1', 'M', { deps: [{ project_id: 'FAPI', dependency_type: 'required' }] });
  const client = mockClient({ byHash: { s1: mod, s2: V('fapi', 'FAPI'), s3: V('old', 'Z', { gv: ['1.8'] }) } });
  const r = await analyzeMods(client, { entries: [E('m.jar', 's1'), E('fapi.jar', 's2'), E('z.jar.disabled', 's3', false)], loader: 'fabric', gameVersion: '1.20.1' });
  assert.deepEqual(r.issues, []);
});

test('duplicates: keeps compatible/newest, removes the rest', async () => {
  const client = mockClient({ byHash: { a: V('v1', 'P', { date: '2023-01-01' }), b: V('v2', 'P', { date: '2024-05-01' }) } });
  const r = await analyzeMods(client, { entries: [E('p1.jar', 'a'), E('p2.jar', 'b')], loader: 'fabric', gameVersion: '1.20.1' });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].kind, 'duplicate');
  assert.equal(r.issues[0].file, 'p1.jar');
  assert.equal(r.issues[0].keepFile, 'p2.jar');
});

test('declared incompatibility reported once', async () => {
  const a = V('a1', 'A', { deps: [{ project_id: 'B', dependency_type: 'incompatible' }] });
  const b = V('b1', 'B', { deps: [{ project_id: 'A', dependency_type: 'incompatible' }] });
  const client = mockClient({ byHash: { a, b } });
  const r = await analyzeMods(client, { entries: [E('a.jar', 'a'), E('b.jar', 'b')], loader: 'fabric', gameVersion: '1.20.1' });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].kind, 'conflict');
  assert.equal(r.issues[0].fix.action, 'disable');
});

test('quilt profile accepts fabric mods; vanilla profile skips check', async () => {
  const client = mockClient({ byHash: { s: V('f', 'F') } });
  assert.deepEqual((await analyzeMods(client, { entries: [E('f.jar', 's')], loader: 'quilt', gameVersion: '1.20.1' })).issues, []);
  assert.equal((await analyzeMods(client, { entries: [E('f.jar', 's')], loader: 'vanilla', gameVersion: '1.20.1' })).checked, 0);
});

test('applyFixes moves jars to backup and restoreBackup undoes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-modfix-'));
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'dup.jar'), 'x');
  const res = await applyFixes(null, dir, [
    { id: 'dup:dup.jar', file: 'dup.jar', fix: { action: 'remove' } },
    { id: 'dep:X', fix: { action: 'none' } },
  ], { now: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(res.applied, ['dup:dup.jar']);
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'dup.jar')));
  assert.ok(fs.existsSync(path.join(res.backupDir, 'dup.jar')));
  const [b] = await listBackups(dir);
  assert.deepEqual(await restoreBackup(dir, b), ['dup.jar']);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'dup.jar')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fingerprint depends on enabled hashes, loader and version', () => {
  const a = fingerprint([E('a', '1'), E('b', '2', false)], 'fabric', '1.20.1');
  assert.equal(a, fingerprint([E('a', '1')], 'fabric', '1.20.1'));
  assert.notEqual(a, fingerprint([E('a', '1')], 'forge', '1.20.1'));
});
