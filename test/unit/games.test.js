'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { GameManager } = require('../../src/main/core/games');

/** Fake launchFn: spawns node with a script instead of Minecraft. */
function fakeLaunch(script, { delayMs = 0 } = {}) {
  return async (opts) => {
    opts.onLog('preparing');
    opts.onProgress({ step: 'libraries', doneFiles: 1, totalFiles: 2 });
    await new Promise((r) => setTimeout(r, delayMs));
    if (opts.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const child = spawn(process.execPath, ['-e', script], { cwd: opts.gameDir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => opts.onGameLog(l, 'stdout')));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited };
  };
}

const waitFor = (em, ev, pred = () => true) => new Promise((resolve) => {
  const h = (x) => { if (pred(x)) { em.off(ev, h); resolve(x); } };
  em.on(ev, h);
});

test('tracks multiple running games, one per profile; kill is not a crash', async () => {
  const gm = new GameManager({ launchFn: fakeLaunch('console.log("Setting user: A"); setInterval(()=>{}, 1000)') });
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gA-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gB-'));
  const crashes = [];
  gm.on('crash', (c) => crashes.push(c));
  const logA = waitFor(gm, 'log', (l) => l.profileId === 'a' && l.line === 'Setting user: A');
  await gm.start({ profileId: 'a', gameDir: dirA, versionId: '1.20.1', launchOptions: {} });
  await gm.start({ profileId: 'b', gameDir: dirB, versionId: '1.8.9', launchOptions: {} });
  assert.equal(gm.runningCount(), 2);
  assert.deepEqual(gm.status().map((s) => s.profileId).sort(), ['a', 'b']);
  await assert.rejects(gm.start({ profileId: 'a', gameDir: dirA, versionId: '1.20.1', launchOptions: {} }), { code: 'ALREADY_RUNNING' });
  await logA;
  const exitA = waitFor(gm, 'state', (s) => s.profileId === 'a' && s.state === 'exited');
  const exitB = waitFor(gm, 'state', (s) => s.profileId === 'b' && s.state === 'exited');
  assert.equal(gm.kill('a'), true);
  assert.equal((await exitA).killedByUser, true);
  assert.equal(gm.runningCount(), 1);
  gm.kill('b');
  await exitB;
  assert.equal(crashes.length, 0);
  assert.ok(gm.getLogs('a').includes('Setting user: A'));
});

test('non-zero exit emits crash with last lines and crash report', async () => {
  const script = `for (let i=0;i<80;i++) console.log('line '+i);
    const fs=require('fs'); fs.mkdirSync('crash-reports',{recursive:true});
    fs.writeFileSync('crash-reports/crash-2026-01-01_00.00.00-client.txt','boom');
    process.exit(1)`;
  const gm = new GameManager({ launchFn: fakeLaunch(script) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gC-'));
  const crash = waitFor(gm, 'crash');
  await gm.start({ profileId: 'c', gameDir: dir, versionId: '1.20.1', launchOptions: {} });
  const c = await crash;
  assert.equal(c.code, 1);
  assert.equal(c.lines.length, 50);
  assert.equal(c.lines[49], 'line 79');
  assert.equal(c.crashReportsDir, path.join(dir, 'crash-reports'));
  assert.match(c.crashReport, /crash-2026-01-01_00\.00\.00-client\.txt$/);
  assert.equal(gm.isBusy('c'), false);
});

test('cancel during preparation', async () => {
  const gm = new GameManager({ launchFn: fakeLaunch('', { delayMs: 200 }) });
  const states = [];
  gm.on('state', (s) => states.push(s.state));
  const p = gm.start({ profileId: 'd', gameDir: os.tmpdir(), versionId: 'x', launchOptions: {} });
  assert.equal(gm.cancel('d'), true);
  await assert.rejects(p, (e) => e.cancelled);
  assert.deepEqual(states, ['preparing', 'cancelled']);
  assert.equal(gm.isBusy('d'), false);
});

test('prepare error emits error state', async () => {
  const gm = new GameManager({ launchFn: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); } });
  const st = waitFor(gm, 'state', (s) => s.state === 'error');
  await assert.rejects(gm.start({ profileId: 'e', gameDir: os.tmpdir(), versionId: 'x', launchOptions: {} }));
  assert.equal((await st).error.code, 'ENOTFOUND');
});
