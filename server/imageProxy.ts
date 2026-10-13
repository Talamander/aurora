// Image proxy: the app loads remote pictures (post images, thumbnails, avatars) through
// GET /api/img, so the hosts that serve them never learn when, or whether, you looked at a post,
// and never see your IP address per view. On by default; the setting ui.imageProxy = false turns
// it off and the browser loads images directly again.
//
// Rules:
// - Only URLs that appear in the library (media url/thumb, author avatar) are fetched. The proxy
//   is not a general fetcher: an AI-written widget or a crafted URL cannot make it reach a new host.
// - Every request carries a per-install token (?t=) that only same-origin pages can read from
//   /api/img/config. Other websites cannot use the proxy, or probe which images are in your library.
// - Fetches go through safeFetchBytes: http(s) only, public addresses only (checked at connect
//   time, so DNS rebinding does not help), redirects re-checked, 8 MB cap, 15 s timeout.
// - Only raster images (JPEG, PNG, GIF, WebP, AVIF) are served, typed from their first bytes. SVG
//   and everything else is refused. Responses carry nosniff and a sandbox CSP.
// - Images are cached on disk under <data>/cache/img (keyed by a hash of the URL, 0600 files),
//   capped at 512 MB, oldest dropped first.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Item } from '../core/types.ts';
import type { Store } from './db.ts';
import { safeFetchBytes } from './safeFetch.ts';

export const IMG_SETTING = 'ui.imageProxy';
const TOKEN_SECRET = 'img.token';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_BYTES = 512 * 1024 * 1024;
const KNOWN_TTL_MS = 5_000;
const FAIL_TTL_MS = 10 * 60_000;
const MAX_PARALLEL = 8;
const PRUNE_EVERY = 300;

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

/** Every image URL the library can show: media urls and thumbs, and author avatars. */
export function mediaUrlsOf(items: Item[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    if (it.author?.avatar) out.add(it.author.avatar);
    if (it.quoted?.author?.avatar) out.add(it.quoted.author.avatar);
    for (const m of it.media ?? []) {
      if (m.thumb) out.add(m.thumb);
      if (m.type === 'image' && m.url) out.add(m.url);
    }
  }
  return out;
}

/** Content type of a raster image from its first bytes, or null. SVG is deliberately refused. */
export function sniffImageType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

export function createImageProxy(deps: { store: Store; dataDir: string; fetchBytes?: typeof safeFetchBytes }) {
  const { store } = deps;
  const fetchBytes = deps.fetchBytes ?? safeFetchBytes;
  const dir = path.join(path.resolve(deps.dataDir), 'cache', 'img');
  let known: Set<string> | null = null;
  let knownAt = 0;
  const failed = new Map<string, number>();
  const inflight = new Map<string, Promise<Buffer>>();
  let active = 0;
  const waiters: (() => void)[] = [];
  let writes = 0;

  const enabled = () => store.getSetting<boolean>(IMG_SETTING) !== false;

  function token(): string {
    let t = store.getSecret(TOKEN_SECRET);
    if (!t) {
      t = randomBytes(18).toString('base64url');
      store.setSecret(TOKEN_SECRET, t);
    }
    return t;
  }

  function tokenOk(given: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(token());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function isKnown(u: string): boolean {
    const stale = Date.now() - knownAt > KNOWN_TTL_MS;
    if (!known || (stale && !known.has(u))) {
      known = mediaUrlsOf(store.listItems());
      knownAt = Date.now();
    }
    return known.has(u);
  }

  const keyOf = (u: string) => createHash('sha256').update(u).digest('hex');
  const fileOf = (key: string) => path.join(dir, key.slice(0, 2), key);

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  }

  function prune() {
    let files: { p: string; size: number; t: number }[] = [];
    try {
      for (const sub of fs.readdirSync(dir)) {
        const d = path.join(dir, sub);
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          files.push({ p, size: st.size, t: st.atimeMs || st.mtimeMs });
        }
      }
    } catch {
      return;
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files = files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES * 0.8) break;
      try {
        fs.rmSync(f.p, { force: true });
        total -= f.size;
      } catch {
        /* already gone */
      }
    }
  }

  async function load(u: string): Promise<Buffer> {
    const key = keyOf(u);
    const file = fileOf(key);
    try {
      return await fs.promises.readFile(file);
    } catch {
      /* not cached yet */
    }
    const r = await slot(() => fetchBytes(u, { maxBytes: MAX_BYTES, timeoutMs: 15_000, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' } }));
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`upstream answered ${r.status}`), { status: 502 });
    if (!sniffImageType(r.body)) throw Object.assign(new Error('not a supported image'), { status: 415 });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (++writes % PRUNE_EVERY === 0) setImmediate(prune);
    return r.body;
  }

  /** Resolves the image for a request, or throws an error carrying an HTTP status. */
  async function get(u: string, t: string): Promise<{ body: Buffer; type: string }> {
    const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
    if (!tokenOk(t)) throw fail(403, 'Image proxy token missing or wrong');
    if (!enabled()) throw fail(404, 'The image proxy is turned off');
    if (!/^https?:\/\//i.test(u) || u.length > 4096) throw fail(400, 'Not an http(s) URL');
    if (!isKnown(u)) throw fail(404, 'Only images from your library are proxied');
    const failedAt = failed.get(u);
    if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) throw fail(502, 'This image failed recently');
    let p = inflight.get(u);
    if (!p) {
      p = load(u).finally(() => inflight.delete(u));
      inflight.set(u, p);
    }
    try {
      const body = await p;
      const type = sniffImageType(body);
      if (!type) throw fail(415, 'not a supported image');
      return { body, type };
    } catch (e) {
      if (failed.size > 5000) failed.clear();
      failed.set(u, Date.now());
      const status = (e as { status?: number }).status ?? 502;
      throw fail(status, (e as Error).message);
    }
  }

  setTimeout(prune, 30_000).unref?.();
  return { get, token, enabled, isKnown };
}

export type ImageProxy = ReturnType<typeof createImageProxy>;

export function registerImageProxyRoutes(route: RouteFn, deps: { proxy: ImageProxy; HttpError: new (status: number, message: string) => Error }) {
  const { proxy, HttpError } = deps;
  // Same-origin only in practice: other origins cannot read this JSON, so they never get the token.
  route('GET', '/api/img/config', () => ({ enabled: proxy.enabled(), token: proxy.token() }));
  route('GET', '/api/img', async (_q, res, _p, _b, url) => {
    let img: { body: Buffer; type: string };
    try {
      img = await proxy.get(url.searchParams.get('u') ?? '', url.searchParams.get('t') ?? '');
    } catch (e) {
      throw new HttpError((e as { status?: number }).status ?? 502, (e as Error).message);
    }
    res.writeHead(200, {
      'content-type': img.type,
      'content-length': String(img.body.length),
      'cache-control': 'private, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    });
    res.end(img.body);
  });
}
