'use strict';
/**
 * "Verify & repair": re-check every file of a version (client, libraries,
 * assets, logging config) by SHA1 and the Java runtime (full SHA1, ignoring
 * the fast-path marker); re-download anything missing or corrupted.
 */
const { installVersion } = require('./install');
const { ensureJava } = require('./java');

async function repairVersion({ layout, versionId, gameDir, signal, onProgress, onLog, concurrency = 12, skipJava = false }) {
  const t0 = Date.now();
  const inst = await installVersion({ layout, versionId, gameDir, signal, onProgress, onLog, concurrency });
  let java = null;
  if (!skipJava) java = await ensureJava({ layout, version: inst.version, signal, onProgress, onLog, force: true, concurrency });
  const s = inst.stats;
  const sum = (k) => (s.libraries ? s.libraries[k] : 0) + (s.assets ? s.assets[k] : 0) + (java && java.stats ? java.stats[k] : 0);
  return {
    versionId: inst.version.id,
    checked: sum('files'),
    repaired: sum('downloaded'),
    repairedBytes: sum('bytes'),
    ms: Date.now() - t0,
  };
}

/**
 * Repair a whole profile: make sure its mod loader (if any) is installed,
 * then verify the resulting version chain like repairVersion.
 */
async function repairProfile({ layout, profile, signal, onProgress, onLog, concurrency = 12 }) {
  let versionId = profile.versionId;
  if (profile.loader && profile.loader.type !== 'vanilla') {
    const { ensureLoader } = require('./loaders');
    const res = await ensureLoader({
      layout, loader: profile.loader, mcVersion: profile.versionId, signal, onLog, onProgress, concurrency,
      prepareVanilla: async () => {
        const v = await installVersion({ layout, versionId: profile.versionId, gameDir: profile.gameDir, signal, onLog, concurrency });
        const javaPath = profile.java && profile.java.mode === 'custom' ? profile.java.path
          : (await ensureJava({ layout, version: v.version, signal, onLog, concurrency })).javaPath;
        return { clientJar: v.clientJar, javaPath };
      },
    });
    versionId = res.versionId;
  }
  return repairVersion({
    layout, versionId, gameDir: profile.gameDir, concurrency, signal, onProgress, onLog,
    skipJava: Boolean(profile.java && profile.java.mode === 'custom'),
  });
}

module.exports = { repairVersion, repairProfile };
