'use strict';
/**
 * Per-profile content (mods, resource packs, shader packs): list, identify via
 * Modrinth hashes, install with required dependencies, enable/disable, remove,
 * check/apply updates. Metadata lives in <gameDir>/.forja/content.json.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { downloadAll, runPool } = require('./download');
const { writeJsonAtomicSync, readJsonSafeSync } = require('./atomic');
const { CONTENT_TYPES, primaryFile, pickBestVersion, loadersFor } = require('./modrinth');

const DISABLED = '.disabled';

async function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

function metaFile(gameDir) { return path.join(gameDir, '.forja', 'content.json'); }

function loadMeta(gameDir) {
  const raw = readJsonSafeSync(metaFile(gameDir));
  return raw && raw.files ? raw : { schemaVersion: 1, files: {}, hashCache: {} };
}

function saveMeta(gameDir, meta) {
  fs.mkdirSync(path.dirname(metaFile(gameDir)), { recursive: true });
  writeJsonAtomicSync(metaFile(gameDir), meta);
}

function folderFor(gameDir, type) {
  const t = CONTENT_TYPES[type];
  if (!t) throw new Error(`Unknown content type: ${type}`);
  return path.join(gameDir, t.folder);
}

/** Reject names that could escape the folder. */
function safeFileName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base === '.' || base === '..' || /[\\/]/.test(base)) {
    const err = new Error(`Unsafe file name: ${name}`);
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  return base;
}

function isContentFile(type, name) {
  const plain = name.endsWith(DISABLED) ? name.slice(0, -DISABLED.length) : name;
  return CONTENT_TYPES[type].exts.some((e) => plain.toLowerCase().endsWith(e));
}

/**
 * List installed files of a type with sha1 and any known Modrinth metadata.
 * @returns {Promise<Array<{file, enabled, size, sha1, projectId?, versionId?, title?, versionNumber?, iconUrl?}>>}
 */
async function listContent(gameDir, type) {
  const dir = folderFor(gameDir, type);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const meta = loadMeta(gameDir);
  const out = [];
  let dirty = false;
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!isContentFile(type, name)) continue;
    const abs = path.join(dir, name);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    const cacheKey = `${type}/${name}`;
    const c = meta.hashCache[cacheKey];
    let sha1 = c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.sha1 : null;
    if (!sha1) {
      sha1 = await hashFile(abs, 'sha1');
      meta.hashCache[cacheKey] = { size: st.size, mtimeMs: st.mtimeMs, sha1 };
      dirty = true;
    }
    const info = meta.files[sha1] || {};
    out.push({
      file: name,
      enabled: !name.endsWith(DISABLED),
      size: st.size,
      sha1,
      ...info,
    });
  }
  if (dirty) saveMeta(gameDir, meta);
  return out;
}

/** Identify unknown files by hash via Modrinth (/version_files + /projects). */
async function identifyContent(client, gameDir, entries, { signal } = {}) {
  const meta = loadMeta(gameDir);
  const unknown = entries.filter((e) => !meta.files[e.sha1] || !meta.files[e.sha1].checked);
  if (!unknown.length) return entries.map((e) => ({ ...e, ...(meta.files[e.sha1] || {}) }));
  const byHash = (await client.versionsByHashes(unknown.map((e) => e.sha1), { signal })) || {};
  const projectIds = [...new Set(Object.values(byHash).map((v) => v.project_id))];
  const projects = await client.projects(projectIds, { signal });
  const pmap = new Map((projects || []).map((p) => [p.id, p]));
  for (const e of unknown) {
    const v = byHash[e.sha1];
    const p = v && pmap.get(v.project_id);
    meta.files[e.sha1] = v
      ? {
        checked: true, projectId: v.project_id, versionId: v.id, versionNumber: v.version_number,
        title: p ? p.title : v.name, slug: p ? p.slug : null, iconUrl: p ? p.icon_url : null,
      }
      : { checked: true };
  }
  saveMeta(gameDir, meta);
  return entries.map((e) => ({ ...e, ...(meta.files[e.sha1] || {}) }));
}

async function setEnabled(gameDir, type, file, enabled) {
  const dir = folderFor(gameDir, type);
  const name = safeFileName(file);
  const isDisabled = name.endsWith(DISABLED);
  if (enabled === !isDisabled) return name;
  const next = enabled ? name.slice(0, -DISABLED.length) : `${name}${DISABLED}`;
  await fsp.rename(path.join(dir, name), path.join(dir, next));
  return next;
}

async function removeContent(gameDir, type, file) {
  const name = safeFileName(file);
  await fsp.rm(path.join(folderFor(gameDir, type), name), { force: true });
}

/**
 * Resolve required dependencies (recursively) for a Modrinth version.
 * @param {object} client ModrinthClient-like ({version, projectVersions})
 * @returns {Promise<{toInstall: object[], missing: object[], incompatible: object[]}>}
 */
async function resolveDependencies(client, rootVersion, {
  loaders = [], gameVersion, installedProjectIds = new Set(), signal, concurrency = 5,
} = {}) {
  const toInstall = [];
  const missing = [];
  const incompatible = [];
  const seen = new Set([rootVersion.project_id, ...installedProjectIds]);
  let queue = [rootVersion];
  while (queue.length) {
    // One BFS wave: collect lookups, fetch in parallel, then enqueue results.
    const wave = queue;
    queue = [];
    const lookups = [];
    const lookupKeys = new Set();
    for (const v of wave) {
      for (const dep of v.dependencies || []) {
        if (dep.dependency_type === 'incompatible') {
          if (dep.project_id && installedProjectIds.has(dep.project_id)) {
            incompatible.push({ of: v.project_id, projectId: dep.project_id });
          }
          continue;
        }
        if (dep.dependency_type !== 'required') continue;
        if (dep.project_id && seen.has(dep.project_id)) continue;
        const key = dep.version_id ? `v:${dep.version_id}` : `p:${dep.project_id}`;
        if (!dep.version_id && !dep.project_id) continue;
        if (lookupKeys.has(key)) continue;
        if (dep.project_id && lookupKeys.has(`p:${dep.project_id}`)) continue;
        lookupKeys.add(key);
        if (dep.project_id) lookupKeys.add(`p:${dep.project_id}`);
        lookups.push({ of: v.project_id, dep });
      }
    }
    if (!lookups.length) continue;
    const results = await runPool(lookups, concurrency, async ({ of, dep }) => {
      let depVersion = null;
      if (dep.version_id) depVersion = await client.version(dep.version_id, { signal });
      else if (dep.project_id) {
        const list = await client.projectVersions(dep.project_id, {
          loaders, gameVersions: gameVersion ? [gameVersion] : [], signal,
        });
        depVersion = pickBestVersion(list);
      }
      return { of, dep, depVersion };
    });
    for (const { of, dep, depVersion } of results) {
      if (!depVersion) {
        missing.push({ of, projectId: dep.project_id, versionId: dep.version_id, fileName: dep.file_name });
        if (dep.project_id) seen.add(dep.project_id);
        continue;
      }
      if (seen.has(depVersion.project_id)) continue;
      seen.add(depVersion.project_id);
      toInstall.push(depVersion);
      queue.push(depVersion);
    }
  }
  return { toInstall, missing, incompatible };
}

/** Download a version's primary file into the type folder, verify sha1 + sha512. */
async function installVersionFile(gameDir, type, version, { project = null, signal, onProgress, replaceFile = null } = {}) {
  const f = primaryFile(version);
  if (!f) throw new Error(`Version ${version.id} has no files`);
  const name = safeFileName(f.filename);
  const dir = folderFor(gameDir, type);
  const dest = path.join(dir, name);
  await downloadAll([{ url: f.url, path: dest, sha1: f.hashes && f.hashes.sha1, size: f.size }], { signal, onProgress });
  if (f.hashes && f.hashes.sha512) {
    const got = await hashFile(dest, 'sha512');
    if (got !== f.hashes.sha512) {
      await fsp.rm(dest, { force: true });
      const err = new Error(`SHA-512 mismatch for ${name}`);
      err.code = 'CHECKSUM';
      throw err;
    }
  }
  // Remove the previous file of the same project (update) unless it's the same name
  if (replaceFile && replaceFile !== name && replaceFile !== `${name}${DISABLED}`) {
    await fsp.rm(path.join(dir, safeFileName(replaceFile)), { force: true });
  }
  const meta = loadMeta(gameDir);
  meta.files[f.hashes.sha1] = {
    checked: true, projectId: version.project_id, versionId: version.id, versionNumber: version.version_number,
    title: project ? project.title : version.name, slug: project ? project.slug : null, iconUrl: project ? project.icon_url : null,
  };
  saveMeta(gameDir, meta);
  return { file: name, sha1: f.hashes.sha1 };
}

/**
 * Install a project into a profile (with required dependencies for mods).
 * @returns {Promise<{installed: Array<{projectId, file}>, missing, incompatible}>}
 */
async function installProject(client, { gameDir, type, projectId, versionId = null, loader, gameVersion, signal, onLog = () => {}, onProgress }) {
  const loaders = loadersFor(type, loader);
  let version;
  if (versionId) version = await client.version(versionId, { signal });
  else {
    const list = await client.projectVersions(projectId, { loaders, gameVersions: gameVersion ? [gameVersion] : [], signal });
    version = pickBestVersion(list);
  }
  if (!version) {
    const err = new Error(`No compatible version for ${projectId}`);
    err.code = 'NO_COMPATIBLE_VERSION';
    throw err;
  }
  const current = await identifyContent(client, gameDir, await listContent(gameDir, type), { signal }).catch(() => []);
  const installedIds = new Set(current.filter((e) => e.projectId).map((e) => e.projectId));
  const byProject = new Map(current.filter((e) => e.projectId).map((e) => [e.projectId, e]));
  let deps = { toInstall: [], missing: [], incompatible: [] };
  if (type === 'mod') {
    installedIds.delete(version.project_id);
    deps = await resolveDependencies(client, version, { loaders, gameVersion, installedProjectIds: installedIds, signal });
  }
  const all = [version, ...deps.toInstall];
  const projects = await client.projects([...new Set(all.map((v) => v.project_id))], { signal });
  const pmap = new Map((projects || []).map((p) => [p.id, p]));

  // Collect download tasks → single downloadAll (parallel), then verify sha512 + meta
  const planned = [];
  for (const v of all) {
    const f = primaryFile(v);
    if (!f) throw new Error(`Version ${v.id} has no files`);
    const name = safeFileName(f.filename);
    const dest = path.join(folderFor(gameDir, type), name);
    const prev = byProject.get(v.project_id);
    planned.push({ v, f, name, dest, prev });
    onLog(`Установка ${pmap.get(v.project_id) ? pmap.get(v.project_id).title : v.name} ${v.version_number}`);
  }
  await downloadAll(
    planned.map(({ f, dest }) => ({ url: f.url, path: dest, sha1: f.hashes && f.hashes.sha1, size: f.size })),
    { signal, onProgress },
  );
  const installed = [];
  const meta = loadMeta(gameDir);
  for (const { v, f, name, dest, prev } of planned) {
    if (f.hashes && f.hashes.sha512) {
      const got = await hashFile(dest, 'sha512');
      if (got !== f.hashes.sha512) {
        await fsp.rm(dest, { force: true });
        const err = new Error(`SHA-512 mismatch for ${name}`);
        err.code = 'CHECKSUM';
        throw err;
      }
    }
    if (prev && prev.file && prev.file !== name && prev.file !== `${name}${DISABLED}`) {
      await fsp.rm(path.join(folderFor(gameDir, type), safeFileName(prev.file)), { force: true });
    }
    const project = pmap.get(v.project_id);
    meta.files[f.hashes.sha1] = {
      checked: true, projectId: v.project_id, versionId: v.id, versionNumber: v.version_number,
      title: project ? project.title : v.name, slug: project ? project.slug : null, iconUrl: project ? project.icon_url : null,
    };
    installed.push({
      projectId: v.project_id,
      title: project ? project.title : v.name,
      file: name,
      dependency: v !== version,
    });
  }
  saveMeta(gameDir, meta);
  return { installed, missing: deps.missing, incompatible: deps.incompatible };
}

/** Check updates for identified files. @returns Array<{file, projectId, current, latest: version}> */
async function checkUpdates(client, gameDir, type, { loader, gameVersion, signal } = {}) {
  const entries = await identifyContent(client, gameDir, await listContent(gameDir, type), { signal });
  const known = entries.filter((e) => e.versionId);
  const latest = (await client.latestVersionsByHashes(known.map((e) => e.sha1), {
    loaders: loadersFor(type, loader), gameVersions: gameVersion ? [gameVersion] : [], signal,
  })) || {};
  return known
    .filter((e) => latest[e.sha1] && latest[e.sha1].id !== e.versionId)
    .map((e) => ({ file: e.file, enabled: e.enabled, projectId: e.projectId, title: e.title, current: e.versionNumber, latest: latest[e.sha1] }));
}

/** Apply updates returned by checkUpdates (keeps disabled state). */
async function applyUpdates(client, gameDir, type, updates, { signal, onLog = () => {} } = {}) {
  const done = [];
  for (const u of updates) {
    onLog(`Обновление ${u.title || u.file}: ${u.current} → ${u.latest.version_number}`);
    const project = await client.project(u.projectId, { signal }).catch(() => null);
    const r = await installVersionFile(gameDir, type, u.latest, { project, signal, replaceFile: u.file });
    if (!u.enabled) await setEnabled(gameDir, type, r.file, false);
    done.push({ ...u, file: r.file });
  }
  return done;
}

module.exports = {
  listContent, identifyContent, setEnabled, removeContent, resolveDependencies, installVersionFile,
  installProject, checkUpdates, applyUpdates, safeFileName, isContentFile, hashFile, folderFor, DISABLED,
};
