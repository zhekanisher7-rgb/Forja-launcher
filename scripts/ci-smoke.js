#!/usr/bin/env node
'use strict';
/**
 * CI smoke test of the core on the *current* OS/arch — no jars, no Java, no game.
 * Exercises the platform-dependent logic (rules, natives classifiers, classpath
 * separator, data dir, Java runtime platform keys, launch argument assembly):
 *
 *   1. fetch the Mojang manifest and resolve a modern (1.20.1) and a legacy
 *      (1.8.9) version (version JSON only, into a temp dir);
 *   2. resolve libraries + natives for this OS and check they exist for it;
 *   3. build the full launch command (dry run) with fake paths and check it;
 *   4. check the Mojang Java runtime manifest has the needed component here;
 *   5. install a Fabric profile JSON (meta API) and resolve the inheritsFrom chain.
 *
 *   node scripts/ci-smoke.js [--as <platform>/<arch>]   (e.g. --as win32/x64 to simulate another OS
 *   locally; CI runs it without --as on the real OS)
 * Exit code 0 = all checks passed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const config = require('../src/main/config');
const { createLayout, getDataDir } = require('../src/main/core/paths');
const { currentContext, classpathSeparator } = require('../src/main/core/platform');
const { fetchManifest } = require('../src/main/core/versions');
const { loadVersionJson } = require('../src/main/core/install');
const { resolveLibraries } = require('../src/main/core/library');
const { buildLaunchCommand } = require('../src/main/core/launch');
const { requiredJava, mojangRuntimePlatform, javaExecutableRel } = require('../src/main/core/java');
const { fetchJson } = require('../src/main/core/http');
const meta = require('../src/main/core/loaders/meta');
const { createOfflineSession } = require('../src/main/auth/offline');

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - t0} ms)${info ? ` — ${info}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err && err.stack ? err.stack : err}`);
  }
}

function dryRunCommand(layout, version, ctx) {
  const libs = resolveLibraries(version.libraries || [], ctx, layout.libraries);
  const classpath = [];
  const natives = [];
  for (const l of libs) {
    if (l.native) natives.push(l.native.path);
    if (!l.artifact) continue;
    if (l.modernNative) { if (l.modernNativeForArch) natives.push(l.artifact.path); continue; }
    classpath.push(l.artifact.path);
  }
  classpath.push(layout.versionJar(version._jarId || version.id));
  const gameDir = layout.instanceDir('smoke');
  const cmd = buildLaunchCommand({
    version,
    classpath,
    javaPath: path.join(layout.runtime, 'x', javaExecutableRel(ctx.platform)),
    session: offlineSession(),
    gameDir,
    assetsRoot: layout.assets,
    assetsIndexName: version.assets,
    nativesDir: path.join(layout.nativesTmp, 'smoke'),
    librariesDir: layout.libraries,
    memory: { min: 512, max: 2048 },
    ctx,
  });
  return { cmd, classpath, natives, libs };
}

let session = null;
function offlineSession() {
  if (!session) session = createOfflineSession('CiSmoke');
  return session;
}

async function main() {
  const asIdx = process.argv.indexOf('--as');
  const [simPlatform, simArch] = asIdx !== -1 ? String(process.argv[asIdx + 1] || '').split('/') : [];
  const ctx = currentContext(simPlatform ? { platform: simPlatform, arch: simArch || 'x64', osVersion: '10.0' } : {});
  const sep = classpathSeparator(ctx.platform);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-smoke-'));
  const layout = createLayout(tmp);
  if (simPlatform) console.log('(simulated platform — paths are still built with the host path module)');
  console.log(`Forja ${config.version} smoke on ${ctx.platform}/${ctx.arch} (${ctx.osName} ${ctx.osArch}), node ${process.version}`);
  let manifest = null;

  await check('data dir for this OS', () => {
    const env = { ...process.env };
    delete env.FORJA_DATA_DIR;
    if (simPlatform) env.APPDATA = 'C:\\Users\\ci\\AppData\\Roaming';
    const dir = getDataDir({ env, platform: ctx.platform, home: ctx.platform === 'win32' ? 'C:\\Users\\ci' : os.homedir() });
    assert.ok((ctx.platform === 'win32' ? path.win32 : path.posix).isAbsolute(dir), dir);
    if (ctx.platform === 'win32') assert.match(dir, /Forja Launcher$/);
    else if (ctx.platform === 'darwin') assert.match(dir, /Library\/Application Support\/Forja Launcher$/);
    else assert.match(dir, /forja-launcher$/);
    return dir;
  });

  await check('offline (test) session', () => {
    const s = offlineSession();
    assert.equal(s.username, 'CiSmoke');
    assert.match(s.uuid, /^[0-9a-f]{32}$/);
  });

  await check('Mojang manifest', async () => {
    manifest = await fetchManifest({ cacheDir: layout.cache });
    assert.ok(manifest.latest && manifest.latest.release, 'latest release');
    assert.ok(manifest.versions.find((v) => v.id === '1.20.1'));
    return `latest release ${manifest.latest.release}, ${manifest.versions.length} versions`;
  });

  for (const id of ['1.20.1', '1.8.9']) {
    await check(`${id}: libraries, natives and launch arguments for this OS`, async () => {
      const version = await loadVersionJson({ layout, versionId: id, manifest });
      const { cmd, classpath, natives } = dryRunCommand(layout, version, ctx);
      assert.ok(classpath.length > 10, 'classpath');
      assert.ok(classpath.every((p) => path.isAbsolute(p)), 'absolute classpath');
      assert.ok(classpath.some((p) => /lwjgl/.test(p)), 'lwjgl on classpath');
      // natives: legacy (1.8.9) via classifier map, modern (1.20.1) via natives-* libraries
      const want = { windows: /natives-windows/, osx: /natives-(osx|macos)/, linux: /natives-linux/ }[ctx.osName];
      if (ctx.platform === 'linux' && ctx.arch !== 'x64' && natives.length === 0) {
        console.log(`warn ${id}: Mojang ships no natives for linux/${ctx.arch} (unsupported target)`);
      } else {
        assert.ok(natives.length > 0, 'natives for this OS');
      }
      assert.ok(natives.every((p) => want.test(p)), `natives match ${ctx.osName}: ${natives.map((p) => path.basename(p)).join(', ')}`);
      if (id === '1.20.1' && ctx.arch === 'arm64' && natives.length) assert.ok(natives.some((p) => /arm64/.test(p)), 'arm64 natives');
      if (id === '1.20.1' && ctx.arch === 'x64') assert.ok(natives.every((p) => !/arm64|x86\.jar/.test(p)), 'x64 natives only');
      const cpIndex = cmd.args.indexOf('-cp');
      assert.ok(cpIndex !== -1, '-cp present');
      assert.equal(cmd.args[cpIndex + 1], classpath.join(sep), `classpath joined with "${sep}"`);
      assert.ok(cmd.args.includes(version.mainClass), 'main class');
      assert.ok(cmd.args.includes('--gameDir') && cmd.args.includes(layout.instanceDir('smoke')), 'gameDir');
      assert.ok(!cmd.args.some((a) => /\$\{[a-z_]+\}/.test(a)), `unsubstituted placeholder: ${cmd.args.find((a) => /\$\{/.test(a))}`);
      if (ctx.platform === 'darwin' && id === '1.20.1') assert.ok(cmd.args.includes('-XstartOnFirstThread'), 'macOS -XstartOnFirstThread');
      if (ctx.platform !== 'darwin') assert.ok(!cmd.args.includes('-XstartOnFirstThread'));
      if (ctx.platform === 'win32' && id === '1.20.1') {
        assert.ok(cmd.args.some((a) => a.startsWith('-XX:HeapDumpPath=')), 'Windows HeapDumpPath');
      }
      return `${classpath.length} cp entries, ${natives.length} natives, ${cmd.args.length} args`;
    });
  }

  await check('Java runtime available for this platform', async () => {
    const key = mojangRuntimePlatform(ctx.platform, ctx.arch);
    const all = await fetchJson(config.endpoints.javaRuntimeManifest);
    const out = [];
    for (const id of ['1.20.1', '1.8.9']) {
      const version = await loadVersionJson({ layout, versionId: id, manifest });
      const need = requiredJava(version);
      const entries = key && all[key] && all[key][need.component];
      if (entries && entries.length) out.push(`${id} → ${need.component} (${key})`);
      else out.push(`${id} → ${need.component}: no Mojang runtime for ${key || `${ctx.platform}-${ctx.arch}`}, Adoptium fallback`);
    }
    // Mojang ships runtimes for all desktop targets we build for, except linux-arm64
    if (key && ctx.platform !== 'linux') assert.ok(!out.some((s) => /no Mojang runtime/.test(s) && /^1\.20\.1/.test(s)), out.join('; '));
    return out.join('; ');
  });

  await check('Fabric profile + inheritsFrom chain', async () => {
    const versions = await meta.listVersions('fabric', '1.20.1');
    const stable = versions.find((v) => v.stable) || versions[0];
    assert.ok(stable, 'fabric loader version');
    const { versionId } = await meta.install({ type: 'fabric', layout, mcVersion: '1.20.1', loaderVersion: stable.version });
    const version = await loadVersionJson({ layout, versionId, manifest });
    assert.equal(version._jarId, '1.20.1');
    assert.match(version.mainClass, /fabricmc/);
    const { cmd } = dryRunCommand(layout, version, ctx);
    assert.ok(cmd.args.includes(version.mainClass));
    assert.ok(cmd.args.join(' ').includes('fabric-loader'), 'fabric-loader on classpath');
    return `${versionId}, ${version.libraries.length} libraries`;
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
