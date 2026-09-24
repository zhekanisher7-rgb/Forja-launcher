'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'src', 'renderer');
const ru = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', 'ru.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', 'en.json'), 'utf8'));

test('ru.json and en.json have identical keys and placeholders', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of Object.keys(ru)) assert.equal(ph(ru[k]), ph(en[k]), `placeholders differ for ${k}`);
});

test('every i18n key used by the renderer exists', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of js.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in ru));
  assert.deepEqual(missing, []);
  // dynamic keys
  for (const code of ['network', 'disk', 'permission', 'javaNotFound', 'checksum', 'unknown', 'alreadyRunning']) assert.ok(`error.${code}` in ru);
  for (const s of ['version', 'libraries', 'natives', 'assets', 'java', 'launch']) assert.ok(`step.${s}` in ru);
  for (const i of require('../../src/main/core/profiles').ICON_PRESETS) assert.ok(`icon.${i}` in ru, `icon.${i}`);
});

test('every error code produced by classifyError has a message', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'core', 'errors.js'), 'utf8');
  for (const m of src.matchAll(/out\('([a-zA-Z]+)'/g)) assert.ok(`error.${m[1]}` in ru, `error.${m[1]}`);
});
