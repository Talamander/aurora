// Aurora local server. Binds to 127.0.0.1 only and serves the API plus
// the built web app. No outbound writes to any social platform, ever.

import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './db.ts';
import { ingestDrafts } from './ingest.ts';
import { safeFetch } from './safeFetch.ts';
import { connectorInfos, detectAndParse, feedConnectors } from './connectors/index.ts';
import { registerXAuthRoutes } from './xAuth.ts';
import { loadDemo } from './demo.ts';
import { broadcast, libraryChanged, onBroadcast, openStream } from './events.ts';
import { compressBodyAsync, createLibraryWire } from './libraryWire.ts';
import { createSearch } from './search.ts';
import { createClassifier } from './agent/classifier.ts';
import { createAlerts } from './alerts.ts';
import { createRoutines } from './routines.ts';
import { createFollows } from './follows.ts';
import { createEdition } from './agent/edition.ts';
import { createCatchUp } from './agent/catchup.ts';
import { createPersonAbout } from './agent/person.ts';
import { createTaste } from './agent/taste.ts';
import { registerActorBundleRoutes } from './actorBundles.ts';
import { readDesktopTheme, watchDesktopTheme } from './desktopTheme.ts';
import { createDevices, isLoopbackHost } from './devices.ts';
import { createLock } from './lock.ts';
import { feedTokenSet, registerFeedRoutes } from './feeds.ts';
import { createSocial } from './social/index.ts';
import { createWeek } from './week.ts';
import { registerLongformRoutes } from './longform/routes.ts';
import { createArchiver, registerArchiveRoutes } from './archive.ts';
import { registerLoginRoutes } from './login.ts';
import { createImageProxy, registerImageProxyRoutes } from './imageProxy.ts';
import { createAgentRuntime } from './agent/runtime.ts';
import { createProfiles, registerProfileRoutes } from './profiles.ts';
import { registerTimeRoutes } from './timeSpent.ts';
import { scopeLibrary } from '../core/profiles.ts';
import { syncActorSource } from './actorSource.ts';
import { applyFilters, DEFAULT_SPEC, normalizeSpec } from '../core/filter.ts';
import { decodeEntities, safeHttpUrl } from '../core/normalize.ts';
import type { ItemState, Library, Source, Topic } from '../core/types.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4317);
const DATA_DIR = process.env.SOCIAL_READER_DATA ?? join(ROOT, 'data');
const DIST = join(ROOT, 'web', 'dist');
const AUTO_SYNC_MINUTES = Number(process.env.AUTO_SYNC_MINUTES ?? 30);

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && process.env.ALLOW_NON_LOCAL !== '1') {
  console.error(`Refusing to bind to ${HOST}. Aurora is a local app; set ALLOW_NON_LOCAL=1 if you really mean it.`);
  process.exit(1);
}

export const store = new Store(DATA_DIR);
// Profiles: new sources, views, pages and AI rules join whichever profile is active.
const profiles = createProfiles(store);
store.onCreate = (kind, id) => profiles.adopt(kind, id);
const archiver = createArchiver({ store, dataDir: DATA_DIR, onChange: () => libraryChanged('archive') });
// A sync cut short by a restart would otherwise show "Syncing" forever.
store.recoverInterruptedSyncs();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => Promise<unknown> | unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}
const routes: Route[] = [];
export function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

/** Picks br or gzip from Accept-Encoding; null when the client takes neither. */
function pickEncoding(req: IncomingMessage | undefined): 'br' | 'gzip' | null {
  const ae = String(req?.headers['accept-encoding'] ?? '');
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
}
function compress(buf: Buffer, enc: 'br' | 'gzip', quality: number): Buffer {
  return enc === 'br'
    ? brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipSync(buf, { level: quality >= 9 ? 9 : 6 });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = Buffer.from(JSON.stringify(body));
  const enc = json.length > 1400 ? pickEncoding(res.req) : null;
  // The library can be hundreds of KB; a fast brotli pass shrinks it about 6x for a few ms.
  const out = enc ? compress(json, enc, 4) : json;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding', ...(enc ? { 'content-encoding': enc } : {}), ...headers });
  res.end(out);
}

async function readBody(req: IncomingMessage, limit: number): Promise<any> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `Upload too large (limit ${Math.round(limit / 1e6)} MB)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Upload too large (limit ${Math.round(limit / 1e6)} MB)`);
    chunks.push(chunk as Buffer);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

let classifier: ReturnType<typeof createClassifier> | undefined;
// Assigned once the routes are registered; library() runs only after that.
let social: ReturnType<typeof createSocial> | undefined;
function library(): Library {
  return {
    items: store.listItems(),
    sources: store.listSources(),
    views: store.listViews(),
    topics: store.listTopics(),
    collections: store.listCollections(),
    syncRuns: store.listRuns(),
    connectors: connectorInfos(),
    pages: store.listPages(),
    aiRules: store.listAiRules(),
    labels: store.listLabels(),
    aiProgress: classifier?.progress(),
    profiles: profiles.list(),
    activeProfile: profiles.active(),
    friendRouting: social?.routing(),
  };
}
const wire = createLibraryWire({
  version: () => store.itemsVersion(),
  items: () => store.listItems(),
  rest: () => {
    const { items: _items, ...rest } = library();
    return rest;
  },
});
// Start-up work runs one step after another, each in small slices, so none of it holds up the
// first page: read the item list, serialize its chunks, then (below) build the search index.
// Reading 100k posts in one go blocks for most of a second, and serializing them for as long again.
// API requests that arrive before the item list is read wait for it (see the server below) rather
// than each starting a blocking read of their own.
const bootAt = performance.now();
const itemsReady = store.warmItems().catch((e) => console.warn('[library] warm-up failed:', (e as Error).message));
let itemsWarm = false;
let itemsAt = 0;
void itemsReady.then(() => ((itemsWarm = true), (itemsAt = performance.now())));
const libraryReady = itemsReady
  .then(() => wire.prepare())
  .then(() => console.log(`[library] ${store.listItems().length} posts read in ${Math.round(itemsAt - bootAt)} ms, ready to send in ${Math.round(performance.now() - bootAt)} ms`))
  .catch((e) => console.warn('[library] warm-up failed:', (e as Error).message));
/** The library as a profile sees it (the active one by default). */
const scopedLibrary = (profileId?: string | null) => scopeLibrary(library(), profileId ?? profiles.active());

// Full-text search (FTS5) in data/search.db, a rebuildable cache. See server/search.ts.
const search = createSearch({ store, dataDir: DATA_DIR, topics: () => store.listTopics(), log: (m) => console.log(m) });
void libraryReady.then(() => setTimeout(() => void search.build(), 1000).unref());
let searchSyncTimer: ReturnType<typeof setTimeout> | null = null;
onBroadcast((evt) => {
  if (evt.type !== 'library' || searchSyncTimer) return;
  searchSyncTimer = setTimeout(() => {
    searchSyncTimer = null;
    search.sync();
  }, 1500);
  searchSyncTimer.unref?.();
});
/** Ids a profile can see, or null for everything. Cached per library version. */
let scopeCache: { key: string; ids: Set<string> | null } | null = null;
function scopeIds(profileId?: string | null): Set<string> | null {
  const id = profileId || profiles.active();
  const key = `${id}|${store.itemsVersion()}|${JSON.stringify(profiles.list())}`;
  if (scopeCache?.key === key) return scopeCache.ids;
  const lib = library();
  const scoped = scopeLibrary(lib, id);
  const ids = scoped.items.length === lib.items.length ? null : new Set(scoped.items.map((i) => i.id));
  scopeCache = { key, ids };
  return ids;
}
route('GET', '/api/search', (_q, _s, _p, _b, url) => {
  const query = String(url.searchParams.get('q') ?? '');
  const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
  const all = url.searchParams.get('profile') === 'all';
  return search.search(query, { limit, ids: all ? null : scopeIds(url.searchParams.get('profile')) });
});
route('GET', '/api/search/status', () => {
  search.sync();
  return search.status();
});
route('GET', '/api/items/:id/related', (_q, _s, p, _b, url) => {
  const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
  return { id: p.id, results: search.related(p.id, { limit, ids: scopeIds(url.searchParams.get('profile')) }) };
});

// The actor runtime (AI-built connectors) loads lazily; the app still works without it.
let actors: any = null;
try {
  const mod = await import('./actors/index.ts');
  actors = mod.createActorRuntime(DATA_DIR);
} catch (e) {
  console.warn('[actors] runtime unavailable:', (e as Error).message);
}

// ---------------------------------------------------------------- sync
const syncing = new Set<string>();

export async function syncSource(id: string) {
  const source = store.getSource(id);
  if (!source) throw new HttpError(404, 'No such source');
  const connector = source.connector === 'actor' ? (actors ? { sync: (ctx: any) => syncActorSource(actors, source, ctx) } : null) : feedConnectors[source.connector];
  if (!connector) throw new HttpError(400, source.connector === 'actor' ? 'The actor runtime is not available.' : 'This source was imported from a file. Import the file again to refresh it.');
  if (syncing.has(id)) return { alreadyRunning: true };
  syncing.add(id);
  store.updateSource(id, { status: 'syncing' });
  const runId = store.startRun(id);
  try {
    const out = await connector.sync({
      sourceId: id,
      config: source.config,
      fetch: safeFetch,
      secrets: { get: (k) => store.getSecret(k), set: (k, v) => store.setSecret(k, v) },
      now: () => new Date(),
      cursor: source.cursor,
    });
    if (out.blocked) {
      store.updateSource(id, { status: 'blocked', statusDetail: out.blocked, lastSyncAt: new Date().toISOString() });
      store.finishRun(runId, { ok: false, added: 0, updated: 0, skipped: 0, errors: [out.blocked] });
      return { blocked: out.blocked };
    }
    const r = ingestDrafts(store, source, out.items);
    const errors = [...out.errors, ...r.errors];
    const ok = out.items.length > 0 || out.errors.length === 0;
    store.updateSource(id, {
      status: ok ? 'ok' : 'error',
      statusDetail: ok ? (errors.length ? `${errors.length} item${errors.length === 1 ? '' : 's'} skipped` : null) : errors[0] ?? 'Sync failed',
      lastSyncAt: new Date().toISOString(),
      ...(out.cursor !== undefined ? { cursor: out.cursor } : {}),
    });
    store.finishRun(runId, { ok, added: r.added, updated: r.updated, skipped: r.skipped, errors });
    libraryChanged('sync');
    if (source.connector === 'actor') maybeRepair(id);
    return { added: r.added, updated: r.updated, skipped: r.skipped, errors };
  } catch (e) {
    const msg = (e as Error).message || 'Sync failed';
    store.updateSource(id, { status: 'error', statusDetail: msg, lastSyncAt: new Date().toISOString() });
    store.finishRun(runId, { ok: false, added: 0, updated: 0, skipped: 0, errors: [msg] });
    libraryChanged('sync');
    if (source.connector === 'actor') maybeRepair(id);
    return { error: msg };
  } finally {
    syncing.delete(id);
  }
}

// Sources whose reads cost money are never synced in the background; the user syncs them by hand.
const MANUAL_ONLY = new Set(['x-bookmarks']);

async function syncAll(opts: { auto?: boolean } = {}) {
  for (const s of store.listSources()) {
    if (opts.auto && MANUAL_ONLY.has(s.connector)) continue;
    const syncable = feedConnectors[s.connector] || (s.connector === 'actor' && actors);
    if (!s.enabled || !syncable || s.status === 'blocked') continue;
    // Each source can set its own pace (actors default to hourly, to be polite to the sites).
    const every = Number(s.config.everyMinutes ?? (s.connector === 'actor' ? 60 : 0));
    if (opts.auto && every && s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < every * 60_000 - 30_000) continue;
    await syncSource(s.id).catch(() => undefined);
  }
}

/** Two failed runs in a row, or zero posts after it used to work: ask the AI to repair the actor. */
const repairing = new Set<string>();
function maybeRepair(sourceId: string) {
  if (repairing.has(sourceId) || !agent || !agent.status().ready || store.getSetting('ai.autoRepair') === false) return;
  const runs = store.listRuns(400).filter((r) => r.sourceId === sourceId).slice(0, 4);
  const failing = runs.length >= 2 && !runs[0].ok && !runs[1].ok;
  const dried = runs.length >= 3 && runs[0].ok && runs[0].added + runs[0].updated === 0 && runs.slice(1).some((r) => r.added + r.updated > 0) && runs[1].added + runs[1].updated === 0;
  if (!failing && !dried) return;
  const repairs = store.listThreads('repair', 50).filter((t) => t.meta.sourceId === sourceId);
  if (repairs.some((t) => Date.now() - Date.parse(t.createdAt) < 6 * 3600_000)) return;
  // Back off: after two automatic repairs with no good run since, stop spending on it and leave it to
  // the person (the Workshop's Repair button still works). A good run resets the count.
  const lastOk = store.listRuns(400).find((r) => r.sourceId === sourceId && r.ok);
  const since = lastOk ? Date.parse(lastOk.finishedAt ?? lastOk.startedAt) : 0;
  if (repairs.filter((t) => t.meta.origin !== 'user' && Date.parse(t.createdAt) > since).length >= 2) return;
  repairing.add(sourceId);
  const s = store.getSource(sourceId);
  agent.startJob({ kind: 'repair', request: `The source "${s?.label}" ${failing ? 'failed twice in a row' : 'stopped returning posts'}. Repair it.`, parentId: null, sourceId, origin: 'schedule' });
  setTimeout(() => repairing.delete(sourceId), 6 * 3600_000).unref();
}

/** Add a source through a built-in connector and sync it once. Shared by the UI and the AI. */
async function addFeed(connectorId: string, config: Record<string, unknown>) {
  const connector = feedConnectors[connectorId];
  if (!connector) throw new HttpError(400, 'Unknown connector');
  if (!connector.info.available) throw new HttpError(409, connector.info.blockedReason ?? 'This connector is not available yet');
  let prepared: { config: Record<string, unknown>; label: string };
  try {
    prepared = await connector.prepareConfig(config ?? {}, safeFetch);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const key = prepared.config.url ? 'url' : prepared.config.handle ? 'handle' : null;
  if (key) {
    const dupe = store.findSourceByConfig(connector.info.id, key, String(prepared.config[key]));
    if (dupe) throw new HttpError(409, `Already connected as “${dupe.label}”`);
  }
  const source = store.createSource({ connector: connector.info.id, label: prepared.label, platform: connector.info.platform, config: prepared.config });
  const result = await syncSource(source.id);
  return { source: store.getSource(source.id), result };
}

const agent = createAgentRuntime(
  { store, dataDir: DATA_DIR, library: () => scopedLibrary(), syncSource, addFeed, actors, profiles, search },
  { route, HttpError },
);

// Plain-English rules: label new posts in the background whenever posts or rules change.
classifier = createClassifier({ store, complete: agent.completeFor('classifier'), ready: () => agent.status(), changed: libraryChanged, log: (m) => console.warn(m) });
onBroadcast((e) => {
  if (e.type === 'ui' && e.action.kind === 'classify') classifier?.kick(200);
  else if (e.type === 'library' && (e.reason === 'sync' || e.reason === 'rule')) classifier?.kick();
});
setTimeout(() => classifier?.kick(), 5000);

// Alerts: plain-English watches, checked against posts that are new after each sync.
const alerts = createAlerts({
  store,
  complete: agent.completeFor('alerts'),
  ready: () => agent.status(),
  profiles: () => profiles.list(),
  friendRouting: () => social?.routing() ?? {},
  broadcast,
  log: (m) => console.warn(m),
});
alerts.register(route, HttpError);
onBroadcast((e) => {
  if (e.type === 'library' && e.reason === 'sync') alerts.kick();
});
setTimeout(() => alerts.kick(), 8000).unref();

// Routines: plain-English jobs the agent runs on a schedule, off until the user turns them on.
const routines = createRoutines({
  store,
  profiles: () => profiles.list(),
  runRoutine: (job) => agent.runRoutine(job),
  complete: agent.completeFor('routines'),
  ready: () => agent.status(),
  broadcast,
  log: (m) => console.warn(m),
});
routines.register(route, HttpError);
onBroadcast((e) => {
  if (e.type === 'library' && e.reason === 'sync') routines.afterSync();
});
setInterval(() => routines.tick(), 60_000).unref();
setTimeout(() => routines.tick(), 15_000).unref();

// Bring your follows: accounts from data exports, added through feeds, existing connectors, or
// one AI build per platform. Starts only when the user presses the button.
const follows = createFollows({
  store,
  profiles,
  actors: () => actors?.store ?? null,
  addFeed,
  syncSource,
  startJob: (job) => agent.startJob(job),
  aiReady: () => agent.status().ready,
  fetch: safeFetch,
  broadcast,
  log: (m) => console.warn(m),
});
follows.register(route, HttpError);
follows.resume();

// The morning edition: a daily AI-written page, also buildable on demand.
const edition = createEdition({ store, library: scopedLibrary, profiles, complete: agent.completeFor('briefs'), ready: () => agent.status(), changed: libraryChanged, log: (m) => console.warn(m) });
setInterval(() => edition.tick(), 10 * 60_000).unref();
setTimeout(() => edition.tick(), 20_000).unref();
route('POST', '/api/edition', async (_q, _s, _p, body) => {
  const r = await edition.build({ reason: 'asked', profileId: body?.profile ? String(body.profile) : profiles.active() });
  if (!r.ok) throw new HttpError(409, r.message);
  return r;
});

// Your week: the weekly recap, frozen and written on Sunday evening, or on demand.
const week = createWeek({ store, library: scopedLibrary, profiles, complete: agent.completeFor('week'), ready: () => agent.status(), HttpError, log: (m) => console.warn(m) });
week.register(route);
setInterval(() => void week.tick(), 10 * 60_000).unref();
setTimeout(() => void week.tick(), 30_000).unref();

// The catch-up card's brief: what arrived since the reader last looked.
const catchUp = createCatchUp({ library: scopedLibrary, complete: agent.completeFor('briefs'), ready: () => agent.status(), log: (m) => console.warn(m) });
route('POST', '/api/catchup', async (_q, _s, _p, body) => {
  try {
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 300) : null;
    return await catchUp.brief(String(body?.since ?? ''), ids, body?.profile ? String(body.profile) : profiles.active());
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
});

// The person sheet's one-liner about what someone posts.
const personAbout = createPersonAbout({ store, complete: agent.completeFor('briefs'), ready: () => agent.status(), log: (m) => console.warn(m) });
route('POST', '/api/person/about', async (_q, _s, _p, body) => {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 40) : [];
  return personAbout.about(String(body?.key ?? '').slice(0, 200), ids);
});

// Taste suggestions: rules and views the AI proposes from what the reader saves and opens.
const taste = createTaste({ store, library: () => scopedLibrary(), profileId: () => profiles.active(), complete: agent.completeFor('briefs'), ready: () => agent.status(), changed: libraryChanged, log: (m) => console.warn(m) });
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 30) : []);
route('GET', '/api/taste', () => taste.current());
route('POST', '/api/taste/refresh', async (_q, _s, _p, body) => {
  try {
    await taste.build({ muted: strList(body?.muted), excluded: strList(body?.excluded) });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  return taste.current();
});
route('POST', '/api/taste/:id/dismiss', (_q, _s, p) => (taste.dismiss(p.id), taste.current()));
route('POST', '/api/taste/:id/accept', (_q, _s, p) => {
  try {
    return { created: taste.accept(p.id), ...taste.current() };
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
});

// ---------------------------------------------------------------- routes
// The library is revalidated rather than resent: phones and the desktop app poll it on every
// change event, and most of the time nothing they can see has changed.
route('GET', '/api/library', async (req, res, _p, _b, url) => {
  await wire.prepare();
  if (url.searchParams.get('items') === 'chunks') {
    // The web app's manifest: everything but the items, plus the chunks to sync them from.
    const json = Buffer.from(JSON.stringify(wire.manifest()));
    const etag = `"${createHash('sha1').update(json).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache', vary: 'accept-encoding' });
      res.end();
      return;
    }
    const enc = json.length > 1400 ? pickEncoding(req) : null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag, vary: 'accept-encoding', ...(enc ? { 'content-encoding': enc } : {}) });
    res.end(enc ? compress(json, enc, 4) : json);
    return;
  }
  const enc = pickEncoding(req);
  const { etag, bodyAsync } = wire.full(enc);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache', vary: 'accept-encoding' });
    res.end();
    return;
  }
  const body = await bodyAsync();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag, vary: 'accept-encoding', ...(enc ? { 'content-encoding': enc } : {}) });
  res.end(body);
});
// Quick look (the desktop app's small window, or /?quick=1 in a browser): the top posts worth
// reading in the active profile, the same list `aurora status` counts, without sending the library.
route('GET', '/api/quick', (_q, _s, _p, _b, url) => {
  const id = profiles.active();
  const l = scopedLibrary(id);
  const labels = Object.fromEntries(l.sources.map((s) => [s.id, s.label]));
  const ctx = { topics: l.topics, sourceLabels: labels, ai: { rules: l.aiRules, labels: l.labels } };
  const worth = applyFilters(l.items, normalizeSpec({ ...DEFAULT_SPEC, read: 'unread', hideNoise: true }), ctx).visible;
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 5));
  const flat = (s: string | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const profile = profiles.get(id);
  return {
    profile: profile ? { id: profile.id, name: profile.name, color: profile.color, look: profile.look ?? null } : null,
    worth: worth.length,
    items: worth.slice(0, limit).map(({ item: it }) => ({
      id: it.id,
      title: flat(it.title || it.text, 220) || '(no text)',
      author: flat(it.author.name, 60),
      avatar: it.author.avatar ?? null,
      source: flat(labels[it.sourceId] ?? it.platform, 40),
      platform: it.platform,
      url: safeHttpUrl(it.url) ?? null,
      publishedAt: it.publishedAt,
      saved: it.state.saved,
    })),
  };
});
// One week of items as a JSON array. Asked for by hash (?h=), the answer never changes, so the
// browser may keep it; a stale hash gets the current bytes and is not cached.
route('GET', '/api/library/chunks/:key', async (req, res, p, _b, url) => {
  await wire.prepare();
  const enc = pickEncoding(req);
  const c = wire.chunk(p.key, enc);
  if (!c) throw new HttpError(404, 'That part of the library changed. Reload it.');
  const pinned = url.searchParams.get('h') === c.hash;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': pinned ? 'private, max-age=31536000, immutable' : 'no-store',
    etag: `"${c.hash}"`,
    'x-chunk-hash': c.hash,
    vary: 'accept-encoding',
    ...(enc ? { 'content-encoding': enc } : {}),
  });
  res.end(c.body);
});
// Exports: the whole library as JSON, and the followed feeds as OPML. No secrets are included.
const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
route('GET', '/api/export/library.json', (_q, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const { items, sources, views, topics, collections } = library();
  const body = JSON.stringify({ format: 'social-reader-library', version: 1, exportedAt: new Date().toISOString(), items, sources, views, topics, collections }, null, 1);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="social-reader-${day}.json"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
});
route('GET', '/api/export/feeds.opml', (_q, res) => {
  const feeds = store.listSources().filter((s) => s.connector === 'rss' && typeof s.config.url === 'string');
  const lines = feeds.map((s) => `    <outline type="rss" text="${xmlEscape(s.label)}" title="${xmlEscape(s.label)}" xmlUrl="${xmlEscape(String(s.config.url))}"/>`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Aurora feeds</title></head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`;
  res.writeHead(200, { 'content-type': 'text/x-opml; charset=utf-8', 'content-disposition': 'attachment; filename="social-reader-feeds.opml"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
});
route('GET', '/api/events', (req, res) => openStream(req, res));
route('GET', '/api/about', () => ({ root: ROOT, dataDir: DATA_DIR, node: process.version }));
route('GET', '/api/health', () => ({ ok: true, db: store.path, items: store.listItems().length }));

const STATE_KEYS: (keyof ItemState)[] = ['read', 'saved', 'archived', 'collections', 'noiseOverride'];
function cleanStatePatch(body: any): Partial<ItemState> {
  const patch: Partial<ItemState> = {};
  for (const k of STATE_KEYS) {
    if (!(k in (body ?? {}))) continue;
    const v = body[k];
    if (k === 'collections') {
      if (!Array.isArray(v)) throw new HttpError(400, 'collections must be a list');
      patch.collections = v.map(String).slice(0, 50);
    } else if (k === 'noiseOverride') patch.noiseOverride = v === null ? null : Boolean(v);
    else (patch as any)[k] = Boolean(v);
  }
  return patch;
}
route('POST', '/api/items/state', (_q, _s, _p, body) => {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 5000) : [];
  if (!ids.length) throw new HttpError(400, 'No items given');
  const patch = cleanStatePatch(body.patch);
  if (patch.collections) for (const c of patch.collections) store.addCollection(c);
  const items = store.patchState(ids, patch);
  if (patch.saved === true) archiver.onSaved(ids);
  return { items };
});

route('GET', '/api/connectors', () => connectorInfos());
route('POST', '/api/sources', (_q, _s, _p, body) => addFeed(String(body?.connector), body?.config ?? {}));
route('PATCH', '/api/sources/:id', (_q, _s, p, body) => {
  if (!store.getSource(p.id)) throw new HttpError(404, 'No such source');
  const patch: { label?: string; enabled?: boolean } = {};
  if (typeof body?.label === 'string' && body.label.trim()) patch.label = body.label.trim().slice(0, 120);
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
  store.updateSource(p.id, patch);
  return store.getSource(p.id);
});
route('DELETE', '/api/sources/:id', (_q, _s, p) => {
  if (!store.getSource(p.id)) throw new HttpError(404, 'No such source');
  store.deleteSource(p.id);
  return { ok: true };
});
route('POST', '/api/sources/:id/sync', (_q, _s, p) => syncSource(p.id));
route('POST', '/api/sync', async () => {
  await syncAll();
  return { ok: true };
});

/** OPML feed lists (exported by most feed readers) become RSS sources, then sync in the background. */
function importOpml(text: string) {
  const errors: string[] = [];
  const created: string[] = [];
  let skipped = 0;
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    return m ? decodeEntities(m[2] ?? m[3] ?? '').trim() : '';
  };
  for (const [tag] of text.matchAll(/<outline\b[^>]*>/gi)) {
    const raw = attr(tag, 'xmlUrl');
    if (!raw) continue;
    const url = safeHttpUrl(raw);
    if (!url) {
      skipped++;
      if (errors.length < 50) errors.push(`Skipped a feed that is not an http(s) link (${raw.slice(0, 60)})`);
      continue;
    }
    if (store.findSourceByConfig('rss', 'url', url)) {
      skipped++;
      continue;
    }
    if (created.length >= 500) {
      skipped++;
      continue;
    }
    const label = (attr(tag, 'title') || attr(tag, 'text') || new URL(url).hostname).slice(0, 200);
    created.push(store.createSource({ connector: 'rss', label, platform: 'rss', config: { url, platform: 'rss' } }).id);
  }
  void (async () => {
    for (const id of created) await syncSource(id).catch(() => undefined);
  })();
  return { feedsAdded: created.length, added: 0, updated: 0, skipped, errors };
}

route('POST', '/api/import', (_q, _s, _p, body) => {
  const fileName = String(body?.fileName ?? 'upload').slice(0, 200);
  const text = String(body?.text ?? '');
  if (!text.trim()) throw new HttpError(400, 'The file is empty');
  if (/<opml[\s>]/i.test(text.slice(0, 4000))) return importOpml(text);
  let parsed;
  try {
    parsed = detectAndParse(fileName, text);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const existing = store.listSources().find((s) => s.connector === 'import' && s.config.fileName === fileName && s.config.parser === parsed.label);
  const source = existing ?? store.createSource({ connector: 'import', label: parsed.label, platform: parsed.platform, config: { fileName, parser: parsed.label } });
  const runId = store.startRun(source.id);
  const r = ingestDrafts(store, source, parsed.items);
  const errors = [...parsed.errors, ...r.errors];
  const ok = parsed.items.length > 0;
  store.updateSource(source.id, {
    status: ok ? 'ok' : 'error',
    statusDetail: ok ? (errors.length ? `${errors.length} row${errors.length === 1 ? '' : 's'} skipped` : null) : errors[0] ?? 'Nothing importable in that file',
    lastSyncAt: new Date().toISOString(),
  });
  // Rows the parser rejected count as skipped too, so the totals match the problem list.
  const skipped = r.skipped + parsed.errors.length;
  store.finishRun(runId, { ok, added: r.added, updated: r.updated, skipped, errors });
  if (r.added) alerts.kick();
  return { source: store.getSource(source.id), added: r.added, updated: r.updated, skipped, errors };
});

route('POST', '/api/demo', () => {
  const existing = store.listSources().find((s) => s.isDemo);
  if (existing) store.deleteSource(existing.id);
  const source = store.createSource({ connector: 'demo', label: 'Demo library (fictional)', platform: 'demo', config: { note: 'Fictional sample posts for trying filters. Not real accounts.' }, isDemo: true, status: 'ok' });
  const r = ingestDrafts(store, source, loadDemo());
  store.updateSource(source.id, { status: 'ok', lastSyncAt: new Date().toISOString() });
  return { source: store.getSource(source.id), added: r.added };
});

route('POST', '/api/views', (_q, _s, _p, body) => {
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'A view needs a name');
  return store.saveView({ id: body?.id ? String(body.id) : undefined, name, spec: normalizeSpec(body?.spec) });
});
route('DELETE', '/api/views/:id', (_q, _s, p) => (store.deleteView(p.id), { ok: true }));

route('POST', '/api/topics', (_q, _s, _p, body) => {
  const name = String(body?.name ?? '').trim().slice(0, 60);
  const terms = (Array.isArray(body?.terms) ? body.terms : String(body?.terms ?? '').split(','))
    .map((t: unknown) => String(t).trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!name || !terms.length) throw new HttpError(400, 'A topic needs a name and at least one word');
  const topic: Topic = { id: body?.id ? String(body.id) : randomUUID(), name, terms };
  store.saveTopic(topic);
  return topic;
});
route('DELETE', '/api/topics/:id', (_q, _s, p) => (store.deleteTopic(p.id), { ok: true }));

route('POST', '/api/collections', (_q, _s, _p, body) => {
  const name = String(body?.name ?? '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'A collection needs a name');
  store.addCollection(name);
  return { collections: store.listCollections() };
});
route('DELETE', '/api/collections/:name', (_q, _s, p) => (store.deleteCollection(decodeURIComponent(p.name)), { collections: store.listCollections() }));

route('GET', '/api/settings/:key', (_q, _s, p) => ({ value: p.key.startsWith('ui.') ? store.getSetting(p.key) : null }));
route('PUT', '/api/settings/:key', (_q, _s, p, body) => {
  if (!p.key.startsWith('ui.')) throw new HttpError(400, 'Only ui.* settings are writable');
  store.setSetting(p.key, body?.value ?? null);
  return { ok: true };
});

route('POST', '/api/pages', (_q, _s, _p, body) => {
  const name = String(body?.name ?? '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'A page needs a name');
  if (!Array.isArray(body?.blocks)) throw new HttpError(400, 'blocks must be a list');
  const page = store.savePage({ id: body?.id ? String(body.id) : undefined, name, icon: body?.icon ?? null, blocks: body.blocks.slice(0, 40) });
  libraryChanged('page');
  return page;
});
route('DELETE', '/api/pages/:id', (_q, _s, p) => (store.deletePage(p.id), libraryChanged('page'), { ok: true }));
route('DELETE', '/api/ai-rules/:id', (_q, _s, p) => (store.deleteAiRule(p.id), libraryChanged('rule'), { ok: true }));
route('PATCH', '/api/ai-rules/:id', (_q, _s, p, body) => {
  const rule = store.listAiRules().find((r) => r.id === p.id);
  if (!rule) throw new HttpError(404, 'No such rule');
  const saved = store.saveAiRule({ ...rule, enabled: typeof body?.enabled === 'boolean' ? body.enabled : rule.enabled });
  libraryChanged('rule');
  return saved;
});

// Actors: the connectors the AI built. Read-only views plus rollback; the AI writes them.
route('GET', '/api/actors', () => {
  if (!actors) return { available: false, actors: [] };
  return { available: true, actors: actors.store.list() };
});
route('GET', '/api/actors/:id', (_q, _s, p) => {
  if (!actors) throw new HttpError(404, 'The actor runtime is not available');
  const got = actors.store.get(p.id);
  if (!got) throw new HttpError(404, 'No such actor');
  const sources = store.listSources().filter((s) => s.connector === 'actor' && s.config.actorId === p.id);
  const runs = store.listRuns(400).filter((r) => sources.some((s) => s.id === r.sourceId)).slice(0, 20);
  const threads = store.listThreads(undefined, 200).filter((t) => (t.kind === 'build' || t.kind === 'repair') && store.listEvents(t.id).some((e) => e.type === 'actor' && e.data?.id === p.id)).slice(0, 10);
  return { ...got, versions: actors.store.versions?.(p.id) ?? [], sources, runs, threads };
});
route('POST', '/api/actors/:id/rollback', (_q, _s, p, body) => {
  if (!actors) throw new HttpError(404, 'The actor runtime is not available');
  return actors.store.rollback(p.id, Number(body?.version));
});

registerXAuthRoutes({ route, store, port: PORT, HttpError, syncSource });
registerFeedRoutes(route, { store, HttpError, profiles, friendRouting: () => social?.routing() ?? {} });
registerProfileRoutes(route, { profiles, HttpError, changed: libraryChanged });
registerTimeRoutes(route, { store, profiles, HttpError });
registerLongformRoutes(route, { store, HttpError, fetch: safeFetch, complete: agent.completeFor('summaries'), ready: () => agent.status(), changed: libraryChanged, addFeed });
registerLoginRoutes(route, { dataDir: DATA_DIR, HttpError });
registerArchiveRoutes(route, { store, archiver, HttpError });
registerImageProxyRoutes(route, { proxy: createImageProxy({ store, dataDir: DATA_DIR }), HttpError });
registerActorBundleRoutes(route, { actorStore: () => actors?.store ?? null, HttpError });
route('GET', '/api/desktop-theme', () => ({ theme: readDesktopTheme() }));
watchDesktopTheme(() => broadcast({ type: 'ui', action: { kind: 'desktop-theme' } }));
social = createSocial({
  store,
  dataDir: DATA_DIR,
  changed: libraryChanged,
  log: (m) => console.log(m),
  HttpError,
  profiles: () => profiles.list(),
  actorStore: () => actors?.store ?? null,
});
social.register(route);
// Owner lock: required when hosted or bound to the network without SR_TRUST_NETWORK; optional
// (off by default) on localhost. See server/lock.ts.
const lock = createLock({
  store,
  HttpError,
  port: PORT,
  dataDir: DATA_DIR,
  feedTokenSet: () => feedTokenSet(store),
  required: process.env.SR_CLOUD === '1' || (!isLoopbackHost(HOST) && process.env.SR_TRUST_NETWORK !== '1'),
  trustProxy: process.env.SR_CLOUD === '1' || process.env.SR_TRUST_PROXY === '1',
  log: (m) => console.log(m),
});
if (process.env.SR_RESET_LOCK === '1') lock.reset();
lock.register(route);
const devices = createDevices({ store, host: HOST, port: PORT, HttpError, log: (m) => console.log(m), lockActive: lock.active });
devices.register(route);

// ---------------------------------------------------------------- static
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: data:; media-src 'self' https: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self' https://video.bsky.app https://video.cdn.bsky.app; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

// Compressed static files, keyed by path, mtime and encoding. Compression runs on libuv's thread
// pool, never on the event loop: maximum quality (slow, ~1 s for the main script) ahead of time,
// and a quick pass for a visitor who asks before that is done.
type StaticHit = { data: Buffer; enc: 'br' | 'gzip' | null; best: boolean };
const staticCache = new Map<string, StaticHit>();
const staticBest = new Map<string, Promise<void>>();
function storeStatic(key: string, hit: StaticHit) {
  if (staticCache.size > 200) staticCache.clear();
  staticCache.set(key, hit);
}
function bestStatic(key: string, raw: Buffer, enc: 'br' | 'gzip'): Promise<void> {
  let p = staticBest.get(key);
  if (!p) {
    p = compressBodyAsync(raw, enc, 11)
      .then((data) => storeStatic(key, { data, enc, best: true }))
      .catch(() => {})
      .finally(() => staticBest.delete(key));
    staticBest.set(key, p);
  }
  return p;
}
async function cachedStatic(file: string, mtimeMs: number, enc: 'br' | 'gzip' | null, opts: { best?: boolean } = {}): Promise<StaticHit> {
  const key = `${file}:${mtimeMs}:${enc ?? 'id'}`;
  const hit = staticCache.get(key);
  if (hit && (hit.best || !opts.best)) return hit;
  const raw = await readFile(file);
  if (!enc || raw.length <= 1024) {
    const plain = { data: raw, enc: null, best: true };
    storeStatic(key, plain);
    return plain;
  }
  if (opts.best) {
    await bestStatic(key, raw, enc);
    return staticCache.get(key) ?? { data: raw, enc: null, best: false };
  }
  // The best pass is left to warmStatic, which runs one file at a time: starting one per request
  // here could fill the thread pool and stall the file reads the page is waiting for.
  const quick: StaticHit = { data: await compressBodyAsync(raw, enc, 5), enc, best: false };
  if (!staticCache.get(key)?.best) storeStatic(key, quick);
  return quick;
}
/** Compress the app's scripts and styles ahead of the first visit. */
async function warmStatic() {
  try {
    const dir = join(DIST, 'assets');
    for (const f of await readdir(dir)) {
      if (!/\.(js|css)$/.test(f) || f.startsWith('hls')) continue;
      const file = join(dir, f);
      await cachedStatic(file, (await stat(file)).mtimeMs, 'br', { best: true });
    }
  } catch {
    /* not built yet */
  }
}
async function serveStatic(res: ServerResponse, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST)) throw new HttpError(403, 'Forbidden');
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  try {
    const st = await stat(file);
    const immutable = file.includes(`${join(DIST, 'assets')}`);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const enc = /^(text\/|application\/(json|manifest))|svg/.test(type) ? pickEncoding(res.req) : null;
    const hit = await cachedStatic(file, st.mtimeMs, enc);
    const data = hit.data;
    res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', vary: 'accept-encoding', ...(hit.enc ? { 'content-encoding': hit.enc } : {}), ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The web app is not built yet. Run: npm run build');
  }
}

// Widgets are HTML the AI wrote. They run in a sandboxed iframe (opaque origin) with no network:
// connect-src 'none' and no same-origin access, so they can only draw what the page posts to them.
// The CSP itself carries "sandbox allow-scripts", so a widget opened directly in a tab (not in the
// page's iframe) still gets an opaque origin and cannot read the app or its API. Pictures and media
// only load from this server (the image proxy serves only images already in the library), so a
// widget cannot leak what it was shown through image URLs.
function widgetCsp(host: string): string {
  const self = `'self' http://${host} https://${host}`;
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${self} data: blob:; media-src ${self} data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
}
const WIDGET_BOOT = `<style>:root{color-scheme:light dark}</style><script>window.sr={data:null,_cbs:[],onData(cb){this._cbs.push(cb);if(this.data)cb(this.data)},open(url){parent.postMessage({type:'sr-open',url},'*')}};addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='sr-data')return;sr.data=e.data;try{const t=e.data.theme;if(t&&t.tokens)for(const k in t.tokens)document.documentElement.style.setProperty('--sr-'+k,t.tokens[k]);if(t&&t.mode)document.documentElement.dataset.theme=t.mode}catch{}sr._cbs.forEach(cb=>{try{cb(e.data)}catch(err){console.error(err)}})});new ResizeObserver(()=>parent.postMessage({type:'sr-size',h:document.documentElement.scrollHeight},'*')).observe(document.documentElement);</script>`;
function serveWidget(res: ServerResponse, host: string, pageId: string, idx: number) {
  const block = store.getPage(pageId)?.blocks[idx] as { type: string; html?: string } | undefined;
  if (!block || block.type !== 'widget') throw new HttpError(404, 'No such widget');
  const html = String(block.html ?? '');
  const doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">${WIDGET_BOOT}`) : `<!doctype html><html><head><meta charset="utf-8">${WIDGET_BOOT}</head><body>${html}</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': widgetCsp(host), 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(doc);
}

// SR_ALLOWED_HOSTS: extra comma-separated Host values (host or host:port) to answer to, for a
// remapped Docker port or a private hostname such as a Tailscale name behind auth.
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, ...(process.env.SR_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET navigations and curl
  try {
    return allowedHosts.has(new URL(origin).host) || /^https?:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin);
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    // DNS-rebinding guard: only answer to local host names. Paired phones (Bearer device token)
    // and the two pairing-claim endpoints are the only exceptions; see server/devices.ts.
    const host = req.headers.host ?? '';
    const hostAllowed = allowedHosts.has(host) || /^(localhost|127\.0\.0\.1):5173$/.test(host);
    const url = new URL(req.url ?? '/', `http://${hostAllowed ? host : 'device.invalid'}`);
    const who = devices.gate(req, res, url, hostAllowed);
    if (res.headersSent) return; // CORS preflight answered
    // Paired phones keep their own token and route allowlist; everyone else needs a session
    // while the lock is on.
    if (who.kind === 'local') lock.gate(req, url);
    if (url.pathname.startsWith('/api/')) {
      if (!itemsWarm) await itemsReady;
      const method = req.method ?? 'GET';
      if (method !== 'GET') {
        if (who.kind === 'local' && !originOk(req)) throw new HttpError(403, 'Cross-origin request refused');
        // The media type itself must be JSON. "text/plain; x=application/json" is a CORS-safelisted
        // type that any web page can send without a preflight, so a substring match is not enough.
        if (!/^\s*application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON');
      }
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const body = method === 'GET' ? null : await readBody(req, url.pathname === '/api/import' || url.pathname === '/api/longform/import' ? 80e6 : 1e6);
        const out = await r.handler(req, res, params, body, url);
        if (!res.headersSent) send(res, 200, out ?? { ok: true });
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const w = url.pathname.match(/^\/widget\/([^/]+)\/(\d+)$/);
    if (w) return serveWidget(res, host, decodeURIComponent(w[1]), Number(w[2]));
    await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('[error]', (e as Error).stack ?? e);
    if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong on the local server. Check the terminal log.', ...((e as { locked?: boolean }).locked ? { locked: true } : {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Aurora running at http://${HOST === '::1' ? '[::1]' : HOST}:${PORT}  (data: ${store.path})`);
  setTimeout(() => void warmStatic(), 200).unref();
});

if (AUTO_SYNC_MINUTES > 0) {
  setTimeout(() => void syncAll({ auto: true }), 5_000);
  setInterval(() => void syncAll({ auto: true }), AUTO_SYNC_MINUTES * 60_000).unref();
}

export type { Source };
