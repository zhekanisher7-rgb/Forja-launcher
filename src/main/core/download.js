'use strict';
/**
 * Parallel downloader with SHA1 verification, retries, resume (HTTP Range)
 * and skipping of already-valid files.
 *
 * Task: { url, path, sha1?, size?, executable? }
 *
 * verifyExisting:
 *   true / 'sha1'  — full size + SHA-1 (repair / force)
 *   'size'         — trust size match, skip SHA-1 (fast relaunch)
 *   false          — never skip; always re-download
 *
 * Optional on-disk verify stamp cache (path → { size, mtimeMs, sha1 })
 * skips re-hash when mtime+size still match a previously verified digest.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fetchWithUA, HttpError } = require('./http');

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Normalize verifyExisting option → { enabled, trustSize }. */
function parseVerifyMode(verifyExisting) {
  if (verifyExisting === false) return { enabled: false, trustSize: false };
  if (verifyExisting === 'size' || verifyExisting === 'trustSize') return { enabled: true, trustSize: true };
  return { enabled: true, trustSize: false }; // true | 'sha1' | undefined
}

/**
 * On-disk stamp cache: absolute path → { size, mtimeMs, sha1 }.
 * Invalidates when size or mtimeMs diverges from the live file.
 */
class VerifyCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    this.loaded = false;
  }

  async load() {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v.sha1 === 'string' && typeof v.size === 'number') this.map.set(k, v);
        }
      }
    } catch { /* missing / corrupt → empty */ }
  }

  get(absPath) {
    return this.map.get(absPath) || null;
  }

  set(absPath, entry) {
    this.map.set(absPath, entry);
    this.dirty = true;
  }

  async save() {
    if (!this.dirty || !this.file) return;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const obj = Object.create(null);
    for (const [k, v] of this.map) obj[k] = v;
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj));
    await fsp.rename(tmp, this.file);
    this.dirty = false;
  }
}

function verifyCachePath(cacheDir) {
  return cacheDir ? path.join(cacheDir, 'verify-cache.json') : null;
}

/**
 * true if file exists and matches size/sha1 (when given).
 * Options:
 *   trustSize — if size is given and matches, skip SHA-1
 *   verifyCache — VerifyCache instance for stamp-based skip
 */
async function isFileValid(file, { sha1, size, trustSize = false, verifyCache = null } = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (size != null && st.size !== size) return false;
  if (trustSize && size != null) return true;
  if (!sha1) return true;

  const want = sha1.toLowerCase();
  const abs = path.resolve(file);
  if (verifyCache) {
    const cached = verifyCache.get(abs);
    if (cached
      && cached.size === st.size
      && cached.mtimeMs === st.mtimeMs
      && cached.sha1 === want) {
      return true;
    }
  }
  const dig = await sha1File(file);
  if (verifyCache) {
    // Re-stat after hash in case something touched the file mid-read
    const st2 = await fsp.stat(file).catch(() => st);
    verifyCache.set(abs, { size: st2.size, mtimeMs: st2.mtimeMs, sha1: dig });
  }
  return dig === want;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new CancelledError();
}

async function downloadOnce(task, { signal, onBytes, stallTimeoutMs }) {
  const part = `${task.path}.part`;
  await fsp.mkdir(path.dirname(task.path), { recursive: true });

  // Resume support: continue an existing .part file via HTTP Range.
  let start = 0;
  try {
    const st = await fsp.stat(part);
    if (task.size != null && st.size > 0 && st.size < task.size) start = st.size;
    else await fsp.rm(part, { force: true });
  } catch { /* no part file */ }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let stallTimer;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new Error('stalled')), stallTimeoutMs);
  };

  try {
    armStall();
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const res = await fetchWithUA(task.url, { signal: ctrl.signal, headers });
    if (res.status === 200) {
      start = 0;
    } else if (res.status !== 206) {
      throw new HttpError(res.status, task.url);
    }
    const hash = crypto.createHash('sha1');
    if (start > 0) {
      await pipeline(fs.createReadStream(part), new Transform({
        transform(chunk, _e, cb) { hash.update(chunk); cb(); },
      }));
      onBytes(start);
    }
    let written = start;
    const meter = new Transform({
      transform(chunk, _e, cb) {
        armStall();
        hash.update(chunk);
        written += chunk.length;
        onBytes(chunk.length);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body),
      meter,
      fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
    );
    const digest = hash.digest('hex');
    if (task.size != null && written !== task.size) {
      await fsp.rm(part, { force: true });
      throw new Error(`Size mismatch for ${task.url}: ${written} != ${task.size}`);
    }
    if (task.sha1 && digest !== task.sha1.toLowerCase()) {
      await fsp.rm(part, { force: true });
      throw new Error(`SHA1 mismatch for ${task.url}: ${digest} != ${task.sha1}`);
    }
    await fsp.rename(part, task.path);
    if (task.executable && process.platform !== 'win32') await fsp.chmod(task.path, 0o755);
    return written;
  } catch (err) {
    if (signal && signal.aborted) throw new CancelledError();
    throw err;
  } finally {
    clearTimeout(stallTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Sum of bytes still missing on disk (files absent or with wrong size).
 * Cheap: only stat() calls.
 */
async function estimateMissingBytes(tasks) {
  let missing = 0;
  await Promise.all(tasks.map(async (t) => {
    try {
      const st = await fsp.stat(t.path);
      if (t.size != null && st.size !== t.size) missing += t.size;
    } catch {
      missing += t.size || 0;
    }
  }));
  return missing;
}

/** Free bytes on the filesystem containing `dir` (null if unknown). */
async function freeDiskBytes(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  let d = path.resolve(dir);
  for (;;) {
    try {
      const st = await fsp.statfs(d);
      return st.bavail * st.bsize;
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
}

/** Throw ENOSPC early if the missing files will not fit (with 50 MB margin). */
async function ensureDiskSpace(tasks, { margin = 50 * 1024 * 1024 } = {}) {
  if (!tasks.length) return;
  const needed = await estimateMissingBytes(tasks);
  if (needed === 0) return;
  const free = await freeDiskBytes(path.dirname(tasks[0].path));
  if (free != null && free < needed + margin) {
    const err = new Error(`Not enough disk space: need ${needed} bytes, free ${free}`);
    err.code = 'ENOSPC';
    err.neededBytes = needed;
    err.freeBytes = free;
    throw err;
  }
}

/** Run async work over items with a fixed concurrency pool. */
async function runPool(items, concurrency, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Download a list of tasks.
 * @returns {Promise<{downloaded:number, skipped:number, bytes:number, totalBytes:number, ms:number}>}
 */
async function downloadAll(tasks, {
  concurrency = 12,
  retries = 4,
  signal,
  onProgress,
  progressIntervalMs = 100,
  stallTimeoutMs = 30000,
  verifyExisting = true,
  checkDiskSpace = true,
  verifyCache = null,
  trustSize = undefined,
} = {}) {
  const t0 = Date.now();
  const mode = parseVerifyMode(verifyExisting);
  // Explicit trustSize overrides verifyExisting string mode
  if (trustSize === true) mode.trustSize = true;
  if (trustSize === false && verifyExisting !== 'size' && verifyExisting !== 'trustSize') mode.trustSize = false;

  if (verifyCache) await verifyCache.load();

  // Deduplicate by destination path
  const unique = [...new Map(tasks.map((t) => [path.resolve(t.path), t])).values()];
  const state = {
    totalFiles: unique.length,
    doneFiles: 0,
    totalBytes: unique.reduce((s, t) => s + (t.size || 0), 0),
    doneBytes: 0,
    downloadedBytes: 0,
    downloaded: 0,
    skipped: 0,
    current: null,
    speedBps: 0,
    etaSec: null,
  };
  if (checkDiskSpace) await ensureDiskSpace(unique);
  let lastEmit = 0;
  // speed: exponential moving average of network bytes/sec
  let lastSampleT = Date.now();
  let lastSampleBytes = 0;
  const emit = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < progressIntervalMs) return;
    lastEmit = now;
    const dt = (now - lastSampleT) / 1000;
    if (dt >= 0.5) {
      const inst = (state.downloadedBytes - lastSampleBytes) / dt;
      state.speedBps = state.speedBps ? state.speedBps * 0.7 + inst * 0.3 : inst;
      lastSampleT = now;
      lastSampleBytes = state.downloadedBytes;
      const remaining = Math.max(0, state.totalBytes - state.doneBytes);
      state.etaSec = state.speedBps > 1024 && remaining > 0 ? Math.round(remaining / state.speedBps) : null;
    }
    onProgress({ ...state });
  };
  emit(true);

  let index = 0;
  let failed = false;
  const worker = async () => {
    while (index < unique.length && !failed) {
      throwIfAborted(signal);
      const task = unique[index++];
      state.current = path.basename(task.path);
      if (mode.enabled && await isFileValid(task.path, {
        sha1: task.sha1,
        size: task.size,
        trustSize: mode.trustSize,
        verifyCache: mode.trustSize ? null : verifyCache,
      })) {
        if (task.executable && process.platform !== 'win32') {
          await fsp.chmod(task.path, 0o755).catch(() => {});
        }
        state.skipped++;
        state.doneFiles++;
        state.doneBytes += task.size || 0;
        emit();
        continue;
      }
      let attempt = 0;
      for (;;) {
        let counted = 0;
        try {
          await downloadOnce(task, {
            signal,
            stallTimeoutMs,
            onBytes: (n) => {
              counted += n;
              state.doneBytes += n;
              state.downloadedBytes += n;
              emit();
            },
          });
          // Stamp freshly downloaded file so a later full-verify can skip rehash
          if (verifyCache && task.sha1) {
            try {
              const st = await fsp.stat(task.path);
              verifyCache.set(path.resolve(task.path), {
                size: st.size, mtimeMs: st.mtimeMs, sha1: task.sha1.toLowerCase(),
              });
            } catch { /* ignore */ }
          }
          // correct accounting when size was unknown / differs
          if (task.size != null) state.doneBytes += task.size - counted;
          break;
        } catch (err) {
          state.doneBytes -= counted;
          state.downloadedBytes -= counted;
          if (err.cancelled) throw err;
          const fatal = err instanceof HttpError && err.status === 404;
          if (fatal || attempt >= retries) {
            err.message = `${err.message} (${task.url})`;
            throw err;
          }
          attempt++;
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          throwIfAborted(signal);
        }
      }
      state.downloaded++;
      state.doneFiles++;
      emit();
    }
  };

  const guarded = async () => {
    try {
      await worker();
    } catch (err) {
      failed = true;
      throw err;
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, guarded);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) {
    throwIfAborted(signal);
    throw rejected.reason;
  }
  state.current = null;
  emit(true);
  if (verifyCache) await verifyCache.save().catch(() => {});
  return {
    downloaded: state.downloaded,
    skipped: state.skipped,
    bytes: state.downloadedBytes,
    totalBytes: state.totalBytes,
    files: state.totalFiles,
    ms: Date.now() - t0,
  };
}

module.exports = {
  downloadAll,
  isFileValid,
  sha1File,
  CancelledError,
  ensureDiskSpace,
  estimateMissingBytes,
  freeDiskBytes,
  VerifyCache,
  verifyCachePath,
  parseVerifyMode,
  runPool,
};
