// Download the official Node.js runtime the packaged app runs its server with, check it
// against nodejs.org's published SHA-256 sums, and unpack it to desktop/build/node.
//   node desktop/scripts/fetch-node.mjs [--platform linux|darwin|win32] [--arch x64|arm64]
// The server is TypeScript run by Node's type stripping, and its connector sandbox starts
// sub-processes with process.execPath, so a real Node binary ships beside Electron.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.AURORA_NODE_VERSION || 'v26.8.1';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(desktop, 'build', 'node');

const plat = { linux: 'linux', darwin: 'darwin', win32: 'win' }[platform];
if (!plat || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported target ${platform}/${arch}`);
const base = `node-${NODE_VERSION}-${plat}-${arch}`;
const file = platform === 'win32' ? `${base}.zip` : `${base}.tar.xz`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/`;

async function download(name) {
  const res = await fetch(url + name);
  if (!res.ok) throw new Error(`${url + name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sums = (await download('SHASUMS256.txt')).toString('utf8');
const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === file)?.[0];
if (!expected) throw new Error(`No checksum for ${file}`);
const archive = await download(file);
const actual = crypto.createHash('sha256').update(archive).digest('hex');
if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: ${actual} != ${expected}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-node-'));
const archivePath = path.join(tmp, file);
fs.writeFileSync(archivePath, archive);
const unpack = path.join(tmp, 'unpack');
fs.mkdirSync(unpack);
// bsdtar (Windows 10+, macOS) and GNU tar both read these archives.
execFileSync('tar', ['-xf', archivePath, '-C', unpack], { stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const src = path.join(unpack, base);
// Keep the runtime and its licence; npm, corepack and headers are not needed.
if (platform === 'win32') fs.copyFileSync(path.join(src, 'node.exe'), path.join(out, 'node.exe'));
else {
  fs.mkdirSync(path.join(out, 'bin'));
  fs.copyFileSync(path.join(src, 'bin', 'node'), path.join(out, 'bin', 'node'));
  fs.chmodSync(path.join(out, 'bin', 'node'), 0o755);
}
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Node ${NODE_VERSION} for ${platform}/${arch} (sha256 ${actual.slice(0, 12)}…) is in ${out}`);
