// Render the desktop app and tray icons from web/public/icon.svg with a headless Chromium.
// The PNGs are committed, so this only needs to run when the logo changes:
//   CHROMIUM=/usr/bin/chromium node desktop/scripts/render-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(desktop, 'assets');
fs.mkdirSync(out, { recursive: true });
const logo = fs.readFileSync(path.join(desktop, '..', 'web', 'public', 'icon.svg'), 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');

// macOS icons keep a margin around the squircle (about 9% each side of the 1024 grid).
const padded = (pad) => `<div style="width:100%;height:100%;padding:${pad}%;box-sizing:border-box">${logo}</div>`;
// The macOS menu bar wants a black-on-transparent template image; it tints it itself.
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%"><rect x="4" y="7" width="22" height="3.6" rx="1.8"/><rect x="4" y="14.2" width="16" height="3.6" rx="1.8" opacity=".75"/><rect x="4" y="21.4" width="10" height="3.6" rx="1.8" opacity=".55"/><circle cx="23" cy="23.2" r="4.2"/></svg>`;

const jobs = [
  ...[16, 24, 32, 48, 64, 128, 256, 512].map((s) => [`${s}x${s}.png`, s, padded(0)]),
  ['1024x1024.png', 1024, padded(9)],
  ['icon.png', 1024, padded(9)],
  ['tray.png', 32, padded(3)],
  ['tray@2x.png', 64, padded(3)],
  ['trayTemplate.png', 16, template],
  ['trayTemplate@2x.png', 32, template],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
const page = await browser.newPage();
for (const [name, size, html] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent;width:${size}px;height:${size}px">${html}</body>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: true });
}
await browser.close();
console.log(`Wrote ${jobs.length} icons to ${out}`);
