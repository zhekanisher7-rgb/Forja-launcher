'use strict';
// Fails fast with a clear message when node_modules is missing or incomplete
// (e.g. after a fresh clone or a machine restore), instead of every test file
// dying with "Cannot find module".
const pkg = require('../package.json');

const missing = Object.keys(pkg.dependencies || {}).filter((name) => {
  try { require.resolve(`${name}/package.json`); return false; } catch { return true; }
});
if (missing.length) {
  console.error(`Missing dependencies: ${missing.join(', ')}\nRun "npm ci" (or "npm install") first.`);
  process.exit(1);
}
