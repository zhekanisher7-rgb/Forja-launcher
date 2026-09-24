'use strict';
/**
 * High-level orchestration: install version → ensure Java → per-launch
 * natives dir → build → spawn. Used by the GameManager and headless scripts.
 */
const path = require('node:path');
const { installVersion, extractNatives } = require('./install');
const { ensureJava, checkCustomJava, requiredJava } = require('./java');
const { buildLaunchCommand, launchGame, redactArgs } = require('./launch');
const { currentContext } = require('./platform');
const { createNativesDir, cleanupNativesDir, writeOwner } = require('./natives');
const { CancelledError } = require('./download');
const { ensureLoader } = require('./loaders');

function nativesBase(layout) {
  return layout.nativesTmp || path.join(layout.root, 'tmp', 'natives');
}

async function prepareAndLaunch({
  layout,
  versionId: mcVersionId,
  loader = null, // { type, version } — null/vanilla = plain Minecraft
  onLoaderResolved = () => {},
  session,
  manifest,
  gameDir = layout.instanceDir('default'),
  memory = { min: 512, max: 2048 },
  resolution = null, // { width, height, fullscreen }
  javaPath: customJava = null,
  extraJvmArgs = [],
  concurrency = 12,
  detached = false,
  env = process.env,
  signal,
  onProgress = () => {},
  onLog = () => {},
  onGameLog = (line) => onLog(line),
}) {
  const ctx = currentContext();
  const resolveJava = async (version) => {
    if (!customJava) {
      const java = await ensureJava({ layout, version, signal, onProgress, onLog, concurrency });
      return java.javaPath;
    }
    const probe = await checkCustomJava(customJava);
    const req = requiredJava(version);
    onLog(`Своя Java: ${customJava} (major ${probe.major})`);
    if (probe.major < req.majorVersion) {
      onLog(`ВНИМАНИЕ: версии ${version.id} нужна Java ${req.majorVersion}+, выбрана ${probe.major}`);
    }
    return customJava;
  };

  let versionId = mcVersionId;
  if (loader && loader.type && loader.type !== 'vanilla') {
    const res = await ensureLoader({
      layout, loader, mcVersion: mcVersionId, signal, onLog, onProgress, concurrency,
      prepareVanilla: async () => {
        const v = await installVersion({ layout, versionId: mcVersionId, manifest, gameDir, signal, onProgress, onLog, ctx, concurrency });
        return { clientJar: v.clientJar, javaPath: await resolveJava(v.version) };
      },
    });
    versionId = res.versionId;
    onLoaderResolved(res);
  }
  const inst = await installVersion({ layout, versionId, manifest, gameDir, signal, onProgress, onLog, ctx, concurrency });

  const javaPath = await resolveJava(inst.version);
  if (signal && signal.aborted) throw new CancelledError();

  // Unique natives dir for this launch (avoids Windows file locks when the
  // same version runs twice or is repaired while running).
  onProgress({ step: 'natives', doneFiles: 0, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
  const nativesDir = await createNativesDir(nativesBase(layout), inst.version.id);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanupNativesDir(nativesDir).catch(() => {});
  };
  try {
    const count = await extractNatives(inst.resolvedLibraries, nativesDir);
    onLog(`Нативные библиотеки: ${count} файлов → ${nativesDir}`);

    onProgress({ step: 'launch', doneFiles: 1, totalFiles: 1, doneBytes: 0, totalBytes: 0 });
    const res = resolution && resolution.width && resolution.height ? resolution : null;
    const cmd = buildLaunchCommand({
      version: inst.version,
      classpath: inst.classpath,
      javaPath,
      session,
      gameDir,
      assetsRoot: layout.assets,
      assetsIndexName: inst.assets.indexId,
      virtualAssetsDir: inst.assets.virtualDir,
      nativesDir,
      librariesDir: layout.libraries,
      loggingConfig: inst.loggingConfig,
      memory,
      resolution: res,
      extraJvmArgs,
      extraGameArgs: resolution && resolution.fullscreen ? ['--fullscreen'] : [],
      ctx,
    });
    onLog(`Запуск: ${path.basename(javaPath)} ${redactArgs(cmd.args, session.accessToken)
      .map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ')}`);
    const game = launchGame(cmd, { onLog: onGameLog, env, xmlLogs: Boolean(inst.loggingConfig), detached });
    if (game.child.pid) writeOwner(nativesDir, { gamePid: game.child.pid }).catch(() => {});
    // Clean natives after the game exits (or fails to spawn)
    const exited = game.exited.finally(cleanup);
    return { child: game.child, exited, cmd, install: inst, nativesDir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

module.exports = { prepareAndLaunch, nativesBase };
