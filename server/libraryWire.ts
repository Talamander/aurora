// How the library goes over the wire, built for 100k posts.
//
// The item list is cut into chunks: one per calendar week of publish dates (newest first), with
// very busy weeks split further. Each chunk is serialized once and named by a hash of its bytes.
// The web app asks for a small manifest (everything but the items, plus the chunk names) and
// fetches only the chunks it does not already hold; a chunk fetched by hash never changes, so the
// browser may cache it for good. Marking one post read re-sends one week, not the whole library.
//
// The classic GET /api/library (phone app, terminal client, desktop shell) is assembled from the
// same chunk bytes, so it is byte-for-byte what JSON.stringify(library) used to produce, and its
// compressed body is kept per ETag so revalidations and repeat fetches cost nothing.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from 'node:zlib';
import type { Item, Library } from '../core/types.ts';

export type Encoding = 'br' | 'gzip' | null;

export interface Chunk {
  key: string;
  n: number;
  hash: string;
  items: Item[];
  /** The chunk's items as a JSON array. */
  buf: Buffer;
  /** Compressed copies of buf, made on first request. */
  zipped: Partial<Record<'br' | 'gzip', Buffer>>;
}

const WEEK = 7 * 86_400_000;
export const MAX_CHUNK = 4000;

export function compressBody(buf: Buffer, enc: 'br' | 'gzip', quality = 4): Buffer {
  return enc === 'br'
    ? brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipSync(buf, { level: quality >= 9 ? 9 : 6 });
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
export function compressBodyAsync(buf: Buffer, enc: 'br' | 'gzip', quality = 4): Promise<Buffer> {
  return enc === 'br'
    ? brotliAsync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipAsync(buf, { level: quality >= 9 ? 9 : 6 });
}

const sameItems = (a: Item[], b: Item[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Groups a newest-first item list by publish week, splitting weeks at MAX_CHUNK posts. */
function groupItems(items: Item[]): { key: string; items: Item[] }[] {
  const groups: { key: string; items: Item[] }[] = [];
  const parts = new Map<string, number>();
  let cur: { key: string; items: Item[] } | null = null;
  let curWeek = '';
  for (const it of items) {
    const t = Date.parse(it.publishedAt);
    const week = Number.isFinite(t) ? String(Math.floor(t / WEEK)) : 'x';
    if (!cur || week !== curWeek || cur.items.length >= MAX_CHUNK) {
      curWeek = week;
      const part = parts.get(week) ?? 0;
      parts.set(week, part + 1);
      cur = { key: part ? `${week}-${part}` : week, items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  }
  return groups;
}

function buildChunk(g: { key: string; items: Item[] }, prev?: Map<string, Chunk>): Chunk {
  const p = prev?.get(g.key);
  if (p && sameItems(p.items, g.items)) return p;
  const buf = Buffer.from(JSON.stringify(g.items));
  const hash = createHash('sha1').update(buf).digest('base64url').slice(0, 20);
  // Same bytes as before (a sync that rewrote posts unchanged): keep the old chunk's caches.
  if (p && p.hash === hash) return { ...p, items: g.items };
  return { key: g.key, n: g.items.length, hash, items: g.items, buf, zipped: {} };
}

/** Cuts a newest-first item list into week chunks, reusing unchanged chunks from `prev`. */
export function chunkItems(items: Item[], prev?: Map<string, Chunk>): Chunk[] {
  return groupItems(items).map((g) => buildChunk(g, prev));
}

/** chunkItems with a turn of the event loop every `sliceMs`, for the first pass over 100k posts. */
export async function chunkItemsAsync(items: Item[], prev?: Map<string, Chunk>, sliceMs = 12): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let end = performance.now() + sliceMs;
  for (const g of groupItems(items)) {
    out.push(buildChunk(g, prev));
    if (performance.now() > end) {
      await new Promise((r) => setImmediate(r));
      end = performance.now() + sliceMs;
    }
  }
  return out;
}

type Rest = Omit<Library, 'items'>;

export function createLibraryWire(deps: { version: () => string; items: () => Item[]; rest: () => Rest }) {
  let state: { version: string; chunks: Chunk[]; byKey: Map<string, Chunk>; total: number } | null = null;
  const full: Partial<Record<'br' | 'gzip' | 'identity', { etag: string; buf: Buffer }>> = {};

  function current() {
    const version = deps.version();
    if (state?.version !== version) {
      const items = deps.items();
      const chunks = chunkItems(items, state?.byKey);
      state = { version, chunks, byKey: new Map(chunks.map((c) => [c.key, c])), total: items.length };
    }
    return state;
  }

  let preparing: Promise<void> | null = null;
  /**
   * Brings the chunks up to date without blocking: serializing 100k posts takes a few hundred ms,
   * done here in slices. Once it resolves, the sync methods below answer from the cache (unless
   * the library changed again in between; then they catch up synchronously as before).
   */
  function prepare(): Promise<void> {
    if (state?.version === deps.version()) return Promise.resolve();
    preparing ??= (async () => {
      const version = deps.version();
      const items = deps.items();
      const chunks = await chunkItemsAsync(items, state?.byKey);
      if (deps.version() === version) state = { version, chunks, byKey: new Map(chunks.map((c) => [c.key, c])), total: items.length };
    })().finally(() => (preparing = null));
    return preparing;
  }

  /** The rest of the library, serialized without its opening brace: `"sources":[...],...}`. */
  const restTail = (rest: Rest) => {
    const s = JSON.stringify(rest);
    return s === '{}' ? '}' : s.slice(1);
  };

  return {
    prepare,

    /** The whole library, exactly as JSON.stringify(library) would write it. */
    full(enc: Encoding): { etag: string; body: () => Buffer; bodyAsync: () => Promise<Buffer> } {
      const st = current();
      const tail = restTail(deps.rest());
      const etag = `"${createHash('sha1').update(st.chunks.map((c) => c.hash).join('.')).update(tail).digest('base64url')}"`;
      const slot = enc ?? 'identity';
      const raw = () => {
        const pieces: Buffer[] = [Buffer.from('{"items":[')];
        st.chunks.forEach((c, i) => {
          if (i) pieces.push(Buffer.from(','));
          pieces.push(c.buf.subarray(1, -1));
        });
        pieces.push(Buffer.from(']' + (tail === '}' ? '}' : ',' + tail)));
        return Buffer.concat(pieces);
      };
      return {
        etag,
        body: () => {
          const hit = full[slot];
          if (hit?.etag === etag) return hit.buf;
          const buf = enc ? compressBody(raw(), enc) : raw();
          full[slot] = { etag, buf };
          return buf;
        },
        /** The same bytes, compressed on libuv's thread pool: 100k posts take about 0.5 s to compress. */
        bodyAsync: async () => {
          const hit = full[slot];
          if (hit?.etag === etag) return hit.buf;
          const buf = enc ? await compressBodyAsync(raw(), enc) : raw();
          full[slot] = { etag, buf };
          return buf;
        },
      };
    },

    /** Everything but the items, plus the chunk list the web app syncs from. */
    manifest(): Library & { itemChunks: { key: string; n: number; hash: string }[]; itemsTotal: number } {
      const st = current();
      return { items: [], ...deps.rest(), itemChunks: st.chunks.map(({ key, n, hash }) => ({ key, n, hash })), itemsTotal: st.total };
    },

    /** One chunk's bytes, or null when the key is no longer in the library. */
    chunk(key: string, enc: Encoding): { hash: string; body: Buffer } | null {
      const c = current().byKey.get(key);
      if (!c) return null;
      if (!enc) return { hash: c.hash, body: c.buf };
      return { hash: c.hash, body: (c.zipped[enc] ??= compressBody(c.buf, enc)) };
    },
  };
}
