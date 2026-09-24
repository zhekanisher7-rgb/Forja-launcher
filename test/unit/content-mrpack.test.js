'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const content = require('../../src/main/core/content');
const mrpack = require('../../src/main/core/mrpack');
const { buildFacets, pickBestVersion, loadersFor, USER_AGENT } = require('../../src/main/core/modrinth');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fakeClient(versions) {
  const calls = [];
  return {
    calls,
    async version(id) { calls.push(['version', id]); return versions.find((v) => v.id === id) || null; },
    async projectVersions(pid, opts) {
      calls.push(['projectVersions', pid, opts.loaders, opts.gameVersions]);
      return versions.filter((v) => v.project_id === pid && (!opts.loaders.length || v.loaders.some((l) => opts.loaders.includes(l))));
    },
  };
}

test('dependency resolution: required deps recursive, optional ignored, installed/duplicates skipped, missing reported', async () => {
  const v = (id, pid, deps = [], extra = {}) => ({ id, project_id: pid, loaders: ['fabric'], version_type: 'release', dependencies: deps, ...extra });
  const versions = [
    v('sodium-v', 'sodium', [{ project_id: 'fabric-api', dependency_type: 'required' }, { project_id: 'modmenu', dependency_type: 'optional' }]),
    v('fapi-beta', 'fabric-api', [], { version_type: 'beta' }),
    v('fapi-rel', 'fabric-api', [{ project_id: 'lib-a', dependency_type: 'required' }]),
    v('liba-1', 'lib-a', [{ version_id: 'libb-pinned', dependency_type: 'required' }, { project_id: 'sodium', dependency_type: 'required' }]),
    v('libb-pinned', 'lib-b'),
    v('iris-v', 'iris', [{ project_id: 'sodium', dependency_type: 'required' }, { project_id: 'ghost', dependency_type: 'required' },
      { project_id: 'optifine', dependency_type: 'incompatible' }]),
  ];
  const client = fakeClient(versions);
  const r = await content.resolveDependencies(client, versions[0], { loaders: ['fabric'], gameVersion: '1.20.1' });
  assert.deepEqual(r.toInstall.map((x) => x.id), ['fapi-rel', 'liba-1', 'libb-pinned']); // release preferred over beta, cycle back to sodium skipped
  assert.deepEqual(r.missing, []);
  assert.ok(client.calls.some((c) => c[0] === 'version' && c[1] === 'libb-pinned'), 'pinned version_id fetched directly');
  assert.ok(client.calls.every((c) => c[0] !== 'projectVersions' || c[1] !== 'modmenu'), 'optional deps are not resolved');

  const r2 = await content.resolveDependencies(client, versions[5], { loaders: ['fabric'], gameVersion: '1.20.1', installedProjectIds: new Set(['sodium', 'optifine']) });
  assert.deepEqual(r2.toInstall, []);
  assert.deepEqual(r2.missing.map((m) => m.projectId), ['ghost']);
  assert.deepEqual(r2.incompatible.map((m) => m.projectId), ['optifine']);
});

test('content list + enable/disable (.jar.disabled) + remove, with hash cache', async () => {
  const gameDir = tmp('forja-content-');
  const mods = path.join(gameDir, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'a.jar'), 'AAA');
  fs.writeFileSync(path.join(mods, 'b.jar.disabled'), 'BBB');
  fs.writeFileSync(path.join(mods, 'readme.txt'), 'not a mod');
  let list = await content.listContent(gameDir, 'mod');
  assert.deepEqual(list.map((e) => [e.file, e.enabled]), [['a.jar', true], ['b.jar.disabled', false]]);
  assert.equal(list[0].sha1, '606ec6e9bd8a8ff2ad14e5fade3f264471e82251');
  const name = await content.setEnabled(gameDir, 'mod', 'a.jar', false);
  assert.equal(name, 'a.jar.disabled');
  assert.ok(fs.existsSync(path.join(mods, 'a.jar.disabled')));
  assert.equal(await content.setEnabled(gameDir, 'mod', 'b.jar.disabled', true), 'b.jar');
  list = await content.listContent(gameDir, 'mod');
  assert.deepEqual(list.map((e) => [e.file, e.enabled]), [['a.jar.disabled', false], ['b.jar', true]]);
  await content.removeContent(gameDir, 'mod', 'b.jar');
  assert.ok(!fs.existsSync(path.join(mods, 'b.jar')));
  await assert.rejects(() => content.setEnabled(gameDir, 'mod', '../evil.jar', true), /Unsafe file name/);
  await assert.rejects(() => content.removeContent(gameDir, 'mod', '../../x'), /Unsafe file name/);
  assert.ok(content.isContentFile('resourcepack', 'pack.zip.disabled'));
  assert.ok(!content.isContentFile('resourcepack', 'pack.jar'));
});

test('Modrinth helpers: facets, version pick, loaders per type, User-Agent', () => {
  assert.deepEqual(buildFacets({ type: 'mod', gameVersion: '1.20.1', loader: 'fabric', category: 'optimization' }),
    [['project_type:mod'], ['versions:1.20.1'], ['categories:fabric'], ['categories:optimization']]);
  assert.deepEqual(buildFacets({ type: 'resourcepack', gameVersion: '1.20.1', loader: 'fabric' }), [['project_type:resourcepack'], ['versions:1.20.1']]);
  assert.equal(pickBestVersion([{ id: 'a', version_type: 'alpha' }, { id: 'b', version_type: 'beta' }]).id, 'b');
  assert.deepEqual(loadersFor('mod', 'quilt'), ['quilt', 'fabric']);
  assert.deepEqual(loadersFor('mod', 'vanilla'), []);
  assert.deepEqual(loadersFor('resourcepack', 'forge'), ['minecraft']);
  assert.match(USER_AGENT, /^ForjaLauncher\/\d+\.\d+\.\d+ \(.+\)$/);
});

const index = (over = {}) => ({
  formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'Test Pack',
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.14' },
  files: [
    { path: 'mods/sodium.jar', hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) }, downloads: ['https://cdn.modrinth.com/data/x/sodium.jar'], fileSize: 10 },
    { path: 'mods/server-only.jar', hashes: { sha1: 'c'.repeat(40) }, env: { client: 'unsupported', server: 'required' }, downloads: ['https://cdn.modrinth.com/s.jar'] },
    { path: 'mods/optional.jar', hashes: { sha1: 'd'.repeat(40) }, env: { client: 'optional', server: 'optional' }, downloads: ['https://github.com/o.jar'] },
  ],
  ...over,
});

test('mrpack index: loader from dependencies, client env filtering, hashes and hosts validated', () => {
  const p = mrpack.parseIndex(index());
  assert.equal(p.name, 'Test Pack');
  assert.equal(p.mcVersion, '1.20.1');
  assert.deepEqual(p.loader, { type: 'fabric', version: '0.16.14' });
  assert.deepEqual(p.files.map((f) => [f.path, f.optional]), [['mods/sodium.jar', false], ['mods/optional.jar', true]]);
  assert.deepEqual(p.skipped, ['mods/server-only.jar']);
  assert.equal(mrpack.parseIndex(index(), { includeOptional: false }).files.length, 1);
  assert.deepEqual(mrpack.parseIndex(index({ dependencies: { minecraft: '1.20.1', neoforge: '21.1.1' } })).loader, { type: 'neoforge', version: '21.1.1' });
  assert.deepEqual(mrpack.parseIndex(index({ dependencies: { minecraft: '1.21' }, files: [] })).loader, { type: 'vanilla', version: null });

  assert.throws(() => mrpack.parseIndex(index({ formatVersion: 2 })), /formatVersion/);
  assert.throws(() => mrpack.parseIndex(index({ dependencies: {} })), /minecraft/);
  const bad = (file) => index({ files: [{ hashes: { sha1: 'a'.repeat(40) }, downloads: ['https://cdn.modrinth.com/x'], ...file }] });
  assert.throws(() => mrpack.parseIndex(bad({ path: '../../evil.jar' })), /unsafe path/);
  assert.throws(() => mrpack.parseIndex(bad({ path: '/etc/passwd' })), /unsafe path/);
  assert.throws(() => mrpack.parseIndex(bad({ path: 'C:/x.jar' })), /unsafe path/);
  assert.throws(() => mrpack.parseIndex(bad({ path: 'mods/x.jar', downloads: ['https://evil.example.com/x.jar'] })), /no allowed download/);
  assert.throws(() => mrpack.parseIndex(bad({ path: 'mods/x.jar', downloads: ['http://cdn.modrinth.com/x.jar'] })), /no allowed download/);
  assert.throws(() => mrpack.parseIndex(bad({ path: 'mods/x.jar', hashes: {} })), /sha1/);
});

test('mrpack overrides: client-overrides win over overrides, traversal rejected', async () => {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index())));
  zip.addFile('overrides/config/a.txt', Buffer.from('common'));
  zip.addFile('overrides/options.txt', Buffer.from('from-overrides'));
  zip.addFile('client-overrides/options.txt', Buffer.from('from-client'));
  zip.addFile('server-overrides/server.properties', Buffer.from('server'));
  const gameDir = tmp('forja-mrpack-');
  const n = await mrpack.applyOverrides(zip, gameDir);
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(gameDir, 'config', 'a.txt'), 'utf8'), 'common');
  assert.equal(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8'), 'from-client');
  assert.ok(!fs.existsSync(path.join(gameDir, 'server.properties')));
  // readPack on a real file
  const file = path.join(gameDir, 'p.mrpack');
  zip.writeZip(file);
  assert.equal(mrpack.readPack(file).index.name, 'Test Pack');
  // traversal inside override entries (entry names crafted like a malicious pack)
  assert.throws(() => mrpack.overrideEntries([{ entryName: 'overrides/../../evil.sh', isDirectory: false }]), /unsafe path/);
});
