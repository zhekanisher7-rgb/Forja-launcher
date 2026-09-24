'use strict';
/**
 * Render src/assets/icon.svg to PNGs (via Electron's offscreen renderer)
 * and pack them into build/icon.ico and build/icon.icns.
 *   npx electron scripts/render-icon.js
 * No external tools (ImageMagick/iconutil) needed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function renderMaster(size = 1024) {
  const win = new BrowserWindow({
    width: size, height: size, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img;
}

/** ICO container with embedded PNG images (Vista+). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

/** ICNS container with PNG entries. */
function buildIcns(bySize) {
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = [];
  for (const [size, type] of Object.entries(types)) {
    const png = bySize[size];
    if (!png) continue;
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    chunks.push(h, png);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const master = await renderMaster(1024);
  const bySize = {};
  for (const s of SIZES) {
    bySize[s] = s === 1024 ? master.toPNG() : master.resize({ width: s, height: s, quality: 'best' }).toPNG();
  }
  const out = (f, b) => { fs.writeFileSync(path.join(ROOT, f), b); console.log(`${f} ${b.length} bytes`); };
  out('build/icon.png', bySize[512]);
  out('build/icon-256.png', bySize[256]);
  out('build/icon-512.png', bySize[512]);
  out('build/icon-1024.png', bySize[1024]);
  out('src/assets/icon.png', bySize[256]);
  out('build/icon.ico', buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: bySize[size] }))));
  out('build/icon.icns', buildIcns(bySize));
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
