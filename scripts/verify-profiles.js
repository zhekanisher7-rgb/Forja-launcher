#!/usr/bin/env node
'use strict';
/**
 * Verify every profile without starting the game: installs the profile's
 * loader if needed and re-checks all version files, libraries, assets and
 * Java by SHA1 (the same code as "Проверить и восстановить").
 * A non-zero "repaired" count means files were missing/corrupted and were
 * re-downloaded — after a storage cleanup it must be 0 for every profile.
 *
 *   node scripts/verify-profiles.js [--data DIR] [--profile ID]
 */
const { createLayout } = require('../src/main/core/paths');
const { ProfileStore } = require('../src/main/core/profiles');
const { repairProfile } = require('../src/main/core/repair');

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  const layout = createLayout(opt('--data') || undefined);
  const store = new ProfileStore(layout);
  const only = opt('--profile');
  const list = store.list().filter((p) => p.versionId && (!only || p.id === only));
  let bad = 0;
  for (const profile of list) {
    const label = `${profile.name} [${profile.versionId}${profile.loader.type !== 'vanilla' ? ` ${profile.loader.type} ${profile.loader.version || 'latest'}` : ''}]`;
    try {
      const r = await repairProfile({ layout, profile, concurrency: 8, onLog: () => {} });
      console.log(`${r.repaired ? 'REPAIRED' : 'OK      '} ${label}: version ${r.versionId}, checked ${r.checked} files, re-downloaded ${r.repaired} (${r.repairedBytes} B), ${r.ms} ms`);
      if (r.repaired) bad++;
    } catch (err) {
      bad++;
      console.log(`FAILED   ${label}: ${err.code || ''} ${err.message}`);
    }
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
