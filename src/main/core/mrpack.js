'use strict';
/**
 * Modrinth modpacks (.mrpack, https://support.modrinth.com/en/articles/8802351):
 * parse modrinth.index.json, download files (hash-checked, client env only),
 * apply overrides/ then client-overrides/, and create a profile with the
 * right Minecraft version + loader.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { downloadAll } = require('./download');
const { hashFile } = require('./content');

// Download hosts allowed by the .mrpack spec
const ALLOWED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];

const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };

function invalid(msg) {
  const err = new Error(`Invalid .mrpack: ${msg}`);
  err.code = 'MRPACK_INVALID';
  return err;
}

/** Normalise a pack-relative path; throws on absolute paths or traversal. */
function safeRelPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw invalid(`unsafe path ${p}`);
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) throw invalid(`unsafe path ${p}`);
  return parts.join('/');
}

function allowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Parse and validate modrinth.index.json.
 * @returns {{name, versionId, summary, mcVersion, loader:{type,version}, files: Array<{path, url, sha1, sha512, size, optional}>, skipped: string[]}}
 */
function parseIndex(index, { includeOptional = true } = {}) {
  if (!index || typeof index !== 'object') throw invalid('no index');
  if (index.formatVersion !== 1) throw invalid(`unsupported formatVersion ${index.formatVersion}`);
  if (index.game !== 'minecraft') throw invalid(`unsupported game ${index.game}`);
  const deps = index.dependencies || {};
  if (!deps.minecraft) throw invalid('missing minecraft dependency');
  let loader = { type: 'vanilla', version: null };
  for (const [key, type] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) {
      loader = { type, version: String(deps[key]) };
      break;
    }
  }
  const files = [];
  const skipped = [];
  for (const f of index.files || []) {
    const rel = safeRelPath(f.path);
    const env = f.env || {};
    if (env.client === 'unsupported') {
      skipped.push(rel);
      continue;
    }
    const optional = env.client === 'optional';
    if (optional && !includeOptional) {
      skipped.push(rel);
      continue;
    }
    const url = (f.downloads || []).find(allowedUrl);
    if (!url) throw invalid(`no allowed download for ${rel}`);
    if (!f.hashes || !f.hashes.sha1) throw invalid(`missing sha1 for ${rel}`);
    files.push({ path: rel, url, sha1: f.hashes.sha1, sha512: f.hashes.sha512 || null, size: f.fileSize, optional });
  }
  return {
    name: String(index.name || 'Modpack').slice(0, 40),
    versionId: index.versionId || null,
    summary: index.summary || '',
    mcVersion: String(deps.minecraft),
    loader,
    files,
    skipped,
  };
}

/**
 * Overrides to apply: `overrides/` first, then `client-overrides/` (wins).
 * @param {Array<{entryName, isDirectory}>} entries zip entries
 * @returns {Array<{rel, entry}>}
 */
function overrideEntries(entries) {
  const map = new Map();
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const e of entries) {
      if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
      const rel = safeRelPath(e.entryName.slice(prefix.length));
      map.set(rel, e);
    }
  }
  return [...map.entries()].map(([rel, entry]) => ({ rel, entry }));
}

/** Extract overrides/ then client-overrides/ into gameDir. @returns count */
async function applyOverrides(zip, gameDir) {
  const base = path.resolve(gameDir);
  const ov = overrideEntries(zip.getEntries());
  for (const { rel, entry } of ov) {
    const dest = path.join(base, ...rel.split('/'));
    if (!dest.startsWith(base + path.sep)) throw invalid(`unsafe override ${rel}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, entry.getData());
  }
  return ov.length;
}

function readPack(file) {
  const zip = new AdmZip(file);
  const idx = zip.getEntry('modrinth.index.json');
  if (!idx) throw invalid('modrinth.index.json not found');
  let index;
  try {
    index = JSON.parse(idx.getData().toString('utf8'));
  } catch {
    throw invalid('modrinth.index.json is not valid JSON');
  }
  return { zip, index };
}

/**
 * Install a .mrpack as a new profile.
 * @param {object} o
 * @param {import('./profiles').ProfileStore} o.profiles
 * @returns {Promise<{profile, files: number, overrides: number, skipped: string[]}>}
 */
async function installMrpack({ file, profiles, signal, onProgress = () => {}, onLog = () => {}, concurrency = 8, icon, source = null }) {
  const { zip, index } = readPack(file);
  const pack = parseIndex(index);
  onLog(`Модпак «${pack.name}» ${pack.versionId || ''}: Minecraft ${pack.mcVersion}, ${pack.loader.type} ${pack.loader.version || ''}, файлов ${pack.files.length}`);
  const profile = profiles.create({
    name: pack.name,
    versionId: pack.mcVersion,
    loader: pack.loader,
    icon: icon || { type: 'letter', letter: pack.name.charAt(0), color: '#14b8a6' },
    modpack: { name: pack.name, versionId: pack.versionId, source },
  });
  const gameDir = profile.gameDir;
  try {
    const tasks = pack.files.map((f) => ({ url: f.url, path: path.join(gameDir, ...f.path.split('/')), sha1: f.sha1, size: f.size }));
    await downloadAll(tasks, { signal, concurrency, onProgress: (p) => onProgress({ step: 'modpack', ...p }) });
    for (const f of pack.files) {
      if (!f.sha512) continue;
      const got = await hashFile(path.join(gameDir, ...f.path.split('/')), 'sha512');
      if (got !== f.sha512) {
        const err = new Error(`SHA-512 mismatch for ${f.path}`);
        err.code = 'CHECKSUM';
        throw err;
      }
    }
    const overrides = await applyOverrides(zip, gameDir);
    onLog(`Модпак установлен: ${pack.files.length} файлов, ${overrides} из overrides`);
    return { profile, files: pack.files.length, overrides, skipped: pack.skipped };
  } catch (err) {
    // Roll back the half-created profile
    try { profiles.remove(profile.id, { deleteFiles: true }); } catch { /* last profile etc. */ }
    throw err;
  }
}

module.exports = { parseIndex, overrideEntries, applyOverrides, safeRelPath, allowedUrl, readPack, installMrpack, ALLOWED_HOSTS, LOADER_KEYS };
