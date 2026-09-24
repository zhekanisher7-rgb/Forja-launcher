'use strict';
/**
 * High-level orchestration: install version → ensure Java → build → spawn.
 * Used by both the Electron main process and headless scripts.
 */
const path = require('node:path');
const { installVersion } = require('./install');
const { ensureJava } = require('./java');
const { buildLaunchCommand, launchGame, redactArgs } = require('./launch');
const { currentContext } = require('./platform');

async function prepareAndLaunch({
  layout,
  versionId,
  session,
  manifest,
  gameDir = layout.instanceDir('default'),
  memory = { min: 512, max: 2048 },
  resolution = null,
  javaPath: customJava = null,
  extraJvmArgs = [],
  env = process.env,
  signal,
  onProgress = () => {},
  onLog = () => {},
  onGameLog = (line) => onLog(line),
}) {
  const ctx = currentContext();
  const inst = await installVersion({ layout, versionId, manifest, gameDir, signal, onProgress, onLog, ctx });
  let javaPath = customJava;
  if (!javaPath) {
    const java = await ensureJava({ layout, version: inst.version, signal, onProgress, onLog });
    javaPath = java.javaPath;
  }
  if (signal && signal.aborted) {
    const { CancelledError } = require('./download');
    throw new CancelledError();
  }
  onProgress({ step: 'launch', doneFiles: 1, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
  const cmd = buildLaunchCommand({
    version: inst.version,
    classpath: inst.classpath,
    javaPath,
    session,
    gameDir,
    assetsRoot: layout.assets,
    assetsIndexName: inst.assets.indexId,
    virtualAssetsDir: inst.assets.virtualDir,
    nativesDir: inst.nativesDir,
    librariesDir: layout.libraries,
    loggingConfig: inst.loggingConfig,
    memory,
    resolution,
    extraJvmArgs,
    ctx,
  });
  onLog(`Запуск: ${path.basename(javaPath)} ${redactArgs(cmd.args, session.accessToken)
    .map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ')}`);
  const game = launchGame(cmd, { onLog: onGameLog, env, xmlLogs: Boolean(inst.loggingConfig) });
  return { ...game, cmd, install: inst };
}

module.exports = { prepareAndLaunch };
