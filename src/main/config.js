'use strict';
/**
 * Central branding / identity config. Rename the launcher here only.
 */
const pkg = require('../../package.json');

module.exports = Object.freeze({
  // Human-readable name (used for Windows/macOS data dir and window title)
  name: 'Forja Launcher',
  // Machine name (used for Linux data dir, ${launcher_name})
  id: 'forja-launcher',
  version: pkg.version,
  defaultLanguage: 'ru',
  userAgent: `ForjaLauncher/${pkg.version} (+https://github.com/)`,
  // Official Mojang endpoints
  endpoints: {
    versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    librariesBase: 'https://libraries.minecraft.net/',
    resourcesBase: 'https://resources.download.minecraft.net/',
    javaRuntimeManifest:
      'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
    adoptiumApi: 'https://api.adoptium.net/v3',
  },
});
