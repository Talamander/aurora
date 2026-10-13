// Keeps the web app's copy of the library in sync without re-downloading it.
//
// The server describes the library as a manifest plus week-sized chunks of items, each named by a
// hash of its contents (see server/libraryWire.ts). This module remembers the chunks it holds and
// fetches only new or changed ones, so a change event after marking one post read costs one small
// request instead of the whole library. Unchanged chunks keep their Item objects, which keeps the
// filter's per-item cache warm. On a cold start the newest posts are handed over first so the feed
// shows up at once, and the rest arrive in the background.
//
// Servers without chunk support (older versions) get the classic full /api/library.

import { warmItems } from '../../core/filter.ts';
import type { Item, Library } from '../../core/types.ts';
import { imgProxyReady, proxyItems, proxyLibrary } from './imgProxy.ts';

type ChunkRef = { key: string; n: number; hash: string };
type Manifest = Library & { itemChunks?: ChunkRef[]; itemsTotal?: number };

/** How many of the newest posts make a first screen worth showing. */
const FIRST_SCREEN = 2500;
const PARALLEL = 4;

let etag: string | null = null;
let last: Library | null = null;
let held = new Map<string, { hash: string; items: Item[] }>();
let syncing: Promise<unknown> = Promise.resolve();

class Stale extends Error {}

async function getJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; data: T | null }> {
  const res = await fetch(path, init);
  if (res.status === 304) return { res, data: null };
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 404 && path.includes('/chunks/')) throw new Stale();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return { res, data };
}

async function fetchChunk(ref: ChunkRef, topics: Library['topics']) {
  const { res, data } = await getJson<Item[]>(`/api/library/chunks/${encodeURIComponent(ref.key)}?h=${encodeURIComponent(ref.hash)}`);
  const items = proxyItems(data ?? []);
  await warmItems(items, topics);
  // A chunk that changed between the manifest and this request is still the newer truth.
  return { hash: res.headers.get('x-chunk-hash') ?? ref.hash, items };
}

async function syncOnce(onFirst?: (lib: Library) => void): Promise<Library | null> {
  const headers: Record<string, string> = {};
  if (etag && last) headers['if-none-match'] = etag;
  const [{ res, data }] = await Promise.all([getJson<Manifest>('/api/library?items=chunks', { headers, cache: 'no-store' }), imgProxyReady()]);
  if (!data) return null; // 304: nothing changed
  if (!data.itemChunks) {
    // An older server: it sent the whole library.
    last = proxyLibrary(data);
    etag = null;
    return last;
  }
  const { itemChunks: refs, itemsTotal, ...rest } = data;
  // Topic matches are cached per topic list, so keep the old list while it is unchanged.
  if (last && JSON.stringify(last.topics) === JSON.stringify(rest.topics)) rest.topics = last.topics;
  const cold = held.size === 0;
  const next = new Map<string, { hash: string; items: Item[] }>();
  for (const ref of refs) {
    const h = held.get(ref.key);
    if (h && h.hash === ref.hash) next.set(ref.key, h);
  }
  const missing = refs.filter((ref) => !next.has(ref.key));
  const assemble = (upTo = refs.length) => {
    const out: Item[] = [];
    for (let i = 0; i < upTo; i++) {
      const c = next.get(refs[i].key);
      if (c) for (const it of c.items) out.push(it);
    }
    return out;
  };

  // Cold start: fetch the newest chunks one by one until there is a first screen, show it, then
  // fetch the rest a few at a time.
  let i = 0;
  if (cold && onFirst) {
    let have = 0;
    for (; i < missing.length && have < FIRST_SCREEN; i++) {
      next.set(missing[i].key, await fetchChunk(missing[i], rest.topics));
      have += next.get(missing[i].key)!.items.length;
    }
    if (i < missing.length) onFirst({ ...rest, items: assemble(refs.indexOf(missing[i])), itemsTotal });
  }
  const queue = missing.slice(i);
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) next.set(ref.key, await fetchChunk(ref, rest.topics));
    }),
  );

  held = next;
  const unchanged = last && !missing.length && last.items.length === refs.reduce((n, r) => n + r.n, 0);
  last = { ...rest, items: unchanged ? last!.items : assemble() };
  etag = res.headers.get('etag');
  return last;
}

/**
 * Brings the library up to date. Resolves to the new library, or null when nothing changed.
 * `onFirst` receives an early library holding only the newest posts on a cold start.
 */
export function loadLibrary(onFirst?: (lib: Library) => void): Promise<Library | null> {
  // One sync at a time; a call made meanwhile runs after it (and is usually a cheap 304).
  const run = syncing.then(async () => {
    try {
      return await syncOnce(onFirst);
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      // The library changed while chunks were being fetched: start over from a fresh manifest.
      etag = null;
      return syncOnce(onFirst);
    }
  });
  syncing = run.catch(() => null);
  return run;
}
