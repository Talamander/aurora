// Keeps the phone's copy of the library in sync without re-downloading it, and on disk so the
// app opens at once and still reads with no connection.
//
// Same wire format as the web app (web/src/libraryLoader.ts, server/libraryWire.ts): a manifest
// with everything but the items, plus week-sized chunks of items named by a hash of their contents.
// The manifest is revalidated with If-None-Match, so an unchanged library costs one empty 304.
// Only new or changed chunks are fetched (pinned by hash), and each chunk is written to the cache
// before the manifest that points at it. Unchanged chunks keep their Item objects.
//
// Servers without chunk support (older versions) get the classic full /api/library.
import type { Item, Library } from '../../core/types.ts';
import { callRaw } from './api';
import { listCache, readCache, removeCache, writeCache } from './cache';

type ChunkRef = { key: string; n: number; hash: string };
type Manifest = Library & { itemChunks?: ChunkRef[]; itemsTotal?: number };
type Rest = Omit<Library, 'items'>;
type Saved = { etag: string | null; rest: Rest; refs: ChunkRef[]; at: string };
type Chunk = { hash: string; items: Item[] };

const PARALLEL = 3;

let etag: string | null = null;
let last: Library | null = null;
let held = new Map<string, Chunk>();
let savedAt: string | null = null;
let syncing: Promise<unknown> = Promise.resolve();

class Stale extends Error {}

/** Forget what this module holds in memory, for a new pairing. The cache files are per device. */
export function resetLibrarySync() {
  etag = null;
  last = null;
  held = new Map();
  savedAt = null;
}

/** When the library on disk was last brought up to date, or null. */
export function librarySavedAt(): string | null {
  return savedAt;
}

/** The library as it was last saved on this phone, or null when nothing was saved yet. */
export async function loadCachedLibrary(): Promise<Library | null> {
  const m = await readCache<Saved>('manifest');
  if (!m?.refs) return null;
  const chunks = await Promise.all(m.refs.map((r) => readCache<Chunk>(`chunk/${r.key}`)));
  const next = new Map<string, Chunk>();
  const items: Item[] = [];
  let complete = true;
  m.refs.forEach((r, i) => {
    const c = chunks[i];
    if (!c || c.hash !== r.hash) { complete = false; return; }
    next.set(r.key, c);
    for (const it of c.items) items.push(it);
  });
  // Something network-fresh may have arrived while the disk was being read; that wins.
  if (last) return last;
  held = next;
  // A missing chunk means the saved manifest cannot be trusted for a 304: fetch it again.
  etag = complete ? m.etag : null;
  savedAt = m.at ?? null;
  last = { ...m.rest, items } as Library;
  return last;
}

async function fetchChunk(ref: ChunkRef): Promise<Chunk> {
  try {
    const r = await callRaw<Item[]>('GET', `/api/library/chunks/${encodeURIComponent(ref.key)}?h=${encodeURIComponent(ref.hash)}`);
    // A chunk that changed between the manifest and this request is still the newer truth.
    return { hash: r.header('x-chunk-hash') ?? ref.hash, items: r.data ?? [] };
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Stale();
    throw e;
  }
}

async function syncOnce(): Promise<{ lib: Library; changed: boolean }> {
  const headers: Record<string, string> = {};
  if (etag && last) headers['if-none-match'] = etag;
  const res = await callRaw<Manifest>('GET', '/api/library?items=chunks', undefined, headers);
  if (res.status === 304 || !res.data) return { lib: last!, changed: false };
  const data = res.data;
  const now = new Date().toISOString();

  if (!data.itemChunks) {
    // An older server: it sent the whole library. Keep it as one chunk.
    const { items, ...rest } = data;
    const ref = { key: 'all', n: items.length, hash: now };
    writeCache('chunk/all', { hash: ref.hash, items });
    writeCache('manifest', { etag: null, rest, refs: [ref], at: now } satisfies Saved);
    held = new Map([['all', { hash: ref.hash, items }]]);
    etag = null;
    savedAt = now;
    last = data;
    return { lib: last, changed: true };
  }

  const { itemChunks: refs, itemsTotal: _total, items: _none, ...rest } = data;
  const next = new Map<string, Chunk>();
  for (const ref of refs) {
    const h = held.get(ref.key);
    if (h && h.hash === ref.hash) next.set(ref.key, h);
  }
  const missing = refs.filter((ref) => !next.has(ref.key));
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const c = await fetchChunk(ref);
        next.set(ref.key, c);
        writeCache(`chunk/${ref.key}`, c);
      }
    }),
  );

  // The chunk hash may have moved on since the manifest; save the manifest with what was fetched.
  const savedRefs = refs.map((r) => ({ ...r, hash: next.get(r.key)?.hash ?? r.hash }));
  const tag = res.header('etag');
  writeCache('manifest', { etag: savedRefs.every((r, i) => r.hash === refs[i].hash) ? tag : null, rest, refs: savedRefs, at: now } satisfies Saved);
  // Chunks the library no longer has are dropped from the phone too.
  const keep = new Set(refs.map((r) => r.key));
  for (const name of listCache('chunk')) if (!keep.has(name)) removeCache(`chunk/${name}`);

  const unchanged = last && !missing.length && last.items.length === refs.reduce((n, r) => n + r.n, 0);
  const items: Item[] = [];
  if (!unchanged) for (const r of refs) for (const it of next.get(r.key)?.items ?? []) items.push(it);
  held = next;
  etag = tag;
  savedAt = now;
  last = { ...(rest as Rest), items: unchanged ? last!.items : items } as Library;
  return { lib: last, changed: true };
}

/**
 * Brings the library up to date from the computer. `changed` is false when the server answered
 * 304 and the phone already has the current library. Throws ApiError(0) when offline.
 */
export function syncLibrary(): Promise<{ lib: Library; changed: boolean }> {
  // One sync at a time; a call made meanwhile runs after it (and is usually a cheap 304).
  const run = syncing.then(async () => {
    try {
      return await syncOnce();
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      // The library changed while chunks were being fetched: start over from a fresh manifest.
      etag = null;
      return syncOnce();
    }
  });
  syncing = run.catch(() => null);
  return run;
}
