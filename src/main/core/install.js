'use strict';
/**
 * Install a Minecraft version: version JSON, client jar, libraries,
 * natives, asset index + objects (incl. legacy/virtual), logging config.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const config = require('../config');
const { downloadAll, isFileValid, CancelledError, VerifyCache, verifyCachePath, runPool } = require('./download');
const { resolveLibraries } = require('./library');
const { currentContext } = require('./platform');
const { findVersion, fetchManifest } = require('./versions');
const { mergeVersions } = require('./loaders/inherit');

const NATIVE_EXT = /\.(so|dll|dylib|jnilib)$/i;
const NATIVE_EXTRACT_CONCURRENCY = 8;
const VIRTUAL_COPY_CONCURRENCY = 8;
const NATIVES_OK = '.forja-natives-ok';

async function linkOrCopy(src, dest) {
  try {
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dest).catch(() => null)]);
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) return;
  } catch { /* src missing → copy throws below */ }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(dest, { force: true });
  try {
    await fsp.link(src, dest);
  } catch {
    await fsp.copyFile(src, dest);
  }
}

function safeCacheName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

/**
 * Ensure version JSON is present locally (download from manifest if needed)
 * and resolve inheritsFrom chains.
 */
async function loadVersionJson({ layout, versionId, manifest, signal, log = () => {} }) {
  const jsonPath = layout.versionJson(versionId);
  const entry = manifest ? findVersion(manifest, versionId) : null;
  let json = null;
  if (entry) {
    const ok = await isFileValid(jsonPath, { sha1: entry.sha1 });
    if (!ok) {
      log(`Загрузка описания версии ${versionId}`);
      await downloadAll([{ url: entry.url, path: jsonPath, sha1: entry.sha1 }], { signal });
    }
  }
  try {
    json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  } catch {
    throw new Error(`Version ${versionId} not found locally and not present in manifest`);
  }
  if (json.inheritsFrom) {
    const parent = await loadVersionJson({ layout, versionId: json.inheritsFrom, manifest, signal, log });
    json = mergeVersions(parent, json);
  }
  if (!json._jarId) json._jarId = json.id;
  return json;
}

function collectLibraryTasks(resolved) {
  const tasks = [];
  for (const lib of resolved) {
    for (const d of [lib.artifact, lib.native]) {
      if (d && d.url) tasks.push({ url: d.url, path: d.path, sha1: d.sha1, size: d.size });
    }
  }
  return tasks;
}

/** Libraries that make up the classpath (deduped by key, first wins). */
function classpathLibraries(resolved) {
  const seen = new Set();
  const out = [];
  for (const lib of resolved) {
    if (!lib.artifact) continue;
    if (seen.has(lib.key)) continue;
    seen.add(lib.key);
    out.push(lib.artifact.path);
  }
  return out;
}

/** Fingerprint of native jars for the shared extract cache key. */
async function nativesCacheHash(resolved) {
  const parts = [];
  for (const lib of resolved) {
    if (lib.native) {
      try {
        const st = await fsp.stat(lib.native.path);
        parts.push(`n:${lib.native.path}:${st.size}:${Math.trunc(st.mtimeMs)}`);
      } catch {
        parts.push(`n:${lib.native.path}:missing`);
      }
    }
    if (lib.modernNative && lib.modernNativeForArch && lib.artifact) {
      try {
        const st = await fsp.stat(lib.artifact.path);
        parts.push(`m:${lib.artifact.path}:${st.size}:${Math.trunc(st.mtimeMs)}`);
      } catch {
        parts.push(`m:${lib.artifact.path}:missing`);
      }
    }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Materialize zip entries into destDir with a concurrency pool (zip-slip guarded). */
async function writeZipEntries(entries, destDir, { concurrency = NATIVE_EXTRACT_CONCURRENCY } = {}) {
  let count = 0;
  await runPool(entries, concurrency, async (job) => {
    const dest = job.flat
      ? path.join(destDir, path.basename(job.entryName))
      : path.join(destDir, job.entryName);
    if (!dest.startsWith(destDir + path.sep) && dest !== destDir) return; // zip-slip
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, job.data);
    count++;
  });
  return count;
}

function collectNativeEntries(resolved) {
  const jobs = [];
  for (const lib of resolved) {
    if (lib.native) {
      const excludes = (lib.extract && lib.extract.exclude) || ['META-INF/'];
      const zip = new AdmZip(lib.native.path);
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (excludes.some((x) => e.entryName.startsWith(x))) continue;
        jobs.push({ entryName: e.entryName, data: e.getData(), flat: false });
      }
    }
    if (lib.modernNative && lib.modernNativeForArch && lib.artifact) {
      const zip = new AdmZip(lib.artifact.path);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || e.entryName.startsWith('META-INF/')) continue;
        if (!NATIVE_EXT.test(e.entryName)) continue;
        jobs.push({ entryName: e.entryName, data: e.getData(), flat: true });
      }
    }
  }
  return jobs;
}

/** Recursively hardlink (or copy) a tree from src → dest, skipping marker files. */
async function linkOrCopyTree(src, dest, { concurrency = NATIVE_EXTRACT_CONCURRENCY, skipNames = new Set([NATIVES_OK]) } = {}) {
  await fsp.mkdir(dest, { recursive: true });
  const files = [];
  async function walk(from, to) {
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      if (skipNames.has(e.name)) continue;
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) {
        await fsp.mkdir(d, { recursive: true });
        await walk(s, d);
      } else if (e.isFile()) {
        files.push({ s, d });
      }
    }
  }
  await walk(src, dest);
  await runPool(files, concurrency, async ({ s, d }) => {
    await linkOrCopy(s, d);
  });
  return files.length;
}

/**
 * Extract natives into `nativesDir` (per-launch). When `cacheBase` is set,
 * extract once into a shared cache keyed by versionId+jar fingerprint, then
 * hardlink/copy into the launch dir (game never runs from the shared cache).
 */
async function extractNatives(resolved, nativesDir, {
  cacheBase = null,
  versionId = null,
  concurrency = NATIVE_EXTRACT_CONCURRENCY,
} = {}) {
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });

  let cacheDir = null;
  if (cacheBase && versionId) {
    const hash = await nativesCacheHash(resolved);
    cacheDir = path.join(cacheBase, `${safeCacheName(versionId)}-${hash}`);
    const marker = path.join(cacheDir, NATIVES_OK);
    try {
      await fsp.access(marker);
      const n = await linkOrCopyTree(cacheDir, nativesDir, { concurrency });
      return n;
    } catch { /* cache miss → extract below */ }
  }

  const extractRoot = cacheDir || nativesDir;
  if (cacheDir) {
    await fsp.rm(cacheDir, { recursive: true, force: true });
    await fsp.mkdir(cacheDir, { recursive: true });
  }

  const jobs = collectNativeEntries(resolved);
  const count = await writeZipEntries(jobs, extractRoot, { concurrency });

  if (cacheDir) {
    await fsp.writeFile(path.join(cacheDir, NATIVES_OK), JSON.stringify({
      versionId, count, at: Date.now(),
    }));
    await linkOrCopyTree(cacheDir, nativesDir, { concurrency });
  }
  return count;
}

/**
 * Download asset index + objects. Handles legacy "virtual" and
 * "map_to_resources" (pre-1.6) index types.
 */
async function installAssets({
  layout, version, gameDir, signal, onProgress, concurrency, log,
  verifyExisting = 'size', verifyCache = null,
}) {
  const ai = version.assetIndex;
  if (!ai) return { indexId: version.assets || 'legacy', stats: null, virtualDir: null };
  const indexPath = path.join(layout.assetIndexes, `${ai.id}.json`);
  await downloadAll([{ url: ai.url, path: indexPath, sha1: ai.sha1, size: ai.size }], {
    signal, verifyExisting, verifyCache,
  });
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  const objects = Object.entries(index.objects || {});
  const tasks = objects.map(([, o]) => {
    const sub = o.hash.slice(0, 2);
    return {
      url: `${config.endpoints.resourcesBase}${sub}/${o.hash}`,
      path: path.join(layout.assetObjects, sub, o.hash),
      sha1: o.hash,
      size: o.size,
    };
  });
  log(`Ресурсы: ${objects.length} файлов (индекс ${ai.id})`);
  const stats = await downloadAll(tasks, {
    signal, onProgress, concurrency, verifyExisting, verifyCache,
  });

  let virtualDir = null;
  const copyTo = async (baseDir) => {
    await runPool(objects, VIRTUAL_COPY_CONCURRENCY, async ([name, o]) => {
      if (signal && signal.aborted) throw new CancelledError();
      const dest = path.join(baseDir, ...name.split('/'));
      // Fast existence check by size; linkOrCopy also short-circuits on match
      if (await isFileValid(dest, { size: o.size, trustSize: true })) return;
      const src = path.join(layout.assetObjects, o.hash.slice(0, 2), o.hash);
      await linkOrCopy(src, dest);
    });
  };
  if (index.virtual) {
    virtualDir = path.join(layout.assets, 'virtual', ai.id);
    log(`Копирование виртуальных ресурсов в ${virtualDir}`);
    await copyTo(virtualDir);
  }
  if (index.map_to_resources && gameDir) {
    const resDir = path.join(gameDir, 'resources');
    log(`Копирование ресурсов в ${resDir}`);
    await copyTo(resDir);
    virtualDir = virtualDir || resDir;
  }
  return { indexId: ai.id, stats, virtualDir };
}

/**
 * Full install.
 * @param {object} opts
 * @param {boolean|'size'|'sha1'} [opts.verifyExisting='size'] — 'size' for normal
 *   launch (trust size), true/'sha1' for repair (full SHA-1).
 * @returns {Promise<{version, classpath: string[], clientJar, nativesDir, assets, loggingConfig, stats}>}
 */
async function installVersion({
  layout,
  versionId,
  manifest,
  gameDir,
  signal,
  onProgress = () => {},
  onLog = () => {},
  concurrency = 12,
  ctx = currentContext(),
  nativesDir = null, // where to extract natives (per-launch temp dir); null = skip
  nativesCacheBase = null,
  verifyExisting = 'size',
}) {
  const log = onLog;
  const t0 = Date.now();
  const verifyCache = new VerifyCache(verifyCachePath(layout.cache));
  if (!manifest) {
    try {
      manifest = await fetchManifest({ cacheDir: layout.cache, signal });
    } catch (e) {
      log(`Не удалось получить манифест: ${e.message}`);
    }
  }
  onProgress({ step: 'version', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
  const version = await loadVersionJson({ layout, versionId, manifest, signal, log });

  // Client jar + libraries + logging config
  const resolved = resolveLibraries(version.libraries, ctx, layout.libraries);
  const clientJar = layout.versionJar(version._jarId);
  const tasks = collectLibraryTasks(resolved);
  const client = version.downloads && version.downloads.client;
  if (client) tasks.push({ url: client.url, path: clientJar, sha1: client.sha1, size: client.size });
  let loggingConfig = null;
  const lc = version.logging && version.logging.client;
  if (lc && lc.file) {
    const p = path.join(layout.logConfigs, lc.file.id);
    tasks.push({ url: lc.file.url, path: p, sha1: lc.file.sha1, size: lc.file.size });
    loggingConfig = { path: p, argument: lc.argument, type: lc.type };
  }
  log(`Клиент и библиотеки: ${tasks.length} файлов`);
  const libStats = await downloadAll(tasks, {
    signal, concurrency, verifyExisting, verifyCache,
    onProgress: (p) => onProgress({ step: 'libraries', ...p }),
  });

  // Libraries that have no URL (e.g. locally supplied) must exist
  for (const lib of resolved) {
    if (lib.artifact && !lib.artifact.url && !(await isFileValid(lib.artifact.path))) {
      throw new Error(`Missing library without download URL: ${lib.name}`);
    }
  }

  if (nativesDir) {
    onProgress({ step: 'natives', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
    const nativesCount = await extractNatives(resolved, nativesDir, {
      cacheBase: nativesCacheBase,
      versionId: version.id,
    });
    log(`Нативные библиотеки: распаковано ${nativesCount} файлов`);
  }

  const assets = await installAssets({
    layout, version, gameDir, signal, concurrency, log,
    verifyExisting, verifyCache,
    onProgress: (p) => onProgress({ step: 'assets', ...p }),
  });

  // Loader versions (inheritsFrom) run from versions/<id>/<id>.jar like the official
  // launcher does; Forge's module ignoreList relies on ${version_name}.jar.
  let runJar = clientJar;
  if (version._inherited && version._jarId !== version.id) {
    runJar = layout.versionJar(version.id);
    await linkOrCopy(clientJar, runJar);
  }
  const classpath = [...classpathLibraries(resolved), runJar];
  return {
    version,
    classpath,
    clientJar: runJar,
    vanillaJar: clientJar,
    nativesDir,
    resolvedLibraries: resolved,
    assets,
    loggingConfig,
    stats: { libraries: libStats, assets: assets.stats, ms: Date.now() - t0 },
  };
}

module.exports = {
  installVersion,
  loadVersionJson,
  mergeVersions,
  extractNatives,
  classpathLibraries,
  collectLibraryTasks,
  installAssets,
  linkOrCopy,
  nativesCacheHash,
};
