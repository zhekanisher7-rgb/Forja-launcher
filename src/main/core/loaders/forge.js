'use strict';
/**
 * Forge (maven.minecraftforge.net) and NeoForge (maven.neoforged.net) via
 * their official installer jars, run headlessly:
 *  - modern installers (spec ≥ 0, version.json + install_profile.json): download
 *    libraries, extract bundled maven/ files, run client-side processors with
 *    {DATA}/[maven] substitution and verify their declared outputs (SHA1);
 *  - legacy installers (install_profile.json with `install` + `versionInfo`,
 *    ≤ 1.12 era): write versionInfo as the version JSON and extract the universal jar.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AdmZip = require('adm-zip');
const { fetchWithUA, fetchJson, HttpError } = require('../http');
const { downloadAll, isFileValid, sha1File, CancelledError } = require('../download');
const { mavenPath } = require('../library');
const { classpathSeparator } = require('../platform');
const { compareVersions } = require('./meta');

const FLAVORS = {
  forge: {
    name: 'Forge',
    maven: 'https://maven.minecraftforge.net/',
    group: 'net/minecraftforge/forge',
    artifact: 'forge',
    promotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  },
  neoforge: {
    name: 'NeoForge',
    maven: 'https://maven.neoforged.net/releases/',
    group: 'net/neoforged/neoforge',
    artifact: 'neoforge',
    versionsApi: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
  },
};

async function fetchText(url, { signal } = {}) {
  const res = await fetchWithUA(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

/** NeoForge version → Minecraft version: 20.4.x → 1.20.4, 21.0.x → 1.21, 26.1.0.x → 26.1 */
function neoforgeMcVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 25) {
    // year-based Minecraft versions: 26.1.0.x → 26.1 ; 26.1.1.x → 26.1.1
    const patch = m[3] && Number(m[3]) ? `.${m[3]}` : '';
    return `${major}.${minor}${patch}`;
  }
  return minor ? `1.${major}.${minor}` : `1.${major}`;
}

/**
 * List loader versions for a Minecraft version, newest first.
 * @returns {Promise<Array<{version, full, stable, recommended?, latest?}>>}
 */
async function listVersions(flavor, mcVersion, { signal } = {}) {
  const f = FLAVORS[flavor];
  if (flavor === 'neoforge') {
    const data = await fetchJson(f.versionsApi, { signal });
    const list = (data.versions || [])
      .filter((v) => neoforgeMcVersion(v) === mcVersion)
      .map((v) => ({ version: v, full: v, stable: !/beta|alpha/i.test(v) }))
      .sort((a, b) => compareVersions(b.version, a.version));
    if (list.length) {
      const latestStable = list.find((v) => v.stable) || list[0];
      latestStable.recommended = true;
      list[0].latest = true;
    }
    return list;
  }
  const xml = await fetchText(`${f.maven}${f.group}/maven-metadata.xml`, { signal });
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  let promos = {};
  try {
    promos = (await fetchJson(f.promotions, { signal })).promos || {};
  } catch { /* optional */ }
  const rec = promos[`${mcVersion}-recommended`];
  const lat = promos[`${mcVersion}-latest`];
  const list = all
    .filter((full) => full.startsWith(`${mcVersion}-`))
    .map((full) => {
      const version = full.slice(mcVersion.length + 1).replace(new RegExp(`-${mcVersion.replace(/\./g, '\\.')}$`), '');
      return { version, full, stable: true, recommended: version === rec, latest: version === lat };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
  if (list.length && !list.some((v) => v.recommended)) {
    (list.find((v) => v.latest) || list[0]).recommended = true;
  }
  return list;
}

function installerUrl(flavor, full) {
  const f = FLAVORS[flavor];
  return `${f.maven}${f.group}/${full}/${f.artifact}-${full}-installer.jar`;
}

// ---------------------------------------------------------------------------
// Processor argument / data substitution (pure, unit-tested)

/** Resolve one install_profile `data` value for the client side. */
function resolveDataValue(value, { librariesDir, extract }) {
  const v = String(value);
  if (v.startsWith('[') && v.endsWith(']')) {
    return path.join(librariesDir, ...mavenPath(v.slice(1, -1)).split('/'));
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.startsWith('/')) return extract(v); // file inside the installer jar
  return v;
}

/** Build the data map: built-ins + install_profile.data (client side). */
function buildDataMap(profileData, { side = 'client', minecraftJar, minecraftVersion, root, installer, librariesDir, extract }) {
  const data = {
    SIDE: side,
    MINECRAFT_JAR: minecraftJar,
    MINECRAFT_VERSION: minecraftVersion,
    ROOT: root,
    INSTALLER: installer,
    LIBRARY_DIR: librariesDir,
  };
  for (const [key, sides] of Object.entries(profileData || {})) {
    const raw = sides && typeof sides === 'object' ? sides[side] : sides;
    if (raw == null) continue;
    data[key] = resolveDataValue(raw, { librariesDir, extract });
  }
  return data;
}

/**
 * Substitute a processor argument: `{KEY}` from data, `[group:artifact:ver]`
 * as a library path, `\{` / `\[` escapes, and embedded {KEY} inside strings.
 */
function substituteProcessorArg(arg, data, librariesDir) {
  const a = String(arg);
  if (a.startsWith('[') && a.endsWith(']')) {
    return path.join(librariesDir, ...mavenPath(a.slice(1, -1)).split('/'));
  }
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\\' && (a[i + 1] === '{' || a[i + 1] === '}' || a[i + 1] === '[' || a[i + 1] === ']')) {
      out += a[i + 1];
      i++;
    } else if (ch === '{') {
      const end = a.indexOf('}', i);
      if (end === -1) throw new Error(`Unclosed {} in processor arg: ${a}`);
      const key = a.slice(i + 1, end);
      if (!(key in data)) throw new Error(`Missing processor data key: ${key}`);
      out += data[key];
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

function processorsForSide(processors, side = 'client') {
  return (processors || []).filter((p) => !p.sides || p.sides.includes(side));
}

/** Library entries (install_profile / version.json) → download tasks + bundled extracts. */
function libraryPlan(libraries, librariesDir) {
  const tasks = [];
  const bundled = [];
  for (const lib of libraries || []) {
    const art = lib.downloads && lib.downloads.artifact;
    const rel = (art && art.path) || mavenPath(lib.name);
    const abs = path.join(librariesDir, ...rel.split('/'));
    if (art && art.url) tasks.push({ url: art.url, path: abs, sha1: art.sha1, size: art.size });
    else if (!art && lib.url) tasks.push({ url: `${lib.url.replace(/\/?$/, '/')}${rel}`, path: abs });
    else bundled.push({ rel, path: abs, sha1: art && art.sha1 });
  }
  return { tasks, bundled };
}

function jarMainClass(jarPath) {
  const zip = new AdmZip(jarPath);
  const mf = zip.getEntry('META-INF/MANIFEST.MF');
  if (!mf) throw new Error(`No manifest in ${jarPath}`);
  const text = mf.getData().toString('utf8').replace(/\r?\n /g, '');
  const m = /^Main-Class:\s*(.+)$/m.exec(text);
  if (!m) throw new Error(`No Main-Class in ${jarPath}`);
  return m[1].trim();
}

function runJava(javaPath, args, { cwd, onLog, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLog(`  ${line}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new CancelledError());
      if (code === 0) return resolve();
      const err = new Error(`Processor failed (exit ${code}): ${tail.slice(-5).join(' | ')}`);
      err.code = 'LOADER_PROCESSOR_FAILED';
      reject(err);
    });
  });
}

/**
 * Install a Forge/NeoForge version.
 * @param {object} o
 * @param {'forge'|'neoforge'} o.flavor
 * @param {string} o.full maven version (e.g. 1.20.1-47.4.10, 21.1.209)
 * @param {string} o.mcVersion
 * @param {string} o.minecraftJar path to the installed vanilla client jar
 * @param {string} o.javaPath java used for processors
 * @returns {Promise<{versionId, extraFiles: string[]}>}
 */
async function install({ flavor, layout, full, mcVersion, minecraftJar, javaPath, signal,
  onLog = () => {}, onProgress = () => {}, concurrency = 12 }) {
  const f = FLAVORS[flavor];
  const tmp = await fsp.mkdtemp(path.join(layout.root, 'tmp', `${flavor}-`)).catch(async () => {
    await fsp.mkdir(path.join(layout.root, 'tmp'), { recursive: true });
    return fsp.mkdtemp(path.join(layout.root, 'tmp', `${flavor}-`));
  });
  try {
    const installer = path.join(tmp, 'installer.jar');
    onLog(`${f.name} ${full}: загрузка установщика`);
    await downloadAll([{ url: installerUrl(flavor, full), path: installer }], { signal });
    const zip = new AdmZip(installer);
    const readJson = (name) => {
      const e = zip.getEntry(name.replace(/^\//, ''));
      return e ? JSON.parse(e.getData().toString('utf8')) : null;
    };
    const profile = readJson('install_profile.json');
    if (!profile) throw new Error('install_profile.json not found in installer');

    // ---- Legacy format (≤1.12 era): { install, versionInfo }
    if (profile.versionInfo && profile.install) {
      const vi = profile.versionInfo;
      const id = vi.id;
      const libRel = mavenPath(profile.install.path);
      const libAbs = path.join(layout.libraries, ...libRel.split('/'));
      await fsp.mkdir(path.dirname(libAbs), { recursive: true });
      const entry = zip.getEntry(profile.install.filePath);
      if (!entry) throw new Error(`${profile.install.filePath} not found in installer`);
      await fsp.writeFile(libAbs, entry.getData());
      // Vanilla-launcher semantics: skip server-only entries; the universal jar is local-only;
      // old files.minecraftforge.net maven URLs are served by maven.minecraftforge.net now.
      vi.libraries = (vi.libraries || [])
        .filter((l) => l.clientreq !== false || l.name === profile.install.path)
        .map((l) => {
          if (l.name === profile.install.path) return { name: l.name, downloads: { artifact: { path: libRel, url: '' } } };
          const { clientreq, serverreq, checksums, ...rest } = l;
          if (rest.url) rest.url = rest.url.replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, f.maven);
          return rest;
        });
      await fsp.mkdir(layout.versionDir(id), { recursive: true });
      await fsp.writeFile(layout.versionJson(id), JSON.stringify(vi, null, 2));
      return { versionId: id, extraFiles: [libRel] };
    }

    // ---- Modern format
    const version = readJson(profile.json || '/version.json');
    if (!version) throw new Error('version.json not found in installer');
    const id = version.id;

    // Libraries: processor tools + runtime libraries
    const plan = libraryPlan([...(profile.libraries || []), ...(version.libraries || [])], layout.libraries);
    onLog(`${f.name}: библиотеки ${plan.tasks.length} файлов`);
    await downloadAll(plan.tasks, { signal, concurrency, onProgress: (p) => onProgress({ step: 'loader', ...p }) });
    for (const b of plan.bundled) {
      const e = zip.getEntry(`maven/${b.rel}`);
      if (e && !(await isFileValid(b.path, { sha1: b.sha1 }))) {
        await fsp.mkdir(path.dirname(b.path), { recursive: true });
        await fsp.writeFile(b.path, e.getData());
      }
    }

    // Data + processors
    let extracted = 0;
    const extract = (inner) => {
      const e = zip.getEntry(inner.replace(/^\//, ''));
      if (!e) throw new Error(`${inner} not found in installer`);
      const dest = path.join(tmp, 'data', `${extracted++}-${path.basename(inner)}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
      return dest;
    };
    const data = buildDataMap(profile.data, {
      minecraftJar, minecraftVersion: mcVersion, root: layout.root, installer, librariesDir: layout.libraries, extract,
    });
    const procs = processorsForSide(profile.processors, 'client');
    const sep = classpathSeparator(process.platform);
    let i = 0;
    for (const p of procs) {
      i++;
      if (signal && signal.aborted) throw new CancelledError();
      const outputs = Object.entries(p.outputs || {}).map(([k, v]) => ({
        file: substituteProcessorArg(k, data, layout.libraries),
        sha1: substituteProcessorArg(v, data, layout.libraries).replace(/^'|'$/g, ''),
      }));
      if (outputs.length) {
        let allOk = true;
        for (const o of outputs) if (!(await isFileValid(o.file, { sha1: o.sha1 }))) { allOk = false; break; }
        if (allOk) {
          onLog(`${f.name}: процессор ${i}/${procs.length} — уже выполнен`);
          continue;
        }
      }
      const jar = path.join(layout.libraries, ...mavenPath(p.jar).split('/'));
      const cp = [jar, ...(p.classpath || []).map((c) => path.join(layout.libraries, ...mavenPath(c).split('/')))];
      const mainClass = jarMainClass(jar);
      const args = (p.args || []).map((a) => substituteProcessorArg(a, data, layout.libraries));
      onProgress({ step: 'processors', doneFiles: i - 1, totalFiles: procs.length, doneBytes: 0, totalBytes: 0, current: p.jar });
      onLog(`${f.name}: процессор ${i}/${procs.length} ${p.jar} ${args.slice(0, 2).join(' ')}`);
      await runJava(javaPath, ['-cp', cp.join(sep), mainClass, ...args], { cwd: tmp, onLog, signal });
      for (const o of outputs) {
        const got = await sha1File(o.file).catch(() => null);
        if (got !== o.sha1) {
          const err = new Error(`Processor output mismatch: ${path.basename(o.file)} (${got} != ${o.sha1})`);
          err.code = 'LOADER_PROCESSOR_FAILED';
          throw err;
        }
      }
    }
    onProgress({ step: 'processors', doneFiles: procs.length, totalFiles: procs.length, doneBytes: 0, totalBytes: 0 });

    // Runtime libraries that are produced locally must exist now
    for (const b of plan.bundled) {
      if (!fs.existsSync(b.path)) throw new Error(`Missing ${f.name} library: ${b.rel}`);
    }
    await fsp.mkdir(layout.versionDir(id), { recursive: true });
    await fsp.writeFile(layout.versionJson(id), JSON.stringify(version, null, 2));

    // Files needed at runtime that are not listed in version.json (processor outputs
    // referenced from `data`, e.g. client-srg / client-extra): protect in cleanup.
    const extraFiles = new Set(plan.bundled.map((b) => b.rel));
    for (const [, sides] of Object.entries(profile.data || {})) {
      const raw = sides && typeof sides === 'object' ? sides.client : sides;
      if (typeof raw === 'string' && raw.startsWith('[') && raw.endsWith(']')) extraFiles.add(mavenPath(raw.slice(1, -1)));
    }
    // Only record files that really exist: some `data` entries are produced only
    // by server-side processors (e.g. MC_UNPACKED) and never appear on a client.
    const present = [...extraFiles].filter((rel) => fs.existsSync(path.join(layout.libraries, ...rel.split('/'))));
    return { versionId: id, extraFiles: present };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  FLAVORS,
  listVersions,
  install,
  installerUrl,
  neoforgeMcVersion,
  resolveDataValue,
  buildDataMap,
  substituteProcessorArg,
  processorsForSide,
  libraryPlan,
  jarMainClass,
};
