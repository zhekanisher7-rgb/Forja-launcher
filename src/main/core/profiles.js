'use strict';
/**
 * Profiles (instances). Persisted in <data>/profiles.json:
 *   { schemaVersion, profiles: [Profile] }
 * Each profile has its own game directory: <data>/instances/<id>/
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomicSync, readJsonSafeSync } = require('./atomic');
const { normalizeLoader } = require('./loaders');

const SCHEMA_VERSION = 1;
const ICON_PRESETS = ['anvil', 'flame', 'hammer', 'gem', 'tree', 'mountain', 'shield', 'star', 'compass', 'rocket', 'leaf', 'bolt'];
const COLORS = ['#e8743b', '#d9534f', '#3fb96b', '#3b82f6', '#8b5cf6', '#eab308', '#14b8a6', '#ec4899', '#64748b'];

function slugify(name) {
  const translit = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const s = String(name || '').toLowerCase().split('').map((c) => (c in translit ? translit[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'profile';
}

function newId(name, existing) {
  const base = slugify(name);
  for (;;) {
    const id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
}

function normalizeIcon(icon, name) {
  const i = icon && typeof icon === 'object' ? icon : {};
  const color = /^#[0-9a-fA-F]{6}$/.test(i.color || '') ? i.color : COLORS[0];
  if (i.type === 'preset' && ICON_PRESETS.includes(i.preset)) return { type: 'preset', preset: i.preset, color };
  const letter = String(i.letter || name || '?').trim().charAt(0).toUpperCase() || '?';
  return { type: 'letter', letter, color };
}

function normalizeResolution(r) {
  if (!r || typeof r !== 'object') return { width: null, height: null, fullscreen: false };
  const num = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 320 && n <= 16384 ? n : null;
  };
  return { width: num(r.width), height: num(r.height), fullscreen: Boolean(r.fullscreen) };
}

function normalizeJava(j) {
  if (j && j.mode === 'custom' && j.path) return { mode: 'custom', path: String(j.path) };
  return { mode: 'auto', path: null };
}

/** Validate and fill defaults. Throws on invalid name. */
function normalizeProfile(p, { requireVersion = false } = {}) {
  const name = String((p && p.name) || '').trim().slice(0, 40);
  if (!name) {
    const err = new Error('Profile name is required');
    err.code = 'PROFILE_NAME_REQUIRED';
    throw err;
  }
  if (requireVersion && !p.versionId) {
    const err = new Error('Profile version is required');
    err.code = 'PROFILE_VERSION_REQUIRED';
    throw err;
  }
  const mem = p.memoryMaxMb == null || p.memoryMaxMb === '' ? null : Math.round(Number(p.memoryMaxMb));
  return {
    id: p.id,
    name,
    icon: normalizeIcon(p.icon, name),
    versionId: p.versionId ? String(p.versionId) : null,
    memoryMaxMb: Number.isFinite(mem) && mem >= 512 ? mem : null, // null = global default
    jvmArgs: String(p.jvmArgs || '').slice(0, 4000),
    resolution: normalizeResolution(p.resolution),
    java: normalizeJava(p.java),
    loader: normalizeLoader(p.loader),
    modpack: p.modpack && typeof p.modpack === 'object'
      ? { name: String(p.modpack.name || '').slice(0, 80), versionId: p.modpack.versionId ? String(p.modpack.versionId).slice(0, 80) : null, source: p.modpack.source || null }
      : null,
    created: p.created || new Date().toISOString(),
    lastPlayed: p.lastPlayed || null,
    coverImage: typeof p.coverImage === 'string' ? p.coverImage.slice(0, 2048) : null,
    pinned: Boolean(p.pinned),
    playTimeSec: Number.isFinite(Number(p.playTimeSec)) ? Math.max(0, Math.round(Number(p.playTimeSec))) : 0,
  };
}

class ProfileStore {
  /**
   * @param {object} layout from paths.createLayout
   * @param {{legacy?: object}} opts legacy phase-1 settings for migration
   */
  constructor(layout, { legacy = null } = {}) {
    this.layout = layout;
    this.file = path.join(layout.root, 'profiles.json');
    const raw = readJsonSafeSync(this.file);
    if (raw && Array.isArray(raw.profiles)) {
      this.profiles = raw.profiles.map((p) => {
        try { return normalizeProfile(p); } catch { return null; }
      }).filter((p) => p && p.id && /^[a-z0-9-]+$/.test(p.id));
      this.migrated = false;
    } else {
      this.profiles = [];
      this.migrate(legacy);
      this.migrated = true;
    }
  }

  /** First run / phase-1 upgrade: create 'Default' profile using instances/default. */
  migrate(legacy) {
    const l = legacy || {};
    const profile = normalizeProfile({
      id: 'default',
      name: 'Default',
      icon: { type: 'preset', preset: 'anvil', color: COLORS[0] },
      versionId: l.selectedVersion || null,
      jvmArgs: l.extraJvmArgs || '',
      resolution: l.resolution || null,
    });
    fs.mkdirSync(this.gameDir(profile.id), { recursive: true });
    this.profiles = [profile];
    this.save();
  }

  save() {
    writeJsonAtomicSync(this.file, { schemaVersion: SCHEMA_VERSION, profiles: this.profiles });
  }

  list() {
    return this.profiles.map((p) => ({ ...p, gameDir: this.gameDir(p.id) }));
  }

  get(id) {
    const p = this.profiles.find((x) => x.id === id);
    return p ? { ...p, gameDir: this.gameDir(p.id) } : null;
  }

  gameDir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid profile id: ${id}`);
    return this.layout.instanceDir(id);
  }

  create(data) {
    const ids = new Set(this.profiles.map((p) => p.id));
    const profile = normalizeProfile({ ...data, id: newId(data && data.name, ids), created: null, lastPlayed: null }, { requireVersion: true });
    fs.mkdirSync(this.gameDir(profile.id), { recursive: true });
    this.profiles.push(profile);
    this.save();
    return this.get(profile.id);
  }

  update(id, patch) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw notFound(id);
    const cur = this.profiles[idx];
    const next = normalizeProfile({ ...cur, ...patch, id: cur.id, created: cur.created }, { requireVersion: true });
    this.profiles[idx] = next;
    this.save();
    return this.get(id);
  }

  touch(id) {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return null;
    p.lastPlayed = new Date().toISOString();
    this.save();
    return this.get(id);
  }

  addPlayTime(id, seconds) {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return null;
    const sec = Math.max(0, Math.round(Number(seconds) || 0));
    p.playTimeSec = (Number(p.playTimeSec) || 0) + sec;
    p.lastPlayed = new Date().toISOString();
    this.save();
    return this.get(id);
  }

  setPinned(id, pinned) {
    return this.update(id, { pinned: Boolean(pinned) });
  }

  duplicate(id, { copyFiles = false, name } = {}) {
    const src = this.profiles.find((p) => p.id === id);
    if (!src) throw notFound(id);
    const ids = new Set(this.profiles.map((p) => p.id));
    const newName = (name || `${src.name} (copy)`).slice(0, 40);
    const copy = normalizeProfile({ ...src, id: newId(newName, ids), name: newName, created: null, lastPlayed: null });
    if (copyFiles && fs.existsSync(this.gameDir(src.id))) {
      fs.cpSync(this.gameDir(src.id), this.gameDir(copy.id), { recursive: true, force: true, errorOnExist: false });
    }
    fs.mkdirSync(this.gameDir(copy.id), { recursive: true });
    this.profiles.push(copy);
    this.save();
    return this.get(copy.id);
  }

  remove(id, { deleteFiles = false } = {}) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw notFound(id);
    if (this.profiles.length === 1) {
      const err = new Error('Cannot delete the last profile');
      err.code = 'PROFILE_LAST';
      throw err;
    }
    this.profiles.splice(idx, 1);
    this.save();
    if (deleteFiles) fs.rmSync(this.gameDir(id), { recursive: true, force: true, maxRetries: 3 });
    return true;
  }
}

function notFound(id) {
  const err = new Error(`Profile not found: ${id}`);
  err.code = 'PROFILE_NOT_FOUND';
  return err;
}

module.exports = { ProfileStore, normalizeProfile, slugify, ICON_PRESETS, COLORS, SCHEMA_VERSION };
