'use strict';
/**
 * Mod loader orchestration. A profile's loader is { type, version } where
 * type ∈ vanilla | fabric | quilt | forge | neoforge. `ensureLoader` installs
 * it once (recorded in <data>/loaders.json) and returns the version id to launch.
 */
const fs = require('node:fs');
const path = require('node:path');
const meta = require('./meta');
const forge = require('./forge');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../atomic');

const LOADER_TYPES = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

function normalizeLoader(l) {
  const type = l && LOADER_TYPES.includes(l.type) ? l.type : 'vanilla';
  if (type === 'vanilla') return { type, version: null };
  const version = l.version ? String(l.version).slice(0, 80) : null; // null = latest stable at install time
  return { type, version };
}

/** @returns {Promise<Array<{version, full?, stable, recommended?, latest?}>>} newest first */
async function listLoaderVersions(type, mcVersion, opts = {}) {
  if (type === 'fabric' || type === 'quilt') {
    const list = await meta.listVersions(type, mcVersion, opts);
    const rec = list.find((v) => v.stable) || list[0];
    if (rec) rec.recommended = true;
    if (list[0]) list[0].latest = true;
    return list;
  }
  if (type === 'forge' || type === 'neoforge') return forge.listVersions(type, mcVersion, opts);
  return [];
}

function pickRecommended(list) {
  return (list.find((v) => v.recommended) || list.find((v) => v.stable) || list[0] || null);
}

class LoaderRegistry {
  constructor(layout) {
    this.file = path.join(layout.root, 'loaders.json');
    const raw = readJsonSafeSync(this.file);
    this.data = raw && raw.entries ? raw : { schemaVersion: 1, entries: {} };
  }

  key(type, mcVersion, version) { return `${type}:${mcVersion}:${version}`; }

  get(type, mcVersion, version) { return this.data.entries[this.key(type, mcVersion, version)] || null; }

  set(type, mcVersion, version, entry) {
    this.data.entries[this.key(type, mcVersion, version)] = { ...entry, installedAt: new Date().toISOString() };
    writeJsonAtomicSync(this.file, this.data);
  }

  all() { return Object.entries(this.data.entries).map(([k, v]) => ({ key: k, ...v })); }

  remove(key) {
    delete this.data.entries[key];
    writeJsonAtomicSync(this.file, this.data);
  }
}

/**
 * Make sure the loader for `mcVersion` is installed.
 * @param {object} o
 * @param {Function} o.prepareVanilla async () => ({ clientJar, javaPath }) — installs vanilla + Java (needed by Forge processors)
 * @returns {Promise<{versionId, loaderVersion}>}
 */
async function ensureLoader({ layout, loader, mcVersion, prepareVanilla, signal, onLog = () => {}, onProgress = () => {}, concurrency, force = false }) {
  const l = normalizeLoader(loader);
  if (l.type === 'vanilla') return { versionId: mcVersion, loaderVersion: null };
  let loaderVersion = l.version;
  const registry = new LoaderRegistry(layout);
  if (!loaderVersion) {
    onLog(`Поиск рекомендуемой версии ${l.type} для ${mcVersion}`);
    const rec = pickRecommended(await listLoaderVersions(l.type, mcVersion, { signal }));
    if (!rec) {
      const err = new Error(`No ${l.type} versions for ${mcVersion}`);
      err.code = 'LOADER_UNAVAILABLE';
      throw err;
    }
    loaderVersion = rec.version;
  }
  const existing = registry.get(l.type, mcVersion, loaderVersion);
  if (!force && existing && fs.existsSync(layout.versionJson(existing.versionId))
    && (existing.extraFiles || []).every((rel) => fs.existsSync(path.join(layout.libraries, ...rel.split('/'))))) {
    return { versionId: existing.versionId, loaderVersion };
  }
  onProgress({ step: 'loader', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
  let res;
  if (l.type === 'fabric' || l.type === 'quilt') {
    res = await meta.install({ type: l.type, layout, mcVersion, loaderVersion, signal, onLog });
    res.extraFiles = [];
  } else {
    const list = await forge.listVersions(l.type, mcVersion, { signal });
    const entry = list.find((v) => v.version === loaderVersion || v.full === loaderVersion);
    if (!entry) {
      const err = new Error(`${l.type} ${loaderVersion} not found for ${mcVersion}`);
      err.code = 'LOADER_UNAVAILABLE';
      throw err;
    }
    const { clientJar, javaPath } = await prepareVanilla();
    res = await forge.install({
      flavor: l.type, layout, full: entry.full, mcVersion, minecraftJar: clientJar, javaPath, signal, onLog, onProgress, concurrency,
    });
  }
  registry.set(l.type, mcVersion, loaderVersion, { versionId: res.versionId, extraFiles: res.extraFiles });
  onLog(`Загрузчик готов: ${res.versionId}`);
  return { versionId: res.versionId, loaderVersion };
}

module.exports = { LOADER_TYPES, normalizeLoader, listLoaderVersions, pickRecommended, ensureLoader, LoaderRegistry };
