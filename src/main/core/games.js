'use strict';
/**
 * GameManager: tracks preparing/running games, one per profile.
 * Emits:
 *   'state'    { profileId, state: preparing|running|exited|cancelled|error, ... }
 *   'progress' { profileId, ...progress }
 *   'log'      { profileId, line, source }
 *   'crash'    { profileId, code, signal, lines[], crashReportsDir, crashReport }
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const LOG_BUFFER = 2000;
const CRASH_LINES = 50;

function findNewestFile(dir, sinceMs, filter = () => true) {
  try {
    const files = fs.readdirSync(dir)
      .filter(filter)
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.m >= sinceMs - 1000)
      .sort((a, b) => b.m - a.m);
    return files.length ? files[0].f : null;
  } catch {
    return null;
  }
}

class GameManager extends EventEmitter {
  /** @param {{ launchFn: Function }} deps launchFn has prepareAndLaunch's signature */
  constructor({ launchFn }) {
    super();
    this.launchFn = launchFn;
    this.jobs = new Map(); // profileId -> job
    this.logs = new Map(); // profileId -> string[] (persist after exit)
  }

  isBusy(profileId) {
    return this.jobs.has(profileId);
  }

  status() {
    return [...this.jobs.values()].map((j) => ({
      profileId: j.profileId, state: j.state, pid: j.child ? j.child.pid : null, startedAt: j.startedAt, versionId: j.versionId,
    }));
  }

  runningCount() {
    return [...this.jobs.values()].filter((j) => j.state === 'running').length;
  }

  getLogs(profileId) {
    return [...(this.logs.get(profileId) || [])];
  }

  pushLog(profileId, line, source) {
    let buf = this.logs.get(profileId);
    if (!buf) {
      buf = [];
      this.logs.set(profileId, buf);
    }
    buf.push(line);
    if (buf.length > LOG_BUFFER) buf.splice(0, buf.length - LOG_BUFFER);
    this.emit('log', { profileId, line, source });
  }

  /**
   * Prepare + launch a profile. Resolves once the game process is spawned.
   * @param {{ profileId, gameDir, versionId, launchOptions }} o
   */
  async start({ profileId, gameDir, versionId, launchOptions }) {
    if (this.jobs.has(profileId)) {
      const err = new Error('Profile already running');
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    const controller = new AbortController();
    const job = { profileId, versionId, gameDir, controller, child: null, state: 'preparing', startedAt: Date.now(), killedByUser: false, gameLines: [] };
    this.jobs.set(profileId, job);
    this.logs.set(profileId, []);
    this.emit('state', { profileId, state: 'preparing' });
    let launched;
    try {
      launched = await this.launchFn({
        ...launchOptions,
        versionId,
        gameDir,
        signal: controller.signal,
        onProgress: (p) => this.emit('progress', { profileId, ...p }),
        onLog: (line) => this.pushLog(profileId, line, 'launcher'),
        onGameLog: (line, stream) => {
          job.gameLines.push(line);
          if (job.gameLines.length > CRASH_LINES * 4) job.gameLines.splice(0, job.gameLines.length - CRASH_LINES * 2);
          this.pushLog(profileId, line, stream);
        },
      });
    } catch (err) {
      this.jobs.delete(profileId);
      const cancelled = Boolean(err && err.cancelled);
      this.emit('state', cancelled ? { profileId, state: 'cancelled' } : { profileId, state: 'error', error: err });
      throw err;
    }
    job.child = launched.child;
    job.state = 'running';
    job.startedAt = Date.now();
    this.emit('state', { profileId, state: 'running', pid: launched.child.pid });
    launched.exited.then(({ code, signal }) => {
      this.jobs.delete(profileId);
      this.emit('state', { profileId, state: 'exited', code, signal, killedByUser: job.killedByUser });
      const crashed = !job.killedByUser && (code !== 0 || (code == null && signal));
      if (crashed) {
        const crashReportsDir = path.join(gameDir, 'crash-reports');
        this.emit('crash', {
          profileId,
          versionId,
          code,
          signal,
          lines: job.gameLines.slice(-CRASH_LINES).length
            ? job.gameLines.slice(-CRASH_LINES)
            : this.getLogs(profileId).slice(-CRASH_LINES),
          crashReportsDir,
          crashReport: findNewestFile(crashReportsDir, job.startedAt, (f) => f.endsWith('.txt'))
            || findNewestFile(gameDir, job.startedAt, (f) => /^hs_err_pid\d+\.log$/.test(f)),
        });
      }
    }).catch((err) => {
      this.jobs.delete(profileId);
      this.emit('state', { profileId, state: 'error', error: err });
    });
    return { pid: launched.child.pid };
  }

  cancel(profileId) {
    const job = this.jobs.get(profileId);
    if (!job || job.state !== 'preparing') return false;
    job.controller.abort();
    return true;
  }

  kill(profileId) {
    const job = this.jobs.get(profileId);
    if (!job || !job.child) return false;
    job.killedByUser = true;
    job.child.kill();
    // escalate if it does not exit
    setTimeout(() => {
      if (this.jobs.get(profileId) === job) {
        try { job.child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }, 8000).unref();
    return true;
  }

  /** Detach from running games (launcher closing); abort preparations. */
  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.state === 'preparing') job.controller.abort();
    }
  }
}

module.exports = { GameManager, CRASH_LINES, LOG_BUFFER };
