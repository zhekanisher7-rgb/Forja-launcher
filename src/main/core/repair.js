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

module.exports = { repairVersion };
