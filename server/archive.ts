// Local media archive for saved posts, so a saved post keeps its pictures and video even if the
// original is deleted. Off by default (setting `archive.saved`).
//
// - Images are downloaded with safeFetchBytes (http(s) only, public addresses only, size caps)
//   and kept only when their bytes are a known raster image format (no SVG, no HTML).
// - Videos are downloaded with yt-dlp, spawned with an argument array (no shell), with
//   --ignore-config, a time limit and a size cap. All of its traffic goes through a small
//   loopback CONNECT proxy that only reaches public addresses on ports 80 and 443, so a post
//   cannot point yt-dlp at the local network.
// - Files land in <data>/archive/<dir>/ where <dir> is derived from the item id. A manifest.json
//   records what was archived and from where. Nothing here ever deletes archived files.
// - Files are served from GET /api/archive/:itemId/:file with a fixed content type, nosniff and
//   a sandbox CSP; names are checked against the manifest, so no path traversal is possible.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { join, resolve, sep } from 'node:path';
import { safeHttpUrl } from '../core/normalize.ts';
import type { Item } from '../core/types.ts';
import type { Store } from './db.ts';
import { isPrivateAddress, safeFetchBytes } from './safeFetch.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

export interface ArchiveDeps {
  store: Store;
  dataDir: string;
  /** Path to yt-dlp. Defaults to YT_DLP env, then /usr/bin/yt-dlp. */
  ytDlp?: string;
  /** Called after an item's archive changes (for example libraryChanged). */
  onChange?: (itemId: string) => void;
}

export type ArchiveState = 'none' | 'queued' | 'running' | 'done' | 'partial' | 'error';

export interface ArchivedFile {
  name: string;
  kind: 'image' | 'video';
  bytes: number;
  contentType: string;
  /** Where it came from (the media URL, or the post URL for yt-dlp downloads). */
  from: string;
}

export interface ArchiveManifest {
  itemId: string;
  url: string;
  state: ArchiveState;
  startedAt: string | null;
  finishedAt: string | null;
  files: ArchivedFile[];
  errors: string[];
}

export const ARCHIVE_SETTING = 'archive.saved';
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 20;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const VIDEO_TIME_LIMIT_MS = 10 * 60_000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg',
};

/** Folder name for an item id: readable, filesystem safe, collision resistant. */
export function archiveDirName(itemId: string): string {
  const slug = itemId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60) || 'item';
  return `${slug}-${createHash('sha256').update(itemId).digest('hex').slice(0, 12)}`;
}

/** Detect a raster image from its first bytes. SVG and anything else are refused. */
function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1'))) return 'avif';
  return null;
}

// ---------------------------------------------------------------- SSRF-safe egress for yt-dlp

/** A loopback CONNECT proxy that only tunnels to public addresses on 80/443. One per yt-dlp run. */
async function startPublicOnlyProxy(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    // Plain-HTTP absolute-form requests are not supported; yt-dlp uses CONNECT for https.
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Only https (CONNECT) is allowed through the archive proxy\n');
  });
  server.on('connect', (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? '');
    const deny = (why: string) => client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
    if (!m) return deny('bad target');
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    if (port !== 443 && port !== 80) return deny('port not allowed');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return deny('local host');
    const connect = (address: string, family: number) => {
      const upstream = net.connect({ host: address, port, family });
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.on('close', () => upstream.destroy());
    };
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) return deny('private address');
      return connect(host, net.isIP(host));
    }
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err || !addrs.length) return deny('dns failed');
      if (addrs.some((a) => isPrivateAddress(a.address))) return deny('private address');
      const pick = addrs.find((a) => a.family === 4) ?? addrs[0];
      connect(pick.address, pick.family);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

function dirSize(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    try {
      n += statSync(join(dir, f)).size;
    } catch {
      /* gone */
    }
  }
  return n;
}

// ---------------------------------------------------------------- archiver

export function createArchiver(deps: ArchiveDeps) {
  const root = resolve(deps.dataDir, 'archive');
  const ytDlp = deps.ytDlp ?? process.env.YT_DLP ?? '/usr/bin/yt-dlp';
  const queue: string[] = [];
  const live = new Map<string, ArchiveState>(); // queued / running, in memory
  let busy = false;

  const dirOf = (itemId: string) => join(root, archiveDirName(itemId));
  const manifestPath = (itemId: string) => join(dirOf(itemId), 'manifest.json');

  function readManifest(itemId: string): ArchiveManifest | null {
    try {
      return JSON.parse(readFileSync(manifestPath(itemId), 'utf8')) as ArchiveManifest;
    } catch {
      return null;
    }
  }
  function writeManifest(m: ArchiveManifest) {
    const p = manifestPath(m.itemId);
    writeFileSync(p + '.tmp', JSON.stringify(m, null, 1), { mode: 0o600 });
    renameSync(p + '.tmp', p);
  }

  function enabled(): boolean {
    return deps.store.getSetting<boolean>(ARCHIVE_SETTING) === true;
  }

  function status(itemId: string): ArchiveManifest & { inProgress: boolean } {
    const m = readManifest(itemId);
    const st = live.get(itemId);
    const base: ArchiveManifest = m ?? { itemId, url: '', state: 'none', startedAt: null, finishedAt: null, files: [], errors: [] };
    return { ...base, state: st ?? base.state, inProgress: Boolean(st) };
  }

  async function archiveImages(item: Item, dir: string, m: ArchiveManifest) {
    const urls: string[] = [];
    for (const media of item.media) {
      const u = safeHttpUrl(media.type === 'image' ? media.url : media.thumb);
      if (u && !urls.includes(u)) urls.push(u);
    }
    let n = m.files.filter((f) => f.kind === 'image').length;
    for (const u of urls.slice(0, MAX_IMAGES)) {
      if (m.files.some((f) => f.from === u)) continue; // already archived on an earlier run
      try {
        const r = await safeFetchBytes(u, { maxBytes: IMAGE_MAX_BYTES, timeoutMs: 30_000, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' } });
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        const ext = sniffImage(r.body);
        if (!ext) throw new Error('not a supported image format');
        const name = `image-${++n}.${ext}`;
        writeFileSync(join(dir, name), r.body, { mode: 0o600 });
        m.files.push({ name, kind: 'image', bytes: r.body.length, contentType: CONTENT_TYPES[ext], from: u });
      } catch (e) {
        m.errors.push(`Image ${u.slice(0, 120)}: ${(e as Error).message}`);
      }
    }
  }

  function wantsVideo(item: Item): boolean {
    return item.kind === 'video' || item.media.some((x) => x.type === 'video');
  }

  async function archiveVideo(item: Item, dir: string, m: ArchiveManifest) {
    if (m.files.some((f) => f.kind === 'video')) return;
    const target = safeHttpUrl(item.url) ?? safeHttpUrl(item.media.find((x) => x.type === 'video')?.url);
    if (!target) return;
    if (!existsSync(ytDlp)) {
      m.errors.push('yt-dlp is not installed, so videos are not archived.');
      return;
    }
    const proxy = await startPublicOnlyProxy();
    const args = [
      '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-exec',
      '--no-playlist', '--playlist-items', '1', '--max-downloads', '1',
      '--proxy', proxy.url,
      '--downloader', 'native',
      '--max-filesize', String(VIDEO_MAX_BYTES),
      '--socket-timeout', '30',
      '--retries', '2',
      '-f', 'bv*[height<=720][filesize<?450M]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '--restrict-filenames', '--no-mtime', '--no-progress', '--quiet', '--no-warnings',
      '-o', join(dir, 'video.%(ext)s'),
      '--', target,
    ];
    const err = await new Promise<string | null>((done) => {
      let stderr = '';
      const child = spawn(ytDlp, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' } });
      const kill = (why: string) => {
        stderr += `\n${why}`;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill(`Stopped after ${VIDEO_TIME_LIMIT_MS / 60_000} minutes`), VIDEO_TIME_LIMIT_MS);
      const sizeWatch = setInterval(() => {
        if (dirSize(dir) > VIDEO_MAX_BYTES + IMAGE_MAX_BYTES * MAX_IMAGES) kill('Stopped: over the size limit');
      }, 2000);
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 4000) stderr += d.toString('utf8');
      });
      child.on('error', (e) => done(`Could not start yt-dlp: ${e.message}`));
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(sizeWatch);
        // yt-dlp exits 101 when --max-downloads is reached, which is success here.
        done(code === 0 || code === 101 ? null : (stderr.trim().split('\n').filter(Boolean).pop() ?? `yt-dlp exited with ${code}`).slice(0, 300));
      });
    });
    proxy.close();
    // Finished downloads only: video.<ext>. Partial (.part) and per-format (video.f137.mp4) files are skipped.
    const added = readdirSync(dir).filter((f) => /^video\.[a-z0-9]+$/.test(f) && !m.files.some((x) => x.name === f));
    for (const name of added) {
      const ext = name.split('.').pop()!;
      const contentType = CONTENT_TYPES[ext];
      if (!contentType) continue; // leftovers in odd formats stay on disk but are not served
      try {
        chmodSync(join(dir, name), 0o600);
      } catch {
        /* best effort */
      }
      m.files.push({ name, kind: 'video', bytes: statSync(join(dir, name)).size, contentType, from: target });
    }
    if (err && !added.length) m.errors.push(`Video: ${err}`);
  }

  async function run(itemId: string) {
    const item = deps.store.getItem(itemId);
    if (!item) return;
    const dir = dirOf(itemId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prev = readManifest(itemId);
    const m: ArchiveManifest = { itemId, url: item.url, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, files: prev?.files ?? [], errors: [] };
    writeManifest(m);
    try {
      await archiveImages(item, dir, m);
      if (wantsVideo(item)) await archiveVideo(item, dir, m);
    } catch (e) {
      m.errors.push((e as Error).message);
    }
    m.state = m.errors.length ? (m.files.length ? 'partial' : 'error') : 'done';
    m.finishedAt = new Date().toISOString();
    writeManifest(m);
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const id = queue.shift()!;
        live.set(id, 'running');
        try {
          await run(id);
        } catch (e) {
          console.warn('[archive] failed for an item:', (e as Error).message);
        } finally {
          live.delete(id);
          deps.onChange?.(id);
        }
      }
    } finally {
      busy = false;
    }
  }

  /** Queue one item for archiving now, whatever the setting says. Returns its current status. */
  function archiveItem(itemId: string): ArchiveManifest & { inProgress: boolean } {
    if (!deps.store.getItem(itemId)) throw new Error('No such item');
    if (!live.has(itemId)) {
      live.set(itemId, 'queued');
      queue.push(itemId);
      void pump();
    }
    return status(itemId);
  }

  /** Call after items become saved. Queues those not yet archived, only when archive.saved is on. */
  function onSaved(itemIds: string[]) {
    if (!enabled()) return;
    for (const id of itemIds) {
      const st = status(id);
      if (st.inProgress || st.state === 'done') continue;
      try {
        archiveItem(id);
      } catch {
        /* item vanished */
      }
    }
  }

  /** Resolve a served file. Only names listed in the manifest are served. */
  function fileFor(itemId: string, name: string): { path: string; contentType: string } | null {
    if (!FILE_NAME.test(name) || name === 'manifest.json') return null;
    const m = readManifest(itemId);
    const f = m?.files.find((x) => x.name === name);
    if (!f) return null;
    const dir = dirOf(itemId);
    const path = resolve(dir, name);
    if (!path.startsWith(dir + sep)) return null;
    return { path, contentType: f.contentType };
  }

  return { archiveItem, status, onSaved, enabled, fileFor, root };
}

export type Archiver = ReturnType<typeof createArchiver>;

// ---------------------------------------------------------------- routes

export function registerArchiveRoutes(route: RouteFn, deps: { store: Store; archiver: Archiver; HttpError: new (status: number, message: string) => Error }) {
  const { store, archiver, HttpError } = deps;
  // Settings first, so "settings" is never read as an item id.
  route('GET', '/api/archive/settings', () => ({ saved: archiver.enabled(), ytDlp: existsSync(process.env.YT_DLP ?? '/usr/bin/yt-dlp') }));
  route('PUT', '/api/archive/settings', (_q, _s, _p, body) => {
    if (typeof body?.saved !== 'boolean') throw new HttpError(400, 'Send { "saved": true } or { "saved": false }');
    store.setSetting(ARCHIVE_SETTING, body.saved);
    return { saved: body.saved };
  });
  route('GET', '/api/archive/:itemId', (_q, _s, p) => {
    const st = archiver.status(p.itemId);
    return { ...st, files: st.files.map((f) => ({ ...f, url: `/api/archive/${encodeURIComponent(p.itemId)}/${encodeURIComponent(f.name)}` })) };
  });
  route('POST', '/api/archive/:itemId', (_q, _s, p) => {
    try {
      return archiver.archiveItem(p.itemId);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });
  route('GET', '/api/archive/:itemId/:file', async (req, res, p) => {
    const f = archiver.fileFor(p.itemId, p.file);
    if (!f) throw new HttpError(404, 'No such archived file');
    let size: number;
    try {
      size = (await stat(f.path)).size;
    } catch {
      throw new HttpError(404, 'No such archived file');
    }
    const headers: Record<string, string> = {
      'content-type': f.contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    };
    // Single byte ranges, so <video> can seek.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else start = Math.max(0, size - Number(range[2]));
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
    } else res.writeHead(200, { ...headers, 'content-length': String(size) });
    await pipeline(createReadStream(f.path, { start, end }), res);
  });
}
