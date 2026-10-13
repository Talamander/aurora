// Stage the Aurora server for packaging into desktop/build/aurora: the built web app, the
// server and core TypeScript, and production node_modules. electron-builder then copies that
// folder into the app's resources. Run from anywhere:
//   node desktop/scripts/stage.mjs            (builds the web app first)
//   node desktop/scripts/stage.mjs --no-web   (reuse an existing web/dist)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const out = path.join(desktop, 'build', 'aurora');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (!process.argv.includes('--no-web')) run(['run', 'build'], root);
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) throw new Error('web/dist is missing; run npm run build first');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const skip = (src) => /\.test\.ts$/.test(src) || src.includes(`${path.sep}node_modules`);
for (const dir of ['core', 'server']) fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true, filter: (src) => !skip(src) });
fs.cpSync(path.join(root, 'web', 'dist'), path.join(out, 'web', 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(out, f));

// Production dependencies only. Install scripts stay off: nothing the server needs runs one.
run(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], out);

// These are bundled into web/dist by Vite; the server never imports them.
for (const pkg of ['react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens', 'hls.js', '@fontsource-variable']) {
  fs.rmSync(path.join(out, 'node_modules', pkg), { recursive: true, force: true });
}
// Drop .bin links left pointing at the packages removed above; macOS signing fails on them.
const bin = path.join(out, 'node_modules', '.bin');
for (const name of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
  if (!fs.existsSync(path.join(bin, name))) fs.rmSync(path.join(bin, name), { force: true });
}
console.log(`Staged the Aurora server in ${out}`);
