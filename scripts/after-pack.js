'use strict';
/**
 * electron-builder afterPack hook.
 * macOS without a signing certificate: give the app an ad-hoc signature.
 * Apple Silicon refuses to start completely unsigned arm64 code ("is damaged"),
 * while an ad-hoc signed app opens after the usual Gatekeeper confirmation
 * (right-click → Open, or `xattr -dr com.apple.quarantine`).
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing happens later
  if (process.platform !== 'darwin') {
    console.log('  • after-pack: not on macOS, cannot ad-hoc sign (app will be unsigned)');
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • after-pack: ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
