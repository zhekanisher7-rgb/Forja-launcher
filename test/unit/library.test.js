'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = require('../../src/main/core/library');
const { currentContext } = require('../../src/main/core/platform');

const LIB = path.resolve('/data/libraries');
const linux = currentContext({ platform: 'linux', arch: 'x64' });
const win = currentContext({ platform: 'win32', arch: 'x64' });
const macArm = currentContext({ platform: 'darwin', arch: 'arm64' });

test('mavenPath basic / classifier / extension', () => {
  assert.equal(lib.mavenPath('com.mojang:brigadier:1.1.8'),
    'com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar');
  assert.equal(lib.mavenPath('org.lwjgl:lwjgl:3.3.1:natives-linux'),
    'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar');
  assert.equal(lib.mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1@zip'),
    'de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip');
  assert.equal(lib.mavenPath('org.lwjgl.lwjgl:lwjgl-platform:2.9.4', 'natives-linux'),
    'org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar');
  assert.throws(() => lib.parseMavenName('bad'));
});

test('libraryKey ignores version, keeps classifier', () => {
  assert.equal(lib.libraryKey('a.b:c:1.0'), 'a.b:c');
  assert.equal(lib.libraryKey('a.b:c:1.0:natives-linux'), 'a.b:c:natives-linux');
});

test('modern library with downloads.artifact', () => {
  const r = lib.resolveLibrary({
    name: 'com.mojang:brigadier:1.1.8',
    downloads: { artifact: { path: 'com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar', sha1: 'abc', size: 10, url: 'https://libraries.minecraft.net/com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar' } },
  }, linux, LIB);
  assert.equal(r.artifact.path, path.join(LIB, 'com', 'mojang', 'brigadier', '1.1.8', 'brigadier-1.1.8.jar'));
  assert.equal(r.artifact.sha1, 'abc');
  assert.equal(r.native, null);
  assert.equal(r.modernNative, false);
});

test('library without downloads uses url base + maven path', () => {
  const r = lib.resolveLibrary({ name: 'net.fabricmc:fabric-loader:0.15.0', url: 'https://maven.fabricmc.net/' }, linux, LIB);
  assert.equal(r.artifact.url, 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar');
  const d = lib.resolveLibrary({ name: 'x.y:z:1' }, linux, LIB);
  assert.equal(d.artifact.url, 'https://libraries.minecraft.net/x/y/z/1/z-1.jar');
});

test('legacy natives classifiers with ${arch}', () => {
  const entry = {
    name: 'tv.twitch:twitch-platform:5.16',
    natives: { linux: 'natives-linux', windows: 'natives-windows-${arch}', osx: 'natives-osx' },
    extract: { exclude: ['META-INF/'] },
    downloads: {
      classifiers: {
        'natives-linux': { path: 'tv/twitch/twitch-platform/5.16/twitch-platform-5.16-natives-linux.jar', sha1: 'l', size: 1, url: 'https://x/l.jar' },
        'natives-windows-64': { path: 'tv/twitch/twitch-platform/5.16/twitch-platform-5.16-natives-windows-64.jar', sha1: 'w64', size: 2, url: 'https://x/w64.jar' },
      },
    },
  };
  const rl = lib.resolveLibrary(entry, linux, LIB);
  assert.equal(rl.artifact, null);
  assert.equal(rl.native.sha1, 'l');
  const rw = lib.resolveLibrary(entry, win, LIB);
  assert.equal(rw.native.sha1, 'w64');
  assert.deepEqual(rw.extract, { exclude: ['META-INF/'] });
});

test('rules exclude library on other OS', () => {
  const entry = {
    name: 'org.lwjgl:lwjgl:3.3.1:natives-macos-arm64',
    rules: [{ action: 'allow', os: { name: 'osx' } }],
    downloads: { artifact: { path: 'p.jar', url: 'https://x/p.jar', sha1: 's', size: 1 } },
  };
  assert.equal(lib.resolveLibrary(entry, linux, LIB), null);
  const r = lib.resolveLibrary(entry, macArm, LIB);
  assert.equal(r.modernNative, true);
  assert.equal(r.modernNativeForArch, true);
});

test('nativeClassifierMatchesArch', () => {
  assert.equal(lib.nativeClassifierMatchesArch('natives-linux', 'x64'), true);
  assert.equal(lib.nativeClassifierMatchesArch('natives-linux-arm64', 'x64'), false);
  assert.equal(lib.nativeClassifierMatchesArch('natives-macos-arm64', 'arm64'), true);
  assert.equal(lib.nativeClassifierMatchesArch('natives-macos', 'arm64'), false);
  assert.equal(lib.nativeClassifierMatchesArch('natives-windows-x86', 'ia32'), true);
});
