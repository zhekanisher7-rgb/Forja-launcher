'use strict';
/**
 * Mod pack auto-repair: detect incompatible / duplicate / conflicting mods and
 * missing required dependencies for a profile (MC version + loader), and
 * propose fixes from Modrinth. Replaced or removed jars are moved into
 * <gameDir>/.forja-backup/<timestamp>/ so every repair is reversible.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { runPool } = require('./download');
const { pickBestVersion, loadersFor } = require('./modrinth');
const content = require('./content');

const BACKUP_DIR = '.forja-backup';

function builtFor(version, gameVersion, loaders) {
  if (!version) return false;
  const gv = version.game_versions || [];
  const lv = version.loaders || [];
  const okGame = !gameVersion || gv.includes(gameVersion);
  const okLoader = !loaders.length || lv.some((l) => loaders.includes(l));
  return okGame && okLoader;
}

const newer = (a, b) => (Date.parse((a && a.date_published) || 0) || 0) >= (Date.parse((b && b.date_published) || 0) || 0);

/**
 * Analyse installed (enabled) mods of a profile.
 * @param {object} client ModrinthClient-like: versionsByHashes, projectVersions, projects
 * @param {{entries: Array, loader: string, gameVersion: string}} opts entries = content.listContent(+identify) result
 * @returns {Promise<{issues: Array, unknown: Array, checked: number}>}
 * issue: {id, kind: 'incompatible'|'duplicate'|'conflict'|'missingDep', file?, projectId, title, fix: {action: 'replace'|'install'|'remove'|'disable'|'none', version?}}
 */
async function analyzeMods(client, { entries, loader, gameVersion, signal, concurrency = 4 }) {
  const loaders = loadersFor('mod', loader);
  const enabled = (entries || []).filter((e) => e.enabled && e.sha1);
  const issues = [];
  const unknown = [];
  if (!enabled.length || !loaders.length) return { issues, unknown, checked: 0 };

  const byHash = (await client.versionsByHashes(enabled.map((e) => e.sha1), { signal })) || {};
  const known = [];
  for (const e of enabled) {
    const v = byHash[e.sha1];
    if (v && v.project_id) known.push({ ...e, projectId: v.project_id, version: v });
    else unknown.push({ file: e.file, title: e.title || e.file });
  }
  const titleOf = new Map(known.map((k) => [k.projectId, k.title || k.version.name || k.file]));

  // 1) duplicates of the same project: keep the best (compatible, then newest)
  const groups = new Map();
  for (const k of known) {
    if (!groups.has(k.projectId)) groups.set(k.projectId, []);
    groups.get(k.projectId).push(k);
  }
  const keep = new Map(); // projectId -> entry
  for (const [pid, list] of groups) {
    let best = list[0];
    for (const k of list.slice(1)) {
      const bOk = builtFor(best.version, gameVersion, loaders);
      const kOk = builtFor(k.version, gameVersion, loaders);
      if ((kOk && !bOk) || (kOk === bOk && newer(k.version, best.version))) best = k;
    }
    keep.set(pid, best);
    for (const k of list) {
      if (k === best) continue;
      issues.push({
        id: `dup:${k.file}`, kind: 'duplicate', file: k.file, projectId: pid, title: titleOf.get(pid),
        current: k.version.version_number, keepFile: best.file, fix: { action: 'remove' },
      });
    }
  }

  // 2) wrong MC version / loader → best compatible version of the same project
  const wrong = [...keep.values()].filter((k) => !builtFor(k.version, gameVersion, loaders));
  const finalVersion = new Map([...keep].map(([pid, k]) => [pid, k.version]));
  const repl = await runPool(wrong, concurrency, async (k) => {
    const list = await client.projectVersions(k.projectId, { loaders, gameVersions: gameVersion ? [gameVersion] : [], signal });
    return pickBestVersion((list || []).filter((v) => builtFor(v, gameVersion, loaders)));
  });
  wrong.forEach((k, i) => {
    const v = repl[i];
    if (v) finalVersion.set(k.projectId, v);
    else finalVersion.delete(k.projectId);
    issues.push({
      id: `inc:${k.file}`, kind: 'incompatible', file: k.file, projectId: k.projectId, title: titleOf.get(k.projectId),
      current: k.version.version_number, builtFor: { gameVersions: k.version.game_versions || [], loaders: k.version.loaders || [] },
      fix: v ? { action: 'replace', version: v } : { action: 'disable' },
    });
  });

  // 3) declared incompatibilities between mods that stay installed
  const present = new Set(finalVersion.keys());
  const presentVersionIds = new Set([...finalVersion.values()].map((v) => v.id));
  const conflictSeen = new Set();
  for (const [pid, v] of finalVersion) {
    for (const d of v.dependencies || []) {
      if (d.dependency_type !== 'incompatible') continue;
      const other = d.project_id && present.has(d.project_id) ? d.project_id
        : [...finalVersion].find(([, ov]) => d.version_id && ov.id === d.version_id && presentVersionIds.has(d.version_id))?.[0];
      if (!other || other === pid) continue;
      const key = [pid, other].sort().join('|');
      if (conflictSeen.has(key)) continue;
      conflictSeen.add(key);
      const target = keep.get(other);
      issues.push({
        id: `con:${target.file}`, kind: 'conflict', file: target.file, projectId: other, title: titleOf.get(other),
        with: { projectId: pid, title: titleOf.get(pid), file: keep.get(pid).file }, fix: { action: 'disable' },
      });
    }
  }
  const disabledByConflict = new Set(issues.filter((i) => i.kind === 'conflict').map((i) => i.projectId));

  // 4) missing required dependencies (recursive, via resolveDependencies on a synthetic root)
  const owner = new Map();
  const rootDeps = [];
  for (const [pid, v] of finalVersion) {
    if (disabledByConflict.has(pid)) continue;
    for (const d of v.dependencies || []) {
      if (d.dependency_type !== 'required' || !d.project_id || present.has(d.project_id) || owner.has(d.project_id)) continue;
      owner.set(d.project_id, pid);
      rootDeps.push({ project_id: d.project_id, dependency_type: 'required' });
    }
  }
  if (rootDeps.length) {
    const res = await content.resolveDependencies(client, { project_id: '__root__', dependencies: rootDeps }, {
      loaders, gameVersion, installedProjectIds: present, signal, concurrency,
    });
    const pids = [...new Set([...res.toInstall.map((v) => v.project_id), ...res.missing.map((m) => m.projectId).filter(Boolean)])];
    const projects = pids.length ? await client.projects(pids, { signal }).catch(() => []) : [];
    const pmap = new Map((projects || []).map((p) => [p.id, p]));
    const nameOf = (id) => (pmap.get(id) && pmap.get(id).title) || id;
    for (const v of res.toInstall) {
      const of = owner.get(v.project_id);
      issues.push({
        id: `dep:${v.project_id}`, kind: 'missingDep', projectId: v.project_id, title: nameOf(v.project_id),
        requiredBy: of ? titleOf.get(of) : null, fix: { action: 'install', version: v },
      });
    }
    for (const mi of res.missing) {
      if (!mi.projectId) continue;
      const of = owner.get(mi.projectId);
      issues.push({
        id: `dep:${mi.projectId}`, kind: 'missingDep', projectId: mi.projectId, title: nameOf(mi.projectId),
        requiredBy: of ? titleOf.get(of) : null, fix: { action: 'none' },
      });
    }
  }
  return { issues, unknown, checked: enabled.length };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

/**
 * Apply selected fixes. Old jars are moved (not deleted) into the backup folder.
 * @returns {Promise<{applied: string[], failed: Array<{id, message}>, backupDir: string|null}>}
 */
async function applyFixes(client, gameDir, issues, { signal, onLog = () => {}, now = new Date() } = {}) {
  const modsDir = content.folderFor(gameDir, 'mod');
  const backupDir = path.join(gameDir, BACKUP_DIR, stamp(now));
  let backedUp = false;
  const backup = async (file) => {
    const name = content.safeFileName(file);
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.rename(path.join(modsDir, name), path.join(backupDir, name));
    backedUp = true;
  };
  const applied = [];
  const failed = [];
  for (const is of issues) {
    try {
      const a = is.fix && is.fix.action;
      if (a === 'replace') {
        onLog(`Repair: ${is.title || is.file} → ${is.fix.version.version_number}`);
        await backup(is.file);
        try {
          await content.installVersionFile(gameDir, 'mod', is.fix.version, { project: { title: is.title, slug: null, icon_url: null }, signal });
        } catch (err) { // restore original on failure
          await fsp.rename(path.join(backupDir, is.file), path.join(modsDir, is.file)).catch(() => {});
          throw err;
        }
      } else if (a === 'install') {
        onLog(`Repair: install dependency ${is.title} ${is.fix.version.version_number}`);
        await content.installVersionFile(gameDir, 'mod', is.fix.version, { project: { title: is.title, slug: null, icon_url: null }, signal });
      } else if (a === 'remove' || a === 'disable') {
        onLog(`Repair: move ${is.file} to backup`);
        await backup(is.file);
      } else continue;
      applied.push(is.id);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      failed.push({ id: is.id, message: String(err && err.message) });
    }
  }
  return { applied, failed, backupDir: backedUp ? backupDir : null };
}

/** List backup folders (newest first). */
async function listBackups(gameDir) {
  const names = await fsp.readdir(path.join(gameDir, BACKUP_DIR)).catch(() => []);
  return names.sort().reverse();
}

/** Move all jars of a backup back into mods/ (does not delete newer replacements). */
async function restoreBackup(gameDir, name) {
  const dir = path.join(gameDir, BACKUP_DIR, content.safeFileName(name));
  const modsDir = content.folderFor(gameDir, 'mod');
  await fsp.mkdir(modsDir, { recursive: true });
  const restored = [];
  for (const f of await fsp.readdir(dir)) {
    await fsp.rename(path.join(dir, f), path.join(modsDir, f));
    restored.push(f);
  }
  await fsp.rmdir(dir).catch(() => {});
  return restored;
}

/** Cheap fingerprint for result caching. */
function fingerprint(entries, loader, gameVersion) {
  return [loader, gameVersion, ...(entries || []).filter((e) => e.enabled).map((e) => e.sha1).sort()].join(';');
}

module.exports = { analyzeMods, applyFixes, listBackups, restoreBackup, fingerprint, builtFor, BACKUP_DIR };
