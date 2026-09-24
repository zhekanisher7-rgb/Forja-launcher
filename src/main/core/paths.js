'use strict';
const os = require('node:os');
const path = require('node:path');
const config = require('../config');

/**
 * Launcher data directory per OS. Kept separate from vanilla .minecraft.
 *  Windows: %APPDATA%/<Name>
 *  macOS:   ~/Library/Application Support/<Name>
 *  Linux:   $XDG_DATA_HOME/<id> or ~/.local/share/<id>
 */
function getDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  name = config.name,
  id = config.id,
} = {}) {
  if (env.FORJA_DATA_DIR) return path.resolve(env.FORJA_DATA_DIR);
  const p = platform === 'win32' ? path.win32 : path.posix;
  switch (platform) {
    case 'win32':
      return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), name);
    case 'darwin':
      return p.join(home, 'Library', 'Application Support', name);
    default:
      return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), id);
  }
}

/** Directory layout inside a root dir. All core modules accept a layout. */
function createLayout(root = getDataDir()) {
  const j = (...a) => path.join(root, ...a);
  return {
    root,
    versions: j('versions'),
    libraries: j('libraries'),
    assets: j('assets'),
    assetIndexes: j('assets', 'indexes'),
    assetObjects: j('assets', 'objects'),
    logConfigs: j('assets', 'log_configs'),
    runtime: j('runtime'),
    instances: j('instances'),
    cache: j('cache'),
    nativesTmp: j('tmp', 'natives'),
    settingsFile: j('settings.json'),
    versionDir: (id) => j('versions', id),
    versionJson: (id) => j('versions', id, `${id}.json`),
    versionJar: (id) => j('versions', id, `${id}.jar`),
    instanceDir: (name = 'default') => j('instances', name),
  };
}

module.exports = { getDataDir, createLayout };
