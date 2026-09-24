'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mergeVersions, mergeLibraries } = require('../../src/main/core/loaders/inherit');
const forge = require('../../src/main/core/loaders/forge');
const { compareVersions } = require('../../src/main/core/loaders/meta');
const { normalizeLoader, pickRecommended } = require('../../src/main/core/loaders');
const { buildLaunchCommand } = require('../../src/main/core/launch');

const vanilla = {
  id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
  assets: '5', assetIndex: { id: '5', url: 'x' }, javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  downloads: { client: { url: 'https://x/client.jar', sha1: 'a' } },
  logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml' } } },
  arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-cp', '${classpath}'] },
  libraries: [
    { name: 'org.ow2.asm:asm:9.3' },
    { name: 'com.mojang:brigadier:1.1.8' },
    { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] },
  ],
};

test('inheritsFrom merge: child libraries win, args appended, mainClass/id from child, parent jar/assets/java kept', () => {
  const fabric = {
    id: 'fabric-loader-0.19.5-1.20.1', inheritsFrom: '1.20.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    libraries: [{ name: 'org.ow2.asm:asm:9.10.1', url: 'https://maven.fabricmc.net/' }, { name: 'net.fabricmc:fabric-loader:0.19.5' }],
  };
  const m = mergeVersions(vanilla, fabric);
  assert.equal(m.id, 'fabric-loader-0.19.5-1.20.1');
  assert.equal(m.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.deepEqual(m.libraries.map((l) => l.name), [
    'org.ow2.asm:asm:9.10.1', 'net.fabricmc:fabric-loader:0.19.5', 'com.mojang:brigadier:1.1.8', 'org.lwjgl:lwjgl:3.3.1:natives-linux',
  ]);
  assert.deepEqual(m.arguments.jvm, ['-cp', '${classpath}', '-DFabricMcEmu= net.minecraft.client.main.Main ']);
  assert.deepEqual(m.arguments.game, ['--username', '${auth_player_name}']);
  assert.equal(m._jarId, '1.20.1');
  assert.equal(m.assetIndex.id, '5');
  assert.equal(m.javaVersion.majorVersion, 17);
  assert.deepEqual(m._chain, ['fabric-loader-0.19.5-1.20.1', '1.20.1']);
  assert.equal(m.inheritsFrom, undefined);
});

test('inheritsFrom merge: legacy child minecraftArguments replaces parent (Forge 1.12.2)', () => {
  const parent = { id: '1.12.2', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name}', libraries: [] };
  const child = { id: '1.12.2-forge', inheritsFrom: '1.12.2', mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments: '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker', libraries: [] };
  const m = mergeVersions(parent, child);
  assert.match(m.minecraftArguments, /FMLTweaker/);
  assert.equal(m.arguments, undefined);
});

test('multi-level chain merge and legacy natives entries are not deduplicated away', () => {
  const libs = mergeLibraries(
    [{ name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { linux: 'natives-linux' } }],
    [{ name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.2', natives: { linux: 'natives-linux' } }, { name: 'org.lwjgl.lwjgl:lwjgl:2.9.2' }],
  );
  assert.deepEqual(libs.map((l) => l.name), ['org.lwjgl.lwjgl:lwjgl-platform:2.9.4', 'org.lwjgl.lwjgl:lwjgl:2.9.2']);
  const a = mergeVersions({ id: 'base', libraries: [], mainClass: 'A' }, { id: 'mid', inheritsFrom: 'base', libraries: [] });
  const b = mergeVersions(a, { id: 'top', inheritsFrom: 'mid', libraries: [], mainClass: 'C' });
  assert.deepEqual(b._chain, ['top', 'mid', 'base']);
  assert.equal(b.mainClass, 'C');
});

test('launch command: legacy base + modern child arguments keeps -cp and legacy game args', () => {
  const parent = { id: '1.12.2', type: 'release', mainClass: 'M', minecraftArguments: '--username ${auth_player_name}', libraries: [] };
  const child = { id: 'fabric-1.12.2', inheritsFrom: '1.12.2', mainClass: 'Knot', arguments: { jvm: ['-Dfabric=1'], game: ['--extra'] }, libraries: [] };
  const v = mergeVersions(parent, child);
  const cmd = buildLaunchCommand({ version: v, classpath: ['/a.jar'], javaPath: 'java', session: { username: 'U', uuid: 'u', accessToken: '0', userType: 'legacy' },
    gameDir: '/g', assetsRoot: '/as', nativesDir: '/n', librariesDir: '/l', ctx: { platform: 'linux', osName: 'linux', arch: 'x64', osArch: 'x86_64', osVersion: '6' } });
  const args = cmd.args;
  assert.ok(args.includes('-cp') && args.includes('-Dfabric=1'));
  assert.ok(args.indexOf('-cp') < args.indexOf('Knot'));
  assert.deepEqual(args.slice(args.indexOf('Knot') + 1), ['--username', 'U', '--extra']);
});

test('Forge processor data map + argument substitution', () => {
  const lib = path.join('/data', 'libraries');
  const extracted = [];
  const data = forge.buildDataMap({
    MAPPINGS: { client: '[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt]', server: 'x' },
    MC_SLIM_SHA: { client: "'de86b035'", server: "'zz'" },
    BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
    SERVER_ONLY: { server: "'s'" },
  }, {
    minecraftJar: '/data/versions/1.20.1/1.20.1.jar', minecraftVersion: '1.20.1', root: '/data', installer: '/tmp/i.jar', librariesDir: lib,
    extract: (p) => { extracted.push(p); return `/tmp/x/${path.basename(p)}`; },
  });
  assert.equal(data.SIDE, 'client');
  assert.equal(data.MAPPINGS, path.join(lib, 'de', 'oceanlabs', 'mcp', 'mcp_config', '1.20.1-20230612.114412', 'mcp_config-1.20.1-20230612.114412-mappings.txt'));
  assert.equal(data.MC_SLIM_SHA, 'de86b035');
  assert.equal(data.BINPATCH, '/tmp/x/client.lzma');
  assert.deepEqual(extracted, ['/data/client.lzma']);
  assert.equal(data.SERVER_ONLY, undefined);

  const sub = (a) => forge.substituteProcessorArg(a, data, lib);
  assert.equal(sub('{MINECRAFT_JAR}'), '/data/versions/1.20.1/1.20.1.jar');
  assert.equal(sub('--side={SIDE}'), '--side=client');
  assert.equal(sub('{ROOT}/libraries/x'), '/data/libraries/x');
  assert.equal(sub('[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip]'),
    path.join(lib, 'de', 'oceanlabs', 'mcp', 'mcp_config', '1.20.1-20230612.114412', 'mcp_config-1.20.1-20230612.114412.zip'));
  assert.equal(sub('\\{literal\\}'), '{literal}');
  assert.equal(sub('--task'), '--task');
  assert.throws(() => sub('{NOPE}'), /Missing processor data key/);
});

test('Forge processors filtered by side; library plan splits downloads and bundled files', () => {
  const procs = [{ jar: 'a:a:1', sides: ['server'] }, { jar: 'b:b:1' }, { jar: 'c:c:1', sides: ['client'] }];
  assert.deepEqual(forge.processorsForSide(procs).map((p) => p.jar), ['b:b:1', 'c:c:1']);
  const plan = forge.libraryPlan([
    { name: 'net.minecraftforge:forge:1.12.2-14.23.5.2859', downloads: { artifact: { path: 'net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859.jar', url: '' } } },
    { name: 'org.ow2.asm:asm:9.8', downloads: { artifact: { path: 'org/ow2/asm/asm/9.8/asm-9.8.jar', url: 'https://maven/asm.jar', sha1: 'ab', size: 3 } } },
    { name: 'net.fabricmc:x:1', url: 'https://maven.fabricmc.net' },
  ], '/L');
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[1].url, 'https://maven.fabricmc.net/net/fabricmc/x/1/x-1.jar');
  assert.equal(plan.bundled.length, 1);
  assert.equal(plan.bundled[0].rel, 'net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859.jar');
});

test('NeoForge version → Minecraft version mapping and installer URLs', () => {
  assert.equal(forge.neoforgeMcVersion('21.1.209'), '1.21.1');
  assert.equal(forge.neoforgeMcVersion('21.0.167'), '1.21');
  assert.equal(forge.neoforgeMcVersion('20.4.237'), '1.20.4');
  assert.equal(forge.neoforgeMcVersion('26.1.0.5-beta'), '26.1');
  assert.equal(forge.installerUrl('forge', '1.20.1-47.4.10'),
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar');
  assert.equal(forge.installerUrl('neoforge', '21.1.209'),
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar');
});

test('loader version ordering, recommended pick and normalisation', () => {
  const sorted = ['0.9.0', '0.19.5', '0.16.14', '0.20.0-beta.9', '0.20.0'].sort((a, b) => compareVersions(b, a));
  assert.deepEqual(sorted, ['0.20.0', '0.20.0-beta.9', '0.19.5', '0.16.14', '0.9.0']);
  assert.equal(pickRecommended([{ version: '2', stable: false }, { version: '1', stable: true }]).version, '1');
  assert.equal(pickRecommended([{ version: '3', latest: true }, { version: '2', recommended: true }]).version, '2');
  assert.deepEqual(normalizeLoader({ type: 'forge', version: '47.4.10' }), { type: 'forge', version: '47.4.10' });
  assert.deepEqual(normalizeLoader({ type: 'bogus' }), { type: 'vanilla', version: null });
  assert.deepEqual(normalizeLoader(null), { type: 'vanilla', version: null });
});
