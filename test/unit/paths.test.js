'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDataDir, createLayout } = require('../../src/main/core/paths');
const { mojangRuntimePlatform, requiredJava, javaExecutableRel } = require('../../src/main/core/java');

test('data dir per OS', () => {
  assert.equal(getDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\Forja Launcher');
  assert.equal(getDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }),
    '/Users/u/Library/Application Support/Forja Launcher');
  assert.equal(getDataDir({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.local/share/forja-launcher');
  assert.equal(getDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/home/u' }), '/x/forja-launcher');
});

test('layout is separate from .minecraft', () => {
  const l = createLayout('/root');
  assert.ok(!l.root.includes('.minecraft'));
  assert.equal(l.versionJar('1.20.1').replace(/\\/g, '/'), '/root/versions/1.20.1/1.20.1.jar');
});

test('Mojang java runtime platform mapping', () => {
  assert.equal(mojangRuntimePlatform('win32', 'x64'), 'windows-x64');
  assert.equal(mojangRuntimePlatform('win32', 'arm64'), 'windows-arm64');
  assert.equal(mojangRuntimePlatform('win32', 'ia32'), 'windows-x86');
  assert.equal(mojangRuntimePlatform('darwin', 'x64'), 'mac-os');
  assert.equal(mojangRuntimePlatform('darwin', 'arm64'), 'mac-os-arm64');
  assert.equal(mojangRuntimePlatform('linux', 'x64'), 'linux');
  assert.equal(mojangRuntimePlatform('linux', 'ia32'), 'linux-i386');
  assert.equal(mojangRuntimePlatform('linux', 'arm64'), null);
});

test('required java from version JSON', () => {
  assert.deepEqual(requiredJava({ javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 } }),
    { component: 'java-runtime-gamma', majorVersion: 17 });
  assert.deepEqual(requiredJava({}), { component: 'jre-legacy', majorVersion: 8 });
  assert.match(javaExecutableRel('darwin'), /jre\.bundle/);
  assert.match(javaExecutableRel('win32'), /javaw\.exe$/);
});
