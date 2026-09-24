'use strict';
/**
 * Per-launch natives directories: <data>/tmp/natives/<version>-<random>/
 * Each dir carries an owner file with the launcher and game PIDs so stale
 * dirs (e.g. launcher closed while game ran) can be swept on next start.
 * Kept inside the data dir (not %TEMP%) so it sits on the same drive and
 * is easy to find/clean.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const OWNER = '.forja-owner.json';

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

async function createNativesDir(baseDir, versionId) {
  await fsp.mkdir(baseDir, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(baseDir, `${safeName(versionId)}-`));
  await writeOwner(dir, { launcherPid: process.pid, gamePid: null, created: Date.now() });
  return dir;
}

async function writeOwner(dir, data) {
  let cur = {};
  try { cur = JSON.parse(await fsp.readFile(path.join(dir, OWNER), 'utf8')); } catch { /* new */ }
  await fsp.writeFile(path.join(dir, OWNER), JSON.stringify({ ...cur, ...data }));
}

async function cleanupNativesDir(dir) {
  // maxRetries handles EBUSY/EPERM on Windows right after the JVM exits
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Remove natives dirs whose launcher and game processes are both gone.
 * @returns {Promise<string[]>} removed dirs
 */
async function sweepStaleNativesDirs(baseDir, { minAgeMs = 60 * 1000, isAlive = pidAlive } = {}) {
  let entries = [];
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(baseDir, e.name);
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8')); } catch { /* none */ }
    const created = owner && owner.created ? owner.created : (await fsp.stat(dir)).mtimeMs;
    if (Date.now() - created < minAgeMs) continue;
    const alive = owner && ((owner.launcherPid !== process.pid && isAlive(owner.launcherPid)) || isAlive(owner.gamePid));
    if (alive) continue;
    try {
      await cleanupNativesDir(dir);
      removed.push(dir);
    } catch { /* locked: try next time */ }
  }
  return removed;
}

module.exports = { createNativesDir, cleanupNativesDir, sweepStaleNativesDirs, writeOwner, pidAlive };
