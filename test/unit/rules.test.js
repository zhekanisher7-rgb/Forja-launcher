'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowed } = require('../../src/main/core/rules');
const { currentContext } = require('../../src/main/core/platform');

const linux = currentContext({ platform: 'linux', arch: 'x64', osVersion: '6.1.0' });
const win = currentContext({ platform: 'win32', arch: 'x64', osVersion: '10.0.19045' });
const mac = currentContext({ platform: 'darwin', arch: 'arm64', osVersion: '14.1' });
const win32bit = currentContext({ platform: 'win32', arch: 'ia32' });

test('no rules => allowed', () => {
  assert.equal(isAllowed(undefined, linux), true);
  assert.equal(isAllowed([], linux), true);
});

test('allow + disallow osx (classic lwjgl 2 pattern)', () => {
  const rules = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.equal(isAllowed(rules, linux), true);
  assert.equal(isAllowed(rules, win), true);
  assert.equal(isAllowed(rules, mac), false);
});

test('allow only osx', () => {
  const rules = [{ action: 'allow', os: { name: 'osx' } }];
  assert.equal(isAllowed(rules, mac), true);
  assert.equal(isAllowed(rules, linux), false);
});

test('arch rule x86 only matches 32-bit', () => {
  const rules = [{ action: 'allow', os: { arch: 'x86' } }];
  assert.equal(isAllowed(rules, win32bit), true);
  assert.equal(isAllowed(rules, win), false);
});

test('os version regex', () => {
  const rules = [{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }];
  assert.equal(isAllowed(rules, win), true);
  assert.equal(isAllowed(rules, { ...win, osVersion: '6.1.7601' }), false);
});

test('features', () => {
  const rules = [{ action: 'allow', features: { has_custom_resolution: true } }];
  assert.equal(isAllowed(rules, linux), false);
  assert.equal(isAllowed(rules, { ...linux, features: { has_custom_resolution: true } }), true);
  const demo = [{ action: 'allow', features: { is_demo_user: true } }];
  assert.equal(isAllowed(demo, { ...linux, features: { is_demo_user: false } }), false);
});

test('last matching rule wins', () => {
  const rules = [
    { action: 'disallow', os: { name: 'linux' } },
    { action: 'allow' },
  ];
  assert.equal(isAllowed(rules, linux), true);
});
