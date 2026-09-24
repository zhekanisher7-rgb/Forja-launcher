'use strict';
/**
 * Crash-safe JSON persistence: write to a temp file, fsync, rename over the
 * target (atomic on POSIX and NTFS), keep one .bak of the previous version.
 */
const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  }
  // Windows: rename over an existing file can transiently fail (AV scanners)
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1)); // sync sleep
    }
  }
}

/** Read JSON; on corruption fall back to .bak; return null if neither exists. */
function readJsonSafeSync(file) {
  for (const f of [file, `${file}.bak`]) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && f === file) {
        // corrupted main file: keep a copy for diagnostics, try backup
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
  }
  return null;
}

module.exports = { writeJsonAtomicSync, readJsonSafeSync };
