'use strict';
/**
 * Install a Minecraft version: version JSON, client jar, libraries,
 * natives, asset index + objects (incl. legacy/virtual), logging config.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const config = require('../config');
const { fetchJson } = require('./http');
const { downloadAll, isFileValid, CancelledError } = require('./download');
const { resolveLibraries } = require('./library');
const { currentContext } = require('./platform');
const { findVersion, fetchManifest } = require('./versions');

const NATIVE_EXT = /\.(so|dll|dylib|jnilib)$/i;

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    };
  }
  merged.downloads = child.downloads || parent.downloads;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  merged._jarId = child.jar || parent._jarId || parent.id;
  delete merged.inheritsFrom;
  return merged;
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

async function extractNatives(resolved, nativesDir) {
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });
  let count = 0;
  for (const lib of resolved) {
    // Legacy classifier natives: extract all (except excludes)
    if (lib.native) {
      const excludes = (lib.extract && lib.extract.exclude) || ['META-INF/'];
      const zip = new AdmZip(lib.native.path);
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (excludes.some((x) => e.entryName.startsWith(x))) continue;
        const dest = path.join(nativesDir, e.entryName);
        if (!dest.startsWith(nativesDir + path.sep)) continue; // zip-slip guard
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, e.getData());
        count++;
      }
    }
    // Modern natives-as-libraries: flatten native binaries for our arch
    if (lib.modernNative && lib.modernNativeForArch && lib.artifact) {
      const zip = new AdmZip(lib.artifact.path);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || e.entryName.startsWith('META-INF/')) continue;
        if (!NATIVE_EXT.test(e.entryName)) continue;
        await fsp.writeFile(path.join(nativesDir, path.basename(e.entryName)), e.getData());
        count++;
      }
    }
  }
  return count;
}

/**
 * Download asset index + objects. Handles legacy "virtual" and
 * "map_to_resources" (pre-1.6) index types.
 */
async function installAssets({ layout, version, gameDir, signal, onProgress, concurrency, log }) {
  const ai = version.assetIndex;
  if (!ai) return { indexId: version.assets || 'legacy', stats: null, virtualDir: null };
  const indexPath = path.join(layout.assetIndexes, `${ai.id}.json`);
  await downloadAll([{ url: ai.url, path: indexPath, sha1: ai.sha1, size: ai.size }], { signal });
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
  const stats = await downloadAll(tasks, { signal, onProgress, concurrency });

  let virtualDir = null;
  const copyTo = async (baseDir) => {
    for (const [name, o] of objects) {
      if (signal && signal.aborted) throw new CancelledError();
      const dest = path.join(baseDir, ...name.split('/'));
      if (await isFileValid(dest, { size: o.size })) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(layout.assetObjects, o.hash.slice(0, 2), o.hash), dest);
    }
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
}) {
  const log = onLog;
  const t0 = Date.now();
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
    signal, concurrency, onProgress: (p) => onProgress({ step: 'libraries', ...p }),
  });

  // Libraries that have no URL (e.g. locally supplied) must exist
  for (const lib of resolved) {
    if (lib.artifact && !lib.artifact.url && !(await isFileValid(lib.artifact.path))) {
      throw new Error(`Missing library without download URL: ${lib.name}`);
    }
  }

  if (nativesDir) {
    onProgress({ step: 'natives', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
    const nativesCount = await extractNatives(resolved, nativesDir);
    log(`Нативные библиотеки: распаковано ${nativesCount} файлов`);
  }

  const assets = await installAssets({
    layout, version, gameDir, signal, concurrency, log,
    onProgress: (p) => onProgress({ step: 'assets', ...p }),
  });

  const classpath = [...classpathLibraries(resolved), clientJar];
  return {
    version,
    classpath,
    clientJar,
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
};
