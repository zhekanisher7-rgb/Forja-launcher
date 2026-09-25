'use strict';
/**
 * Global launcher settings (settings.json) with schema versioning.
 */
const os = require('node:os');
const { writeJsonAtomicSync, readJsonSafeSync } = require('./atomic');

const SCHEMA_VERSION = 2;
const ON_GAME_START = ['keep', 'hide', 'close'];

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  language: 'ru',
  username: 'Player',
  authType: 'offline',
  defaultMemoryMb: 2048,
  defaultJavaPath: null, // null = automatic (Mojang runtime)
  concurrency: 12,
  onGameStart: 'keep',
  showSnapshots: false,
  showOld: false,
  selectedProfileId: null,
  glowColor: '#e5534b',
  glowStrength: 70,
  glowDurationSec: 3.5,
  glowAnimations: true,
});
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function totalMemoryMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

/** Migrate older settings objects to the current schema. */
function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const s = { ...raw };
  if (!s.schemaVersion || s.schemaVersion < 2) {
    // v1 (phase 1) → v2
    if (s.memoryMaxMb != null && s.defaultMemoryMb == null) s.defaultMemoryMb = s.memoryMaxMb;
    if (s.javaPath && s.defaultJavaPath == null) s.defaultJavaPath = s.javaPath;
    if (s.filters) {
      s.showSnapshots = Boolean(s.filters.snapshot);
      s.showOld = Boolean(s.filters.old);
    }
    s._legacy = {
      selectedVersion: s.selectedVersion || null,
      extraJvmArgs: s.extraJvmArgs || '',
      resolution: s.resolution || null,
    };
    for (const k of ['memoryMaxMb', 'javaPath', 'filters', 'selectedVersion', 'extraJvmArgs', 'resolution']) delete s[k];
    s.schemaVersion = 2;
  }
  return s;
}

function sanitize(s) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (s[k] !== undefined) out[k] = s[k];
  out.schemaVersion = SCHEMA_VERSION;
  if (!['ru', 'en'].includes(out.language)) out.language = 'ru';
  const maxMem = Math.max(1024, totalMemoryMb() - 512);
  out.defaultMemoryMb = Math.min(Math.max(512, Math.round(Number(out.defaultMemoryMb) || 2048)), maxMem);
  const conc = Number(out.concurrency);
  out.concurrency = Number.isFinite(conc) ? Math.min(32, Math.max(1, Math.round(conc))) : 12;
  if (!ON_GAME_START.includes(out.onGameStart)) out.onGameStart = 'keep';
  out.showSnapshots = Boolean(out.showSnapshots);
  out.showOld = Boolean(out.showOld);
  out.defaultJavaPath = out.defaultJavaPath ? String(out.defaultJavaPath) : null;
  out.username = String(out.username || 'Player').slice(0, 16);
  if (out.authType !== 'offline' && out.authType !== 'microsoft') out.authType = 'offline';
  const color = String(out.glowColor || '');
  out.glowColor = HEX_COLOR.test(color) ? color.toLowerCase() : DEFAULTS.glowColor;
  const strength = Number(out.glowStrength);
  out.glowStrength = Number.isFinite(strength)
    ? Math.min(100, Math.max(0, Math.round(strength)))
    : DEFAULTS.glowStrength;
  const dur = Number(out.glowDurationSec);
  out.glowDurationSec = Number.isFinite(dur)
    ? Math.min(8, Math.max(1.5, Math.round(dur * 10) / 10))
    : DEFAULTS.glowDurationSec;
  out.glowAnimations = Boolean(out.glowAnimations);
  return out;
}

class Settings {
  constructor(file) {
    this.file = file;
    const raw = readJsonSafeSync(file);
    const migrated = migrateSettings(raw);
    /** legacy phase-1 values, consumed by the profile migration */
    this.legacy = migrated._legacy || null;
    this.data = sanitize(migrated);
    if (!raw || raw.schemaVersion !== SCHEMA_VERSION) this.save();
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    const next = { ...this.data };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && k !== 'schemaVersion') next[k] = v;
    }
    this.data = sanitize(next);
    this.save();
    return this.get();
  }

  save() {
    writeJsonAtomicSync(this.file, this.data);
  }
}

module.exports = { Settings, DEFAULTS, SCHEMA_VERSION, migrateSettings, sanitize, totalMemoryMb, ON_GAME_START };
