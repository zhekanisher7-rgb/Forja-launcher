'use strict';
/**
 * Build the Java command line (classpath, JVM args, game args) from both
 * the modern `arguments` format and legacy `minecraftArguments`, then spawn.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const config = require('../config');
const { isAllowed } = require('./rules');
const { currentContext, classpathSeparator } = require('./platform');
const { Log4jXmlParser } = require('./log4j');

/** Replace ${name} placeholders; unknown placeholders are left untouched. */
function substitute(str, vars) {
  return String(str).replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : m));
}

/**
 * Flatten a modern argument list (strings and {rules, value}) applying rules.
 */
function evaluateArguments(list, ctx) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && isAllowed(item.rules, ctx)) {
      const v = item.value;
      if (Array.isArray(v)) out.push(...v);
      else if (v != null) out.push(v);
    }
  }
  return out;
}

/** JVM args used by vanilla for versions without `arguments.jvm` */
function legacyJvmArgs(ctx) {
  const args = [];
  if (ctx.osName === 'osx') args.push('-XstartOnFirstThread');
  if (ctx.osName === 'windows') {
    args.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
  }
  if (ctx.osArch === 'x86') args.push('-Xss1M');
  args.push('-Djava.library.path=${natives_directory}');
  args.push('-Dminecraft.launcher.brand=${launcher_name}');
  args.push('-Dminecraft.launcher.version=${launcher_version}');
  args.push('-cp', '${classpath}');
  return args;
}

/**
 * Pure function: build the full command.
 * @param {object} o
 * @param {object} o.version merged version JSON
 * @param {string[]} o.classpath absolute paths
 * @param {object} o.session { username, uuid, accessToken, userType, xuid?, clientId? }
 * @returns {{ command: string, args: string[], cwd: string, vars: object }}
 */
function buildLaunchCommand({
  version,
  classpath,
  javaPath,
  session,
  gameDir,
  assetsRoot,
  assetsIndexName,
  virtualAssetsDir,
  nativesDir,
  librariesDir,
  loggingConfig,
  memory = { min: 512, max: 2048 },
  resolution = null,
  extraJvmArgs = [],
  extraGameArgs = [],
  ctx = currentContext(),
}) {
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(resolution && resolution.width && resolution.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
    ...(ctx.features || {}),
  };
  const fctx = { ...ctx, features };
  const sep = classpathSeparator(ctx.platform);

  const vars = {
    auth_player_name: session.username,
    auth_session: session.accessToken, // very old versions (--session)
    version_name: version.id,
    game_directory: gameDir,
    assets_root: assetsRoot,
    game_assets: virtualAssetsDir || assetsRoot,
    assets_index_name: assetsIndexName || version.assets,
    auth_uuid: session.uuid,
    auth_access_token: session.accessToken,
    auth_xuid: session.xuid || '0',
    clientid: session.clientId || '0',
    user_type: session.userType,
    user_properties: '{}',
    version_type: version.type,
    natives_directory: nativesDir,
    launcher_name: config.id,
    launcher_version: config.version,
    classpath: classpath.join(sep),
    classpath_separator: sep,
    library_directory: librariesDir,
    resolution_width: resolution && resolution.width,
    resolution_height: resolution && resolution.height,
  };

  // Legacy base (minecraftArguments) may be combined with a modern loader child
  // that adds `arguments` (e.g. Fabric on 1.12.2): legacy args first, then extras.
  const legacyBase = Boolean(version.minecraftArguments) || !(version.arguments && version.arguments.jvm);
  const extraJvm = version.arguments && version.arguments.jvm ? evaluateArguments(version.arguments.jvm, fctx) : [];
  const jvmTemplate = legacyBase ? [...legacyJvmArgs(fctx), ...(version.minecraftArguments ? extraJvm : [])] : extraJvm;

  let gameTemplate;
  if (version.minecraftArguments) {
    gameTemplate = String(version.minecraftArguments).split(/\s+/).filter(Boolean);
    if (version.arguments && version.arguments.game) gameTemplate.push(...evaluateArguments(version.arguments.game, fctx));
    if (features.has_custom_resolution) {
      gameTemplate.push('--width', '${resolution_width}', '--height', '${resolution_height}');
    }
  } else {
    gameTemplate = evaluateArguments((version.arguments && version.arguments.game) || [], fctx);
  }

  const args = [];
  args.push(`-Xms${memory.min}M`, `-Xmx${memory.max}M`);
  args.push(...extraJvmArgs);
  if (loggingConfig && loggingConfig.argument) {
    args.push(substitute(loggingConfig.argument, { path: loggingConfig.path }));
  }
  args.push(...jvmTemplate.map((a) => substitute(a, vars)));
  args.push(version.mainClass);
  args.push(...gameTemplate.map((a) => substitute(a, vars)));
  args.push(...extraGameArgs);

  return { command: javaPath, args, cwd: gameDir, vars };
}

/**
 * Split a user-provided argument string respecting "double" and 'single'
 * quotes, e.g. `-Dfoo="a b" -Xss2M` → ['-Dfoo=a b', '-Xss2M'].
 */
function parseArgString(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Hide the access token in logged command lines */
function redactArgs(args, token) {
  return args.map((a) => (token && token.length > 4 && a.includes(token) ? a.split(token).join('***') : a));
}

/**
 * Spawn the game. Streams stdout/stderr as lines via onLog(line, stream).
 * @returns {{ child, exited: Promise<{code, signal}> }}
 */
function launchGame(cmd, { onLog = () => {}, env = process.env, xmlLogs = false, detached = false } = {}) {
  fs.mkdirSync(cmd.cwd, { recursive: true });
  const child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env,
    windowsHide: true,
    detached, // lets the game outlive the launcher ("close on game start")
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wire = (stream, name) => {
    const parser = new Log4jXmlParser((line) => onLog(line, name), { enabled: xmlLogs });
    stream.setEncoding('utf8');
    stream.on('error', () => {}); // EPIPE after launcher detaches
    stream.on('data', (d) => parser.feed(d));
    stream.on('end', () => parser.flush());
  };
  wire(child.stdout, 'stdout');
  wire(child.stderr, 'stderr');
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

module.exports = {
  substitute,
  evaluateArguments,
  legacyJvmArgs,
  buildLaunchCommand,
  launchGame,
  redactArgs,
  parseArgString,
};
