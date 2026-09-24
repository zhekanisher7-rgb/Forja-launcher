'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  language: 'ru',
  username: 'Player',
  authType: 'offline',
  memoryMaxMb: 2048,
  selectedVersion: null,
  filters: { release: true, snapshot: false, old: false },
  resolution: null,
  javaPath: null,
  extraJvmArgs: '',
};

function totalMemoryMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { /* first run */ }
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(patch || {})) {
      if (allowed.includes(k)) this.data[k] = v;
    }
    const maxMem = Math.max(1024, totalMemoryMb() - 512);
    this.data.memoryMaxMb = Math.min(Math.max(512, Number(this.data.memoryMaxMb) || 2048), maxMem);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS, totalMemoryMb };
