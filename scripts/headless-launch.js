#!/usr/bin/env node
'use strict';
/**
 * Headless (no Electron) install + launch using core modules only.
 * Usage: node scripts/headless-launch.js <version> [username] [--data DIR] [--game-dir DIR] [--timeout SEC]
 *        [--loader fabric|quilt|forge|neoforge[:loaderVersion]]
 * Env: DISPLAY, LIBGL_ALWAYS_SOFTWARE=1 recommended on GPU-less boxes.
 */
const path = require('node:path');
const { createLayout, getDataDir } = require('../src/main/core/paths');
const { createOfflineSession } = require('../src/main/auth/offline');
const { prepareAndLaunch } = require('../src/main/core/launcher');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const dataDir = opt('--data', getDataDir());
const timeout = Number(opt('--timeout', '0'));
const gameDirOpt = opt('--game-dir', null);
const loaderOpt = opt('--loader', null);
const loader = loaderOpt ? { type: loaderOpt.split(':')[0], version: loaderOpt.split(':').slice(1).join(':') || null } : null;
const versionId = argv[0] || '1.20.1';
const username = argv[1] || 'ForjaTester';

(async () => {
  const layout = createLayout(path.resolve(dataDir));
  const session = createOfflineSession(username);
  let lastStep = '';
  const { child, exited } = await prepareAndLaunch({
    layout,
    versionId,
    loader,
    session,
    ...(gameDirOpt ? { gameDir: path.resolve(gameDirOpt) } : {}),
    memory: { min: 512, max: 2048 },
    onLog: (l) => console.log(`[launcher] ${l}`),
    onGameLog: (l, s) => console.log(`[game:${s}] ${l}`),
    onProgress: (p) => {
      if (p.step !== lastStep) {
        lastStep = p.step;
        console.log(`[progress] step=${p.step}`);
      }
    },
  });
  let timer;
  if (timeout > 0) {
    timer = setTimeout(() => {
      console.log(`[launcher] timeout ${timeout}s reached — stopping game`);
      child.kill('SIGTERM');
    }, timeout * 1000);
  }
  const r = await exited;
  clearTimeout(timer);
  console.log(`[launcher] game exited code=${r.code} signal=${r.signal}`);
})().catch((e) => {
  console.error('[launcher] FAILED:', e);
  process.exit(1);
});
