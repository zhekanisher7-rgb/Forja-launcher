'use strict';
/**
 * Java runtime management: pick the required major version from the
 * version JSON, download Mojang's official runtime for the current
 * platform (Adoptium as fallback), verify and make executable.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const config = require('../config');
const { fetchJson } = require('./http');
const { downloadAll } = require('./download');

const DEFAULT_COMPONENT = 'jre-legacy';

/** Java requirement from version JSON (defaults to Java 8 / jre-legacy) */
function requiredJava(version) {
  const jv = version && version.javaVersion;
  if (jv && jv.majorVersion) {
    return { component: jv.component || null, majorVersion: jv.majorVersion };
  }
  return { component: DEFAULT_COMPONENT, majorVersion: 8 };
}

/** Mojang runtime platform key */
function mojangRuntimePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'windows-arm64';
    if (arch === 'ia32') return 'windows-x86';
    return 'windows-x64';
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (platform === 'linux') {
    if (arch === 'ia32') return 'linux-i386';
    if (arch === 'x64') return 'linux';
    return null; // e.g. linux arm64 — not provided by Mojang
  }
  return null;
}

/** Relative path to the java executable inside a runtime root */
function javaExecutableRel(platform = process.platform) {
  if (platform === 'win32') return path.join('bin', 'javaw.exe');
  if (platform === 'darwin') return path.join('jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join('bin', 'java');
}

/** Run `java -version` and return parsed major version */
function probeJava(javaPath) {
  return new Promise((resolve, reject) => {
    // prefer console java.exe for probing on Windows
    const probe = javaPath.endsWith('javaw.exe') ? javaPath.replace(/javaw\.exe$/, 'java.exe') : javaPath;
    const bin = fs.existsSync(probe) ? probe : javaPath;
    execFile(bin, ['-version'], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(err);
      const out = `${stderr}${stdout}`;
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (!m) return reject(new Error(`Cannot parse java -version: ${out}`));
      const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
      resolve({ major, output: out.trim() });
    });
  });
}

async function installMojangRuntime({ layout, component, platformKey, signal, onProgress, log }) {
  const all = await fetchJson(config.endpoints.javaRuntimeManifest, { signal });
  const list = all[platformKey] && all[platformKey][component];
  if (!list || list.length === 0) return null;
  const entry = list[0];
  const root = path.join(layout.runtime, component, platformKey);
  const marker = path.join(root, '.forja-runtime.json');
  let markerOk = false;
  try {
    const m = JSON.parse(await fsp.readFile(marker, 'utf8'));
    markerOk = m.sha1 === entry.manifest.sha1;
  } catch { /* none */ }

  const manifest = await fetchJson(entry.manifest.url, { signal });
  const files = Object.entries(manifest.files);
  const tasks = [];
  const links = [];
  for (const [rel, f] of files) {
    const abs = path.join(root, ...rel.split('/'));
    if (f.type === 'directory') {
      await fsp.mkdir(abs, { recursive: true });
    } else if (f.type === 'file') {
      const raw = f.downloads.raw;
      // When marker matches, trust sizes only (fast relaunch); otherwise full SHA1.
      tasks.push({ url: raw.url, path: abs, sha1: markerOk ? undefined : raw.sha1, size: raw.size, executable: !!f.executable });
    } else if (f.type === 'link') {
      links.push({ abs, target: f.target });
    }
  }
  log(`Java ${entry.version.name} (${component}, ${platformKey}): ${tasks.length} файлов`);
  const stats = await downloadAll(tasks, { signal, onProgress, concurrency: 16 });
  if (process.platform !== 'win32') {
    for (const l of links) {
      await fsp.mkdir(path.dirname(l.abs), { recursive: true });
      try {
        const cur = await fsp.readlink(l.abs);
        if (cur === l.target) continue;
        await fsp.rm(l.abs, { force: true });
      } catch { /* missing */ }
      await fsp.symlink(l.target, l.abs);
    }
  }
  await fsp.writeFile(marker, JSON.stringify({ sha1: entry.manifest.sha1, version: entry.version.name, component }));
  return { root, javaPath: path.join(root, javaExecutableRel()), version: entry.version.name, source: 'mojang', stats };
}

function adoptiumOsArch(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
  const a = { x64: 'x64', arm64: 'aarch64', ia32: 'x32', arm: 'arm' }[arch] || arch;
  return { os: osName, arch: a };
}

async function findJavaBinary(dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}

async function installAdoptium({ layout, majorVersion, signal, onProgress, log }) {
  const { os: aos, arch } = adoptiumOsArch();
  const url = `${config.endpoints.adoptiumApi}/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jre&os=${aos}&vendor=eclipse`;
  const assets = await fetchJson(url, { signal });
  if (!assets.length) throw new Error(`Adoptium: no JRE ${majorVersion} for ${aos}/${arch}`);
  const pkg = assets[0].binary.package;
  const root = path.join(layout.runtime, `adoptium-${majorVersion}`, `${aos}-${arch}`);
  const archive = path.join(layout.cache, pkg.name);
  log(`Adoptium JRE ${assets[0].version.semver}: ${pkg.name}`);
  await downloadAll([{ url: pkg.link, path: archive, size: pkg.size }], { signal, onProgress });
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(archive));
  if (hash.digest('hex') !== pkg.checksum) throw new Error('Adoptium archive checksum mismatch');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  if (pkg.name.endsWith('.zip')) {
    const AdmZip = require('adm-zip');
    new AdmZip(archive).extractAllTo(root, true);
  } else {
    await require('tar').x({ file: archive, cwd: root });
  }
  const javaPath = await findJavaBinary(root);
  if (!javaPath) throw new Error('java binary not found in Adoptium archive');
  if (process.platform !== 'win32') await fsp.chmod(javaPath, 0o755);
  return { root, javaPath, version: assets[0].version.semver, source: 'adoptium' };
}

/**
 * Ensure a Java runtime suitable for `version` exists.
 * @returns {Promise<{javaPath, version, source, major}>}
 */
async function ensureJava({ layout, version, signal, onProgress = () => {}, onLog = () => {} }) {
  const req = requiredJava(version);
  const platformKey = mojangRuntimePlatform();
  const progress = (p) => onProgress({ step: 'java', ...p });
  let result = null;
  if (platformKey && req.component) {
    try {
      result = await installMojangRuntime({ layout, component: req.component, platformKey, signal, onProgress: progress, log: onLog });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      onLog(`Mojang runtime недоступен: ${err.message}`);
    }
  }
  if (!result) {
    result = await installAdoptium({ layout, majorVersion: req.majorVersion, signal, onProgress: progress, log: onLog });
  }
  const probe = await probeJava(result.javaPath);
  onLog(`Java готова: ${result.javaPath} (major ${probe.major})`);
  return { ...result, major: probe.major, required: req };
}

module.exports = {
  requiredJava,
  mojangRuntimePlatform,
  javaExecutableRel,
  ensureJava,
  probeJava,
  adoptiumOsArch,
};
