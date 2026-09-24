'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { fetchJson } = require('./http');

const MANIFEST_FILE = 'version_manifest_v2.json';

/**
 * Fetch the Mojang version manifest, caching it in cacheDir.
 * Falls back to the cached copy when offline.
 */
async function fetchManifest({ cacheDir, maxAgeMs = 10 * 60 * 1000, signal, force = false,
  url = config.endpoints.versionManifest } = {}) {
  const cacheFile = cacheDir ? path.join(cacheDir, MANIFEST_FILE) : null;
  if (cacheFile && !force) {
    try {
      const st = await fsp.stat(cacheFile);
      if (Date.now() - st.mtimeMs < maxAgeMs) {
        return JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      }
    } catch { /* no cache */ }
  }
  try {
    const manifest = await fetchJson(url, { signal });
    if (cacheFile) {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(manifest));
    }
    return manifest;
  } catch (err) {
    if (cacheFile) {
      try {
        const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
        cached._offline = true;
        return cached;
      } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Filter versions list.
 * @param {Array} versions manifest.versions
 * @param {{release?:boolean, snapshot?:boolean, old?:boolean, query?:string}} f
 */
function filterVersions(versions, { release = true, snapshot = false, old = false, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return versions.filter((v) => {
    const typeOk = (v.type === 'release' && release)
      || (v.type === 'snapshot' && snapshot)
      || ((v.type === 'old_beta' || v.type === 'old_alpha') && old);
    if (!typeOk) return false;
    return !q || v.id.toLowerCase().includes(q);
  });
}

function findVersion(manifest, id) {
  return manifest.versions.find((v) => v.id === id) || null;
}

/** List versions installed locally (have a version JSON). */
async function listInstalled(layout) {
  let entries = [];
  try {
    entries = await fsp.readdir(layout.versions, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const json = JSON.parse(await fsp.readFile(layout.versionJson(e.name), 'utf8'));
      out.push({ id: json.id || e.name, type: json.type, releaseTime: json.releaseTime, local: true });
    } catch { /* not a version dir */ }
  }
  return out;
}

module.exports = { fetchManifest, filterVersions, findVersion, listInstalled };
