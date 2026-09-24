'use strict';
/**
 * Disk usage + safe cleanup of shared data (versions, libraries, Java runtimes,
 * asset indexes/objects). Everything reachable from any profile (its Minecraft
 * version, loader version chain, libraries, loader extra files, asset index,
 * Java component) is kept. If any profile's version chain cannot be read, the
 * cleanup of libraries/assets is skipped entirely (conservative).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { resolveLibraries } = require('./library');
const { mergeVersions } = require('./loaders/inherit');
const { currentContext } = require('./platform');
const { requiredJava } = require('./java');

/** Recursive size, counting hard-linked files once. */
async function dirSize(dir, seen = new Set()) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p, seen);
    else if (e.isFile()) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      const key = `${st.dev}:${st.ino}`;
      if (st.nlink > 1) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      total += st.size;
    }
  }
  return total;
}

async function usage(layout) {
  const seen = new Set();
  const parts = {
    versions: await dirSize(layout.versions, seen),
    libraries: await dirSize(layout.libraries, seen),
    assets: await dirSize(layout.assets, seen),
    runtime: await dirSize(layout.runtime, seen),
    instances: await dirSize(layout.instances, seen),
  };
  parts.total = Object.values(parts).reduce((a, b) => a + b, 0);
  return parts;
}

function readVersionJsonSync(layout, id) {
  return JSON.parse(fs.readFileSync(layout.versionJson(id), 'utf8'));
}

/** Load a version chain from disk only. Returns null if the root isn't installed. */
function loadChainSync(layout, id) {
  if (!fs.existsSync(layout.versionJson(id))) return null;
  let json = readVersionJsonSync(layout, id);
  const ids = [json.id || id];
  if (json.inheritsFrom) {
    const parent = loadChainSync(layout, json.inheritsFrom);
    if (!parent) {
      ids.push(json.inheritsFrom);
      return { json, ids, incomplete: true };
    }
    json = mergeVersions({ ...parent.json, _chain: parent.ids }, json);
    ids.push(...parent.ids);
  }
  return { json, ids };
}

const rel = (base, p) => path.relative(base, p).split(path.sep).join('/');

/**
 * Compute everything referenced by profiles.
 * @param {object} o
 * @param {Array<{versionId, loader}>} o.profiles
 * @param {Array<{key, versionId, extraFiles}>} o.loaderEntries from LoaderRegistry.all()
 * @returns {{versions:Set, libraries:Set, assetIndexes:Set, runtimes:Set, loaderKeys:Set, errors:string[]}}
 */
function computeReferences({ layout, profiles, loaderEntries = [], extraRoots = [], ctx = currentContext() }) {
  const refs = { versions: new Set(), libraries: new Set(), assetIndexes: new Set(), runtimes: new Set(), loaderKeys: new Set(), errors: [] };
  const rootIds = [...extraRoots];
  for (const p of profiles) {
    if (!p.versionId) continue;
    rootIds.push(p.versionId);
    const lt = p.loader && p.loader.type && p.loader.type !== 'vanilla' ? p.loader.type : null;
    if (!lt) continue;
    for (const e of loaderEntries) {
      const [type, mc, ver] = e.key.split(':');
      if (type !== lt || mc !== p.versionId) continue;
      // Pinned version → only that entry; "latest stable" (null) → keep all installed ones for that MC
      if (p.loader.version && ver !== p.loader.version) continue;
      refs.loaderKeys.add(e.key);
      rootIds.push(e.versionId);
      for (const f of e.extraFiles || []) refs.libraries.add(f);
    }
  }
  for (const id of rootIds) {
    refs.versions.add(id);
    let chain;
    try {
      chain = loadChainSync(layout, id);
    } catch (err) {
      refs.errors.push(`${id}: ${err.message}`);
      continue;
    }
    if (!chain) continue; // not installed yet — nothing to keep
    if (chain.incomplete) refs.errors.push(`${id}: parent ${chain.ids[chain.ids.length - 1]} missing`);
    chain.ids.forEach((v) => refs.versions.add(v));
    const v = chain.json;
    for (const lib of resolveLibraries(v.libraries, ctx, layout.libraries)) {
      if (lib.artifact) refs.libraries.add(rel(layout.libraries, lib.artifact.path));
      if (lib.native) refs.libraries.add(rel(layout.libraries, lib.native.path));
    }
    if (v.assetIndex && v.assetIndex.id) refs.assetIndexes.add(v.assetIndex.id);
    try {
      refs.runtimes.add(requiredJava(v).component);
    } catch { /* ignore */ }
  }
  return refs;
}

async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(p, base, out);
    else if (e.isFile()) out.push(rel(base, p));
  }
  return out;
}

async function fileSize(p) {
  const st = await fsp.stat(p).catch(() => null);
  return st ? st.size : 0;
}

/**
 * Build a cleanup plan (nothing is deleted here).
 * @param {object} o
 * @param {Set<string>} [o.protectVersions] extra version ids to keep (e.g. running games)
 * @returns {Promise<{items: Array<{kind, id, path, bytes}>, totalBytes, skipped: string[], refs}>}
 */
async function planCleanup({ layout, profiles, loaderEntries, protectVersions = new Set(), ctx = currentContext(), include = { versions: true, libraries: true, runtimes: true, assets: true } }) {
  const refs = computeReferences({ layout, profiles, loaderEntries, extraRoots: [...protectVersions], ctx });
  const items = [];
  const skipped = [];
  const unsafe = refs.errors.length > 0;
  if (unsafe) skipped.push(...refs.errors);

  if (include.versions) {
    const dirs = await fsp.readdir(layout.versions, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory() || refs.versions.has(d.name)) continue;
      const p = layout.versionDir(d.name);
      items.push({ kind: 'version', id: d.name, path: p, bytes: await dirSize(p) });
    }
  }
  // Library/asset reachability depends on every referenced chain being readable
  if (include.libraries && !unsafe) {
    for (const f of await walkFiles(layout.libraries)) {
      if (refs.libraries.has(f) || refs.libraries.has(f.replace(/\.part$/, ''))) continue;
      const p = path.join(layout.libraries, ...f.split('/'));
      items.push({ kind: 'library', id: f, path: p, bytes: await fileSize(p) });
    }
  }
  if (include.runtimes && !unsafe) {
    const comps = await fsp.readdir(layout.runtime, { withFileTypes: true }).catch(() => []);
    for (const d of comps) {
      if (!d.isDirectory()) continue;
      // Adoptium fallback dirs are named adoptium-<major>; keep them (cannot map to a component reliably)
      if (refs.runtimes.has(d.name) || d.name.startsWith('adoptium-')) continue;
      const p = path.join(layout.runtime, d.name);
      items.push({ kind: 'runtime', id: d.name, path: p, bytes: await dirSize(p) });
    }
  }
  if (include.assets && !unsafe) {
    const keepHashes = new Set();
    const idxFiles = await fsp.readdir(layout.assetIndexes).catch(() => []);
    for (const f of idxFiles) {
      const id = f.replace(/\.json$/, '');
      const p = path.join(layout.assetIndexes, f);
      if (refs.assetIndexes.has(id)) {
        try {
          const idx = JSON.parse(await fsp.readFile(p, 'utf8'));
          for (const o of Object.values(idx.objects || {})) keepHashes.add(o.hash);
        } catch {
          skipped.push(`asset index ${id} unreadable — asset objects kept`);
          keepHashes.add('*');
        }
      } else {
        items.push({ kind: 'assetIndex', id, path: p, bytes: await fileSize(p) });
      }
    }
    if (!keepHashes.has('*')) {
      for (const f of await walkFiles(layout.assetObjects)) {
        const hash = f.split('/').pop();
        if (keepHashes.has(hash)) continue;
        const p = path.join(layout.assetObjects, ...f.split('/'));
        items.push({ kind: 'asset', id: hash, path: p, bytes: await fileSize(p) });
      }
    }
  }
  const totalBytes = items.reduce((a, b) => a + b.bytes, 0);
  return { items, totalBytes, skipped, refs };
}

async function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  if ((await fsp.readdir(dir).catch(() => ['x'])).length === 0) await fsp.rmdir(dir).catch(() => {});
}

/** Execute a plan produced by planCleanup (only paths inside the data root). */
async function executeCleanup(layout, plan, { onProgress = () => {} } = {}) {
  const root = path.resolve(layout.root) + path.sep;
  let freed = 0;
  let removed = 0;
  let i = 0;
  for (const it of plan.items) {
    i++;
    const p = path.resolve(it.path);
    if (!p.startsWith(root)) continue; // never touch anything outside the data dir
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 });
    freed += it.bytes;
    removed++;
    if (i % 200 === 0) onProgress({ done: i, total: plan.items.length });
  }
  await removeEmptyDirs(layout.libraries);
  await removeEmptyDirs(layout.assetObjects);
  const libsRoot = layout.libraries;
  if (!fs.existsSync(libsRoot)) fs.mkdirSync(libsRoot, { recursive: true });
  return { freed, removed };
}

module.exports = { usage, dirSize, computeReferences, planCleanup, executeCleanup, loadChainSync };
