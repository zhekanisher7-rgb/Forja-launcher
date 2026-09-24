'use strict';
/**
 * electron-builder configuration (loaded by electron-builder.config.js).
 * Kept as a function of the environment so it can be unit-tested and so that
 * signing / notarization / the update repo are opt-in through env vars only:
 *
 *   FORJA_UPDATE_REPO=owner/repo      override package.json "forja.updates"
 *   CSC_LINK + CSC_KEY_PASSWORD        macOS Developer ID certificate (.p12, base64 or path)
 *   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID   macOS notarization
 *   WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD                     Windows code signing
 *
 * Without any of them the builds are unsigned but fully working
 * (macOS gets an ad-hoc signature in scripts/after-pack.js).
 */
const pkg = require('../package.json');

const PRODUCT = 'Forja Launcher';
const FILE_BASE = 'Forja-Launcher'; // no spaces: GitHub renames them and breaks latest*.yml
const PLACEHOLDERS = new Set(['', 'owner', 'your-name', 'your-github-user', 'change-me']);

function updateRepo(env = process.env) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(env.FORJA_UPDATE_REPO || '').trim());
  if (m) return { owner: m[1], repo: m[2] };
  const u = (pkg.forja && pkg.forja.updates) || {};
  return { owner: u.owner || '', repo: u.repo || '' };
}

function repoConfigured({ owner, repo }) {
  return Boolean(owner && repo && !PLACEHOLDERS.has(owner.toLowerCase()));
}

// Runtime libraries for the .deb: Electron 31 itself + what Minecraft/LWJGL need.
// "a | b" alternatives cover the Ubuntu 24.04+ / Debian 13 "t64" renames.
const DEB_DEPENDS = [
  'libgtk-3-0 | libgtk-3-0t64',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0 | libatspi2.0-0t64',
  'libuuid1',
  'libsecret-1-0',
  'libgbm1',
  'libdrm2',
  'libxkbcommon0',
  'libasound2 | libasound2t64',
  'libegl1', // needed by the game's GLFW/LWJGL3 and by Electron's GPU process
  'libgl1', // OpenGL for the game
  'ca-certificates',
];
const DEB_RECOMMENDS = [
  'libopenal1', // system OpenAL (LWJGL ships its own, used as fallback)
  'x11-xserver-utils', // xrandr — required by LWJGL 2 (Minecraft ≤ 1.12.2)
  'libpulse0',
];

function buildConfig(env = process.env) {
  const repo = updateRepo(env);
  const publishable = repoConfigured(repo);
  const macSign = Boolean(env.CSC_LINK || env.CSC_NAME);
  const notarize = macSign && Boolean(env.APPLE_TEAM_ID && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD);

  return {
    appId: 'io.github.forja.launcher',
    productName: PRODUCT,
    copyright: `© ${new Date().getFullYear()} Forja Launcher contributors`,
    artifactName: `${FILE_BASE}-\${version}-\${os}-\${arch}.\${ext}`,
    directories: { output: 'dist', buildResources: 'build' },
    files: ['src/**/*', 'package.json', '!**/*.map', '!src/**/*.md'],
    asar: true,
    // Bake the (possibly overridden) update repo into the packaged package.json;
    // src/main/config.js reads it at runtime.
    extraMetadata: { forja: { updates: repo } },
    publish: publishable ? [{ provider: 'github', owner: repo.owner, repo: repo.repo, releaseType: 'release' }] : null,
    afterPack: './scripts/after-pack.js',

    // ---------------- Windows
    win: {
      icon: 'build/icon.ico',
      target: [
        { target: 'nsis', arch: ['x64'] },
        { target: 'zip', arch: ['x64', 'arm64'] },
      ],
    },
    nsis: {
      oneClick: false,
      perMachine: false, // per-user install, no admin rights needed
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT,
      installerIcon: 'build/icon.ico',
      uninstallerIcon: 'build/icon.ico',
      installerLanguages: ['ru_RU', 'en_US'],
      multiLanguageInstaller: true,
      language: '1049', // Russian by default
      deleteAppDataOnUninstall: false, // never delete worlds/instances
      artifactName: `${FILE_BASE}-\${version}-win-\${arch}-setup.\${ext}`,
    },

    // ---------------- macOS
    mac: {
      icon: 'build/icon.icns',
      category: 'public.app-category.games',
      target: [
        { target: 'dmg', arch: ['x64', 'arm64'] },
        { target: 'zip', arch: ['x64', 'arm64'] },
      ],
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      darkModeSupport: true,
      // No certificate → skip electron-builder signing (after-pack.js ad-hoc signs instead)
      ...(macSign ? {} : { identity: null }),
      notarize: notarize ? { teamId: env.APPLE_TEAM_ID } : false,
    },
    dmg: {
      artifactName: `${FILE_BASE}-\${version}-mac-\${arch}.\${ext}`,
    },

    // ---------------- Linux
    linux: {
      icon: 'build/icons', // 16…1024 px, file names = sizes (hicolor theme)
      category: 'Game',
      executableName: 'forja-launcher',
      synopsis: 'Minecraft: Java Edition launcher',
      description: 'Minecraft: Java Edition launcher with profiles, Fabric/Quilt/Forge/NeoForge and Modrinth mods.',
      maintainer: 'Forja Launcher contributors <noreply@github.com>',
      vendor: 'Forja Launcher contributors',
      target: [
        { target: 'AppImage', arch: ['x64'] },
        { target: 'deb', arch: ['x64'] },
        { target: 'tar.gz', arch: ['x64'] },
      ],
      desktop: {
        Name: PRODUCT,
        Comment: 'Minecraft: Java Edition launcher',
        'Comment[ru]': 'Лаунчер Minecraft: Java Edition',
        Keywords: 'minecraft;launcher;game;',
        StartupWMClass: PRODUCT,
      },
    },
    deb: {
      depends: DEB_DEPENDS,
      recommends: DEB_RECOMMENDS,
      packageCategory: 'games',
      priority: 'optional',
    },
    appImage: {
      artifactName: `${FILE_BASE}-\${version}-linux-\${arch}.\${ext}`,
    },
  };
}

module.exports = { buildConfig, updateRepo, repoConfigured, DEB_DEPENDS, DEB_RECOMMENDS, FILE_BASE };
