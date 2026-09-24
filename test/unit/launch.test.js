'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { substitute, evaluateArguments, buildLaunchCommand } = require('../../src/main/core/launch');
const { currentContext } = require('../../src/main/core/platform');
const { createOfflineSession } = require('../../src/main/auth/offline');

const linux = currentContext({ platform: 'linux', arch: 'x64' });
const win = currentContext({ platform: 'win32', arch: 'x64' });
const mac = currentContext({ platform: 'darwin', arch: 'arm64' });
const session = createOfflineSession('Steve');

test('substitute replaces known placeholders, leaves unknown', () => {
  assert.equal(substitute('--user ${auth_player_name} ${nope}', { auth_player_name: 'Steve' }), '--user Steve ${nope}');
  assert.equal(substitute('-Djava.library.path=${natives_directory}', { natives_directory: '/n' }), '-Djava.library.path=/n');
  assert.equal(substitute('${a}${b}', { a: 1, b: 'x' }), '1x');
});

test('evaluateArguments applies rules and flattens arrays', () => {
  const list = [
    '--username', '${auth_player_name}',
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] },
    { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
  ];
  assert.deepEqual(evaluateArguments(list, linux), ['--username', '${auth_player_name}']);
  assert.deepEqual(evaluateArguments(list, { ...mac, features: { has_custom_resolution: true } }),
    ['--username', '${auth_player_name}', '--width', '${resolution_width}', '-XstartOnFirstThread']);
});

const modernVersion = {
  id: '1.20.1',
  type: 'release',
  assets: '5',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: {
    game: [
      '--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}', '--userType', '${user_type}', '--versionType', '${version_type}',
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump' },
      '-Djava.library.path=${natives_directory}',
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-cp', '${classpath}',
    ],
  },
};

const legacyVersion = {
  id: '1.8.9',
  type: 'release',
  assets: '1.8',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
};

function build(version, ctx, extra = {}) {
  return buildLaunchCommand({
    version,
    classpath: ['/l/a.jar', '/l/b.jar', '/v/client.jar'],
    javaPath: '/j/bin/java',
    session,
    gameDir: '/g',
    assetsRoot: '/assets',
    assetsIndexName: version.assets,
    nativesDir: '/n',
    librariesDir: '/l',
    memory: { min: 512, max: 3072 },
    ctx,
    ...extra,
  });
}

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('modern args: order, memory, classpath separator, placeholders', () => {
  const { args, command, cwd } = build(modernVersion, linux);
  assert.equal(command, '/j/bin/java');
  assert.equal(cwd, '/g');
  assert.deepEqual(args.slice(0, 2), ['-Xms512M', '-Xmx3072M']);
  assert.equal(after(args, '-cp'), '/l/a.jar:/l/b.jar:/v/client.jar');
  assert.ok(args.includes('-Djava.library.path=/n'));
  assert.ok(args.includes('-Dminecraft.launcher.brand=forja-launcher'));
  assert.ok(!args.includes('-XstartOnFirstThread'));
  const mainIdx = args.indexOf('net.minecraft.client.main.Main');
  assert.ok(mainIdx > args.indexOf('-cp'));
  assert.equal(after(args, '--username'), 'Steve');
  assert.equal(after(args, '--uuid'), session.uuid);
  assert.equal(after(args, '--assetIndex'), '5');
  assert.equal(after(args, '--gameDir'), '/g');
  assert.equal(after(args, '--versionType'), 'release');
  assert.ok(!args.includes('--width'));
  assert.ok(!args.some((a) => a.includes('${')), `unresolved placeholder in ${args}`);
});

test('modern args on windows use ; separator and heap dump arg', () => {
  const { args } = build(modernVersion, win);
  assert.equal(after(args, '-cp'), '/l/a.jar;/l/b.jar;/v/client.jar');
  assert.ok(args.some((a) => a.startsWith('-XX:HeapDumpPath=')));
});

test('modern args on mac add -XstartOnFirstThread', () => {
  const { args } = build(modernVersion, mac);
  assert.ok(args.includes('-XstartOnFirstThread'));
});

test('custom resolution feature', () => {
  const { args } = build(modernVersion, linux, { resolution: { width: 1280, height: 720 } });
  assert.equal(after(args, '--width'), '1280');
  assert.equal(after(args, '--height'), '720');
  const legacy = build(legacyVersion, linux, { resolution: { width: 800, height: 600 } }).args;
  assert.equal(after(legacy, '--width'), '800');
});

test('legacy minecraftArguments + default JVM args', () => {
  const { args } = build(legacyVersion, linux);
  assert.ok(args.includes('-Djava.library.path=/n'));
  assert.equal(after(args, '-cp'), '/l/a.jar:/l/b.jar:/v/client.jar');
  assert.equal(after(args, '--userProperties'), '{}');
  assert.equal(after(args, '--assetIndex'), '1.8');
  assert.equal(after(args, '--userType'), 'legacy');
  assert.ok(!args.some((a) => a.includes('${')));
  const macArgs = build(legacyVersion, mac).args;
  assert.ok(macArgs.includes('-XstartOnFirstThread'));
});

test('logging config argument is inserted before main class', () => {
  const { args } = build(modernVersion, linux, {
    loggingConfig: { argument: '-Dlog4j.configurationFile=${path}', path: '/a/client-1.12.xml' },
  });
  const i = args.indexOf('-Dlog4j.configurationFile=/a/client-1.12.xml');
  assert.ok(i > 0 && i < args.indexOf('net.minecraft.client.main.Main'));
});

test('virtual assets dir used for ${game_assets}', () => {
  const v = { ...legacyVersion, minecraftArguments: '--assetsDir ${game_assets}' };
  const { args } = build(v, linux, { virtualAssetsDir: '/assets/virtual/legacy' });
  assert.equal(after(args, '--assetsDir'), '/assets/virtual/legacy');
});
