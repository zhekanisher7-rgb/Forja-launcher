'use strict';
const os = require('node:os');

/** Mojang rule OS name */
function mojangOsName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'osx';
  return 'linux';
}

/** Mojang rule arch ("x86" means 32-bit in legacy rules) */
function mojangArch(arch = process.arch) {
  switch (arch) {
    case 'ia32': return 'x86';
    case 'x64': return 'x86_64';
    case 'arm64': return 'arm64';
    case 'arm': return 'arm32';
    default: return arch;
  }
}

/** Default rule-evaluation context for the current machine */
function currentContext(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const arch = overrides.arch || process.arch;
  return {
    platform,
    arch,
    osName: mojangOsName(platform),
    osArch: mojangArch(arch),
    osVersion: overrides.osVersion != null ? overrides.osVersion : os.release(),
    features: overrides.features || {},
  };
}

function classpathSeparator(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

module.exports = { mojangOsName, mojangArch, currentContext, classpathSeparator };
