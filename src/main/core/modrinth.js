'use strict';
/**
 * Minimal Modrinth API v2 client (https://docs.modrinth.com/api/).
 * Sends a descriptive User-Agent as required by Modrinth.
 */
const config = require('../config');
const { HttpError } = require('./http');

const BASE = 'https://api.modrinth.com/v2';
const USER_AGENT = `ForjaLauncher/${config.version} (contact: forja-launcher@example.invalid)`;

// Project types we manage and where their files go inside the game dir
const CONTENT_TYPES = {
  mod: { folder: 'mods', exts: ['.jar'] },
  resourcepack: { folder: 'resourcepacks', exts: ['.zip'] },
  shader: { folder: 'shaderpacks', exts: ['.zip'] },
};

/** Build the `facets` param: AND of OR-groups. */
function buildFacets({ type = 'mod', gameVersion, loader, category } = {}) {
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && (type === 'mod' || type === 'modpack')) facets.push([`categories:${loader}`]);
  if (category) facets.push([`categories:${category}`]);
  return facets;
}

class ModrinthClient {
  constructor({ base = BASE, fetchImpl = globalThis.fetch, cacheMs = 5 * 60 * 1000 } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.cacheMs = cacheMs;
    this.cache = new Map();
  }

  async request(method, pathname, { query, body, signal } = {}) {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null) continue;
      url.searchParams.set(k, typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v));
    }
    const key = method === 'GET' ? url.toString() : null;
    if (key) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.t < this.cacheMs) return hit.v;
    }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetch(url, {
          method,
          signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 429) {
          const wait = Number(res.headers.get('x-ratelimit-reset') || 2);
          await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new HttpError(res.status, url.toString());
        const v = await res.json();
        if (key) this.cache.set(key, { t: Date.now(), v });
        return v;
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) throw err;
        if (err instanceof HttpError && err.status < 500) throw err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  search({ query = '', type = 'mod', gameVersion, loader, category, index = 'relevance', offset = 0, limit = 20, signal } = {}) {
    return this.request('GET', '/search', {
      query: { query, facets: buildFacets({ type, gameVersion, loader, category }), index, offset, limit }, signal,
    });
  }

  project(idOrSlug, opts) { return this.request('GET', `/project/${encodeURIComponent(idOrSlug)}`, opts); }

  projects(ids, opts) {
    if (!ids.length) return Promise.resolve([]);
    return this.request('GET', '/projects', { query: { ids }, ...opts });
  }

  projectVersions(idOrSlug, { loaders, gameVersions, signal } = {}) {
    return this.request('GET', `/project/${encodeURIComponent(idOrSlug)}/version`, {
      query: { loaders: loaders && loaders.length ? loaders : undefined, game_versions: gameVersions && gameVersions.length ? gameVersions : undefined },
      signal,
    });
  }

  version(id, opts) { return this.request('GET', `/version/${encodeURIComponent(id)}`, opts); }

  versionsByHashes(hashes, { algorithm = 'sha1', signal } = {}) {
    if (!hashes.length) return Promise.resolve({});
    return this.request('POST', '/version_files', { body: { hashes, algorithm }, signal });
  }

  latestVersionsByHashes(hashes, { algorithm = 'sha1', loaders, gameVersions, signal } = {}) {
    if (!hashes.length) return Promise.resolve({});
    const body = { hashes, algorithm };
    if (loaders && loaders.length) body.loaders = loaders;
    if (gameVersions && gameVersions.length) body.game_versions = gameVersions;
    return this.request('POST', '/version_files/update', { body, signal });
  }

  categories(opts) { return this.request('GET', '/tag/category', opts); }
}

/** Primary file of a version (or the first one). */
function primaryFile(version) {
  const files = (version && version.files) || [];
  return files.find((f) => f.primary) || files[0] || null;
}

/** Prefer release > beta > alpha among versions (API returns newest first). */
function pickBestVersion(versions) {
  const list = versions || [];
  return list.find((v) => v.version_type === 'release') || list.find((v) => v.version_type === 'beta') || list[0] || null;
}

/** Loaders to query for a profile's content type. */
function loadersFor(type, profileLoader) {
  if (type === 'mod') {
    if (!profileLoader || profileLoader === 'vanilla') return [];
    // Quilt can load most Fabric mods
    return profileLoader === 'quilt' ? ['quilt', 'fabric'] : [profileLoader];
  }
  if (type === 'resourcepack') return ['minecraft'];
  return []; // shaders: iris/optifine/canvas/vanilla — any
}

module.exports = { ModrinthClient, buildFacets, primaryFile, pickBestVersion, loadersFor, CONTENT_TYPES, USER_AGENT, BASE };
