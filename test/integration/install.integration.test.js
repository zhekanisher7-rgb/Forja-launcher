'use strict';
/**
 * Headless integration test (network, ~1 GB download on first run).
 * Installs 1.20.1 (modern args, natives-as-libraries) and 1.8.9 (legacy
 * minecraftArguments + natives classifiers) into a fresh temp directory
 * using core modules only (no Electron), then independently re-verifies
 * SHA1 of every file and checks that the launch command is consistent.
 *
 * FORJA_IT_DIR=/path  — reuse a directory (default: new temp dir, removed after)
 * FORJA_IT_VERSIONS=1.20.1,1.8.9
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLayout } = require('../../src/main/core/paths');
const { fetchManifest } = require('../../src/main/core/versions');
const { installVersion } = require('../../src/main/core/install');
const { ensureJava } = require('../../src/main/core/java');
const { resolveLibraries } = require('../../src/main/core/library');
const { sha1File } = require('../../src/main/core/download');
const { buildLaunchCommand } = require('../../src/main/core/launch');
const { currentContext } = require('../../src/main/core/platform');
const { createOfflineSession } = require('../../src/main/auth/offline');

const root = process.env.FORJA_IT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forja-it-'));
const layout = createLayout(root);
const VERSIONS = (process.env.FORJA_IT_VERSIONS || '1.20.1,1.8.9').split(',');
const MB = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function verifyAll(files) {
  let bad = 0;
  let bytes = 0;
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.pop();
      const st = await fsp.stat(f.path);
      bytes += st.size;
      if (f.size != null && st.size !== f.size) { bad++; continue; }
      if (f.sha1 && (await sha1File(f.path)) !== f.sha1) bad++;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { bad, bytes };
}

let manifest;
test.before(async () => {
  manifest = await fetchManifest({ cacheDir: layout.cache });
  console.log(`# data dir: ${root}; latest release: ${manifest.latest.release}`);
});

for (const id of VERSIONS) {
  test(`install + verify ${id}`, async (t) => {
    const ctx = currentContext();
    const gameDir = layout.instanceDir(`it-${id}`);
    const t0 = Date.now();
    const inst = await installVersion({ layout, versionId: id, manifest, gameDir, ctx, concurrency: 16 });
    const installMs = Date.now() - t0;
    const t1 = Date.now();
    const java = await ensureJava({ layout, version: inst.version });
    const javaMs = Date.now() - t1;

    // Independently rebuild the expected file list from the version JSON
    const expected = [];
    const v = inst.version;
    expected.push({ path: inst.clientJar, sha1: v.downloads.client.sha1, size: v.downloads.client.size });
    for (const lib of resolveLibraries(v.libraries, ctx, layout.libraries)) {
      for (const d of [lib.artifact, lib.native]) if (d) expected.push(d);
    }
    if (inst.loggingConfig) {
      expected.push({ path: inst.loggingConfig.path, sha1: v.logging.client.file.sha1 });
    }
    const index = JSON.parse(await fsp.readFile(path.join(layout.assetIndexes, `${v.assetIndex.id}.json`), 'utf8'));
    for (const o of Object.values(index.objects)) {
      expected.push({ path: path.join(layout.assetObjects, o.hash.slice(0, 2), o.hash), sha1: o.hash, size: o.size });
    }
    const tv = Date.now();
    const { bad, bytes } = await verifyAll(expected);
    const verifyMs = Date.now() - tv;
    assert.equal(bad, 0, `${bad} files failed SHA1`);

    // natives
    const natives = await fsp.readdir(inst.nativesDir);
    assert.ok(natives.length > 0, 'natives extracted');
    const nativeExt = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
    assert.ok(natives.some((n) => n.endsWith(nativeExt) || n.endsWith('.jnilib')), `native ${nativeExt} present`);

    // java
    const req = v.javaVersion ? v.javaVersion.majorVersion : 8;
    assert.equal(java.major, req, `java major ${java.major} == ${req}`);

    // launch command consistency
    const cmd = buildLaunchCommand({
      version: v, classpath: inst.classpath, javaPath: java.javaPath, session: createOfflineSession('ForjaTester'),
      gameDir, assetsRoot: layout.assets, assetsIndexName: inst.assets.indexId, virtualAssetsDir: inst.assets.virtualDir,
      nativesDir: inst.nativesDir, librariesDir: layout.libraries, loggingConfig: inst.loggingConfig, ctx,
    });
    for (const cp of inst.classpath) assert.ok(fs.existsSync(cp), `classpath entry exists: ${cp}`);
    assert.ok(!cmd.args.some((a) => /\$\{[a-z_]+\}/.test(a)), 'no unresolved placeholders');
    assert.ok(cmd.args.includes(v.mainClass));

    const libs = inst.stats.libraries;
    const assets = inst.stats.assets;
    const summary = [
      `${id}: files verified=${expected.length} (${MB(bytes)}), SHA1 failures=0`,
      `  libraries+client: ${libs.files} files, downloaded ${libs.downloaded} (${MB(libs.bytes)}), skipped ${libs.skipped}`,
      `  assets: ${assets.files} files, downloaded ${assets.downloaded} (${MB(assets.bytes)}), skipped ${assets.skipped}`,
      `  java ${java.version} (${java.source}, major ${java.major})${java.stats ? `: ${java.stats.files} files, downloaded ${MB(java.stats.bytes)}` : ''}`,
      `  time: install ${(installMs / 1000).toFixed(1)}s, java ${(javaMs / 1000).toFixed(1)}s, re-verify ${(verifyMs / 1000).toFixed(1)}s`,
      `  natives: ${natives.length} files; classpath: ${inst.classpath.length} entries`,
    ].join('\n');
    t.diagnostic(summary);
  });
}

test.after(async () => {
  if (!process.env.FORJA_IT_DIR && !process.env.FORJA_IT_KEEP) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
