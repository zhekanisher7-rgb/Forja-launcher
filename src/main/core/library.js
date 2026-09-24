'use strict';
/**
 * Library resolution: maven coordinates -> paths/URLs, rules, natives.
 */
const path = require('node:path');
const config = require('../config');
const { isAllowed } = require('./rules');

/**
 * Parse "group:artifact:version[:classifier][@ext]"
 */
function parseMavenName(name) {
  let ext = 'jar';
  let coords = name;
  const at = name.indexOf('@');
  if (at !== -1) {
    ext = name.slice(at + 1);
    coords = name.slice(0, at);
  }
  const parts = coords.split(':');
  if (parts.length < 3) throw new Error(`Invalid maven name: ${name}`);
  const [group, artifact, version, classifier] = parts;
  return { group, artifact, version, classifier: classifier || null, ext };
}

/** Relative path (always forward slashes) for maven coords */
function mavenPath(name, classifierOverride) {
  const m = parseMavenName(name);
  const classifier = classifierOverride || m.classifier;
  const file = `${m.artifact}-${m.version}${classifier ? `-${classifier}` : ''}.${m.ext}`;
  return [...m.group.split('.'), m.artifact, m.version, file].join('/');
}

/** Key used to de-duplicate libraries (without version) */
function libraryKey(name) {
  const m = parseMavenName(name);
  return `${m.group}:${m.artifact}${m.classifier ? `:${m.classifier}` : ''}`;
}

function archBits(arch) {
  return arch === 'ia32' || arch === 'arm' ? '32' : '64';
}

/**
 * Does a modern "natives-<os>[-<arch>]" classifier suit this arch?
 */
function nativeClassifierMatchesArch(classifier, arch) {
  const m = /^natives-[a-z]+(?:-(.+))?$/.exec(classifier || '');
  if (!m) return true;
  const suffix = m[1];
  if (!suffix) return arch === 'x64';
  if (suffix === 'arm64' || suffix === 'aarch64') return arch === 'arm64';
  if (suffix === 'x86') return arch === 'ia32';
  if (suffix === 'arm32') return arch === 'arm';
  return false;
}

/**
 * Resolve a library entry for a given context.
 * @returns {null | {name, key, artifact: Download|null, native: Download|null,
 *                   modernNative: boolean, extract: object|null}}
 *   Download = {path(abs), url, sha1?, size?}
 */
function resolveLibrary(lib, ctx, librariesDir) {
  if (!isAllowed(lib.rules, ctx)) return null;
  const toDownload = (rel, dl) => ({
    path: path.join(librariesDir, ...rel.split('/')),
    url: dl && dl.url ? dl.url : null,
    sha1: dl && dl.sha1 ? dl.sha1 : undefined,
    size: dl && dl.size != null ? dl.size : undefined,
  });
  const baseUrl = (lib.url || config.endpoints.librariesBase).replace(/\/?$/, '/');
  const parsed = parseMavenName(lib.name);

  let artifact = null;
  const dlArtifact = lib.downloads && lib.downloads.artifact;
  if (dlArtifact) {
    const rel = dlArtifact.path || mavenPath(lib.name);
    artifact = toDownload(rel, dlArtifact);
    if (!artifact.url) artifact = null; // e.g. forge-style empty url: locally provided
  } else if (!lib.natives) {
    const rel = mavenPath(lib.name);
    artifact = toDownload(rel, { url: baseUrl + rel });
  }

  // Legacy natives (classifiers map)
  let native = null;
  if (lib.natives && lib.natives[ctx.osName]) {
    const classifier = lib.natives[ctx.osName].replace('${arch}', archBits(ctx.arch));
    const dl = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier];
    const rel = (dl && dl.path) || mavenPath(lib.name, classifier);
    native = toDownload(rel, dl || { url: baseUrl + mavenPath(lib.name, classifier) });
  }

  // Modern natives-as-libraries (1.19+): "group:artifact:version:natives-linux"
  const modernNative = Boolean(parsed.classifier && parsed.classifier.startsWith('natives-'));

  return {
    name: lib.name,
    key: libraryKey(lib.name),
    artifact,
    native,
    modernNative,
    modernNativeForArch: modernNative && nativeClassifierMatchesArch(parsed.classifier, ctx.arch),
    extract: lib.extract || null,
  };
}

/** Resolve all libraries; later entries do not override earlier keys (child-first merge). */
function resolveLibraries(libraries, ctx, librariesDir) {
  const out = [];
  for (const lib of libraries || []) {
    const r = resolveLibrary(lib, ctx, librariesDir);
    if (r) out.push(r);
  }
  return out;
}

module.exports = {
  parseMavenName,
  mavenPath,
  libraryKey,
  resolveLibrary,
  resolveLibraries,
  nativeClassifierMatchesArch,
  archBits,
};
