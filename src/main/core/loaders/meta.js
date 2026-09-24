'use strict';
/**
 * Fabric (meta.fabricmc.net/v2) and Quilt (meta.quiltmc.org/v3) — both expose a
 * ready-made launcher profile JSON that `inheritsFrom` the vanilla version.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchJson } = require('../http');

const META = {
  fabric: { base: 'https://meta.fabricmc.net/v2', name: 'Fabric' },
  quilt: { base: 'https://meta.quiltmc.org/v3', name: 'Quilt' },
};

/** Compare dotted versions with optional -beta.N suffix (numeric-aware). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return /^\d+$/.test(y) ? -1 : 1; // 1.0 < 1.0.1, 1.0 > 1.0-beta
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isStableLoaderVersion(type, entry) {
  if (type === 'fabric') return entry.stable !== false;
  return !/beta|alpha|pre|rc/i.test(entry.version);
}

/** @returns {Promise<Array<{version, stable}>>} newest first */
async function listVersions(type, mcVersion, { signal } = {}) {
  const m = META[type];
  const list = await fetchJson(`${m.base}/versions/loader/${encodeURIComponent(mcVersion)}`, { signal });
  return list
    .map((e) => ({ version: e.loader.version, stable: isStableLoaderVersion(type, e.loader) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

function versionId(type, mcVersion, loaderVersion) {
  return `${type}-loader-${loaderVersion}-${mcVersion}`;
}

/** Download the profile JSON into versions/<id>/<id>.json. */
async function install({ type, layout, mcVersion, loaderVersion, signal, onLog = () => {} }) {
  const m = META[type];
  const id = versionId(type, mcVersion, loaderVersion);
  const file = layout.versionJson(id);
  try {
    const cur = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (cur.id === id && cur.inheritsFrom === mcVersion) return { versionId: id };
  } catch { /* not installed */ }
  onLog(`${m.name} ${loaderVersion}: загрузка профиля`);
  const json = await fetchJson(
    `${m.base}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    { signal },
  );
  json.id = id; // keep our deterministic id
  if (json.inheritsFrom !== mcVersion) throw new Error(`Unexpected ${m.name} profile for ${mcVersion}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(json, null, 2));
  return { versionId: id };
}

module.exports = { listVersions, install, versionId, compareVersions, META };
