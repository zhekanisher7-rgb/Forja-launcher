'use strict';
/**
 * Generic `inheritsFrom` merge used by every loader (Fabric, Quilt, Forge,
 * NeoForge) — same semantics as the official launcher:
 *  - libraries: child first, then parent; duplicates (same group:artifact[:classifier])
 *    are dropped with the child's version winning;
 *  - arguments.game / arguments.jvm: parent first, then child (appended);
 *  - minecraftArguments (legacy): child replaces parent;
 *  - mainClass, id, type, releaseTime: child wins;
 *  - downloads/assetIndex/assets/javaVersion/logging: child if present, else parent.
 */
const { libraryKey } = require('../library');

function safeKey(lib) {
  try {
    return libraryKey(lib.name);
  } catch {
    return `raw:${lib && lib.name}`;
  }
}

/** Child-first library concat without duplicates. Natives entries keep their own key. */
function mergeLibraries(childLibs = [], parentLibs = []) {
  const out = [];
  const seen = new Set();
  for (const lib of [...childLibs, ...parentLibs]) {
    if (!lib || !lib.name) continue;
    // Legacy natives entries and plain entries of the same artifact must coexist
    // (e.g. lwjgl-platform with `natives` map), so include natives flag in key.
    const key = `${safeKey(lib)}${lib.natives ? '#natives' : ''}${lib.rules ? `#${JSON.stringify(lib.rules)}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  return out;
}

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  merged.libraries = mergeLibraries(child.libraries, parent.libraries);
  const pa = parent.arguments || null;
  const ca = child.arguments || null;
  if (pa || ca) {
    merged.arguments = {
      game: [...((pa && pa.game) || []), ...((ca && ca.game) || [])],
      jvm: [...((pa && pa.jvm) || []), ...((ca && ca.jvm) || [])],
    };
  }
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  if (!merged.minecraftArguments) delete merged.minecraftArguments;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.downloads = child.downloads || parent.downloads;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  // Client jar: the child's own download if it has one, else the parent's jar
  merged._jarId = (child.downloads && child.downloads.client) ? child.id : (child.jar || parent._jarId || parent.id);
  merged._chain = [child.id, ...(parent._chain || [parent.id])];
  merged._inherited = true;
  delete merged.inheritsFrom;
  return merged;
}

module.exports = { mergeVersions, mergeLibraries };
