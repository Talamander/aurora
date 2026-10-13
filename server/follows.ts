// "Bring your follows" on the server: plan how each account from an export gets into Aurora, then
// work through the list politely in the background.
//
// Three lanes, cheapest first:
// - feed: open feeds and APIs (Bluesky, Mastodon, subreddits, Substack, YouTube channel feeds, any
//   RSS). Instant and free.
// - actor: the platform already has a working AI-built connector, so each account becomes a new
//   source on that same connector with the account as its input. No AI call.
// - build: no connector yet. One AI build for the first account of that platform; the builder
//   writes it to take the account as input, and every other account then uses the actor lane.
//
// Nothing starts until the user presses the button. Nothing is ever followed, liked or posted on
// a platform: "following" here means reading public posts into this computer.

import type { Store } from './db.ts';
import type { Profiles } from './profiles.ts';
import type { ActorManifest } from './actors/types.ts';
import type { SafeFetch } from './connectors/types.ts';
import { ALL_PROFILE } from '../core/profiles.ts';
import { cleanTargets, PLATFORM_LABEL, sourceFollowKeys, target, type FollowPlatform, type FollowTarget } from '../core/follows.ts';

type RouteFn = (method: string, path: string, handler: (req: any, res: any, params: Record<string, string>, body: any, url: URL) => unknown) => void;

export type Lane = 'exists' | 'feed' | 'actor' | 'build' | 'unsupported';

export interface FollowItem {
  key: string;
  platform: FollowPlatform;
  handle: string;
  name?: string;
  avatar?: string;
  profileId?: string;
  lane: Lane;
  status: 'queued' | 'adding' | 'done' | 'exists' | 'failed' | 'waiting' | 'building' | 'blocked' | 'cancelled';
  sourceId?: string;
  added?: number;
  error?: string;
}

export interface FollowJob {
  id: string;
  startedAt: string;
  finishedAt?: string;
  cancelled?: boolean;
  items: FollowItem[];
  /** One AI build per platform at most. */
  builds: Partial<Record<FollowPlatform, { threadId: string; status: 'running' | 'done' | 'failed'; startedAt: string }>>;
}

export interface PlatformPlan {
  platform: FollowPlatform;
  label: string;
  lane: Lane;
  /** Plain words for the review screen. */
  how: string;
  actorId?: string;
  total: number;
  exists: number;
}

export interface Deps {
  store: Store;
  profiles: Profiles;
  actors: () => { list(): ActorManifest[] } | null;
  addFeed: (connector: string, config: Record<string, unknown>) => Promise<{ source: any; result: any }>;
  syncSource: (id: string) => Promise<any>;
  startJob: (job: { kind: 'build'; request: string; parentId: string | null; origin: 'user' }) => { threadId: string };
  aiReady: () => boolean;
  fetch: SafeFetch;
  broadcast: (e: any) => void;
  log?: (m: string) => void;
  /** Test hook: how long to wait between two sources of the same platform. */
  gapMs?: (platform: FollowPlatform) => number;
  pollMs?: number;
}

const FEED_PLATFORMS = new Set<FollowPlatform>(['bluesky', 'mastodon', 'reddit', 'substack', 'feed']);
const JOB_KEY = 'follows.job';
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Stop adding a platform's accounts when its first few all fail: the connector is likely broken. */
const FAIL_FAST = 3;

/** The cost of past connector builds on this computer, for an honest estimate. */
export function buildCostRange(store: Store): { min: number; max: number; median: number; samples: number } {
  const costs = store
    .listThreads('build', 200)
    .filter((t) => t.status === 'done')
    .map((t) => Number(t.meta.costUsd))
    .filter((c) => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b);
  // Measured during the first 24 real builds (STATUS.md), used until this computer has its own.
  if (costs.length < 3) return { min: 0.09, max: 0.74, median: 0.3, samples: 0 };
  return { min: costs[0], max: costs[costs.length - 1], median: costs[Math.floor(costs.length / 2)], samples: costs.length };
}

/** A tested connector for the platform: an actor whose single required input is the account. */
export function provenActor(store: Store, actors: ActorManifest[], platform: FollowPlatform): { actor: ActorManifest; field: string; coverage?: string } | null {
  const sources = store.listSources().filter((s) => s.connector === 'actor');
  let best: { actor: ActorManifest; field: string; coverage?: string; ok: number } | null = null;
  for (const a of actors) {
    if (a.platform !== platform || a.tier === 'session') continue;
    const schema = (a.input ?? {}) as { required?: unknown; properties?: Record<string, { type?: string }> };
    const req = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const field = req[0];
    if (req.length !== 1 || schema.properties?.[field]?.type !== 'string') continue;
    const mine = sources.filter((s) => s.config.actorId === a.id);
    const ok = mine.filter((s) => s.status === 'ok' && s.lastSyncAt).length;
    if (!ok) continue;
    if (!best || ok > best.ok) best = { actor: a, field, ok, coverage: mine.find((s) => typeof s.config.coverage === 'string')?.config.coverage as string | undefined };
  }
  return best && { actor: best.actor, field: best.field, coverage: best.coverage };
}

/** The keys of everything already followed. */
export function followedKeys(store: Store): Set<string> {
  const keys = new Set<string>();
  for (const s of store.listSources()) if (!s.isDemo) for (const k of sourceFollowKeys(s)) keys.add(k);
  return keys;
}

/** The RSS feed for an open-platform account (null for Bluesky, which has its own connector). */
export function feedUrlFor(t: Pick<FollowTarget, 'platform' | 'handle'>): string | null {
  switch (t.platform) {
    case 'mastodon': {
      const [user, host] = t.handle.split('@');
      return `https://${host}/@${user}.rss`;
    }
    case 'reddit':
      return `https://www.reddit.com/r/${t.handle}/.rss`;
    case 'substack':
      return t.handle.startsWith('https://') ? `${t.handle.replace(/\/?$/, '/')}feed` : `https://${t.handle}.substack.com/feed`;
    case 'youtube':
      return /^UC[\w-]{22}$/.test(t.handle) ? `https://www.youtube.com/feeds/videos.xml?channel_id=${t.handle}` : null;
    case 'feed':
      return t.handle;
    default:
      return null;
  }
}

export function laneFor(t: FollowTarget, followed: Set<string>, proven: (p: FollowPlatform) => boolean): Lane {
  if (followed.has(t.key)) return 'exists';
  if (!t.importable) return 'unsupported';
  if (FEED_PLATFORMS.has(t.platform)) return 'feed';
  // A YouTube channel id has a public feed: cheaper and steadier than running a connector.
  if (t.platform === 'youtube' && feedUrlFor(t)) return 'feed';
  if (proven(t.platform)) return 'actor';
  return 'build';
}

const display = (t: { platform: FollowPlatform; handle: string; name?: string }) => {
  const h = t.platform === 'reddit' ? `r/${t.handle}` : t.platform === 'feed' || t.handle.startsWith('https://') ? t.handle.replace(/^https:\/\//, '').replace(/\/$/, '') : t.platform === 'youtube' && /^UC/.test(t.handle) ? (t.name ?? t.handle) : `@${t.handle.replace(/^@/, '')}`;
  return h.slice(0, 100);
};
const labelFor = (t: { platform: FollowPlatform; handle: string; name?: string }) => `${(t.name && t.platform !== 'reddit' ? t.name : display(t)).slice(0, 80)} · ${PLATFORM_LABEL[t.platform]}`;

export function createFollows(deps: Deps) {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  const gap = deps.gapMs ?? ((p: FollowPlatform) => (p === 'reddit' ? 4000 : FEED_PLATFORMS.has(p) ? 600 : 1500));
  let job: FollowJob | null = store.getSetting<FollowJob>(JOB_KEY);
  let running = false;
  let saveTimer: NodeJS.Timeout | null = null;

  function save(now = false) {
    const write = () => {
      saveTimer = null;
      store.setSetting(JOB_KEY, job);
      deps.broadcast({ type: 'ui', action: { kind: 'follows-progress' } });
    };
    if (now) {
      if (saveTimer) clearTimeout(saveTimer);
      write();
    } else saveTimer ??= setTimeout(write, 700);
  }

  function actorList() {
    try {
      return deps.actors()?.list() ?? [];
    } catch {
      return [];
    }
  }

  function plan(targets: FollowTarget[]) {
    const followed = followedKeys(store);
    const actors = actorList();
    const provenBy = new Map<FollowPlatform, ReturnType<typeof provenActor>>();
    const proven = (p: FollowPlatform) => {
      if (!provenBy.has(p)) provenBy.set(p, provenActor(store, actors, p));
      return !!provenBy.get(p);
    };
    const items = targets.map((t) => ({ key: t.key, lane: laneFor(t, followed, proven) }));
    const cost = buildCostRange(store);
    const platforms: PlatformPlan[] = [];
    for (const p of [...new Set(targets.map((t) => t.platform))]) {
      const mine = targets.filter((t) => t.platform === p);
      const lanes = mine.map((t) => items.find((i) => i.key === t.key)!.lane);
      const exists = lanes.filter((l) => l === 'exists').length;
      const live = lanes.filter((l) => l !== 'exists' && l !== 'unsupported');
      const lane: Lane = lanes.every((l) => l === 'unsupported') ? 'unsupported' : live.includes('build') ? 'build' : live.includes('actor') ? 'actor' : live.length ? 'feed' : 'exists';
      const pa = provenBy.get(p);
      const how =
        lane === 'unsupported'
          ? p === 'x'
            ? 'The X archive lists account numbers, not handles, so these cannot be followed from the file. Paste profile links instead.'
            : 'These cannot be followed from this file.'
          : lane === 'exists'
            ? 'You already follow all of these.'
            : lane === 'actor'
              ? `Uses your ${PLATFORM_LABEL[p]} connector (${pa?.actor.name ?? pa?.actor.id}). No AI needed; they are added one at a time.`
              : lane === 'build'
                ? deps.aiReady()
                  ? `No ${PLATFORM_LABEL[p]} connector yet. The AI builds one for the first account (about $${cost.min.toFixed(2)} to $${cost.max.toFixed(2)}, a few minutes), then every other account reuses it at no AI cost.`
                  : `No ${PLATFORM_LABEL[p]} connector yet, and building one needs the AI. Set it up in AI settings, or these wait.`
                : p === 'youtube'
                  ? `Instant, through each channel's public feed (newest 15 videos). If YouTube refuses a feed, ${proven(p) ? 'your YouTube connector takes over' : 'the AI builds a connector instead'}.`
                  : p === 'reddit'
                    ? 'Instant, through each subreddit\'s public feed. Reddit rate-limits feeds, so they are added a few seconds apart.'
                    : 'Instant, through open feeds. No AI needed.';
      platforms.push({ platform: p, label: PLATFORM_LABEL[p], lane, how, actorId: pa?.actor.id, total: mine.length, exists });
    }
    const builds = platforms.filter((p) => p.lane === 'build').length;
    return { items, platforms, cost: { ...cost, builds, low: +(builds * cost.min).toFixed(2), high: +(builds * cost.max).toFixed(2) }, aiReady: deps.aiReady() };
  }

  function placeInProfile(sourceId: string, profileId?: string) {
    if (!profileId || profileId === ALL_PROFILE) return;
    try {
      deps.profiles.sources(profileId, { add: [sourceId] });
      // New sources join the active profile on their own; move it if the user picked another.
      const active = deps.profiles.active();
      if (active !== ALL_PROFILE && active !== profileId) deps.profiles.sources(active, { remove: [sourceId] });
    } catch (e) {
      log(`[follows] could not place source in profile: ${(e as Error).message}`);
    }
  }

  async function addOneFeed(it: FollowItem): Promise<void> {
    const t = { platform: it.platform, handle: it.handle, name: it.name };
    if (it.platform === 'bluesky') {
      const { source, result } = await deps.addFeed('bluesky-public', { handle: it.handle });
      it.sourceId = source?.id;
      it.added = result?.added ?? 0;
      if (result?.error) throw new Error(String(result.error));
      return;
    }
    const url = feedUrlFor(t);
    if (!url) throw new Error('No feed for this account');
    if (it.platform === 'feed') {
      const { source, result } = await deps.addFeed('rss', { url });
      it.sourceId = source?.id;
      it.added = result?.added ?? 0;
      if (result?.error) throw new Error(String(result.error));
      return;
    }
    // Known feed shapes skip the discovery fetch (which a rate-limited site like Reddit would
    // refuse when many arrive at once); the first sync reports any problem on the source.
    if (store.findSourceByConfig('rss', 'url', url)) throw Object.assign(new Error('Already followed'), { exists: true });
    const s = store.createSource({ connector: 'rss', label: labelFor(t), platform: it.platform, config: { url, platform: it.platform } });
    it.sourceId = s.id;
    const r = await deps.syncSource(s.id);
    it.added = r?.added ?? 0;
    if (r?.error || (r?.errors?.length && !r.added)) {
      const msg = String(r.error ?? r.errors[0]);
      // A source that never worked is removed again instead of lingering with an error.
      store.deleteSource(s.id);
      it.sourceId = undefined;
      // A refused YouTube feed falls back to a connector.
      if (it.platform === 'youtube') throw Object.assign(new Error(msg), { fallback: true });
      throw new Error(msg);
    }
  }

  async function addOneActor(it: FollowItem, pa: NonNullable<ReturnType<typeof provenActor>>): Promise<void> {
    const input = { [pa.field]: it.handle };
    const key = JSON.stringify(input);
    if (store.listSources().some((s) => s.connector === 'actor' && s.config.actorId === pa.actor.id && JSON.stringify(s.config.input) === key)) throw Object.assign(new Error('Already followed'), { exists: true });
    const many = job!.items.filter((x) => x.platform === it.platform).length > 40;
    const s = store.createSource({
      connector: 'actor',
      label: labelFor(it),
      platform: pa.actor.platform,
      config: { actorId: pa.actor.id, input, everyMinutes: many ? 180 : 60, ...(pa.coverage ? { coverage: pa.coverage } : {}), via: 'follows-import' },
    });
    it.sourceId = s.id;
    const r = await deps.syncSource(s.id);
    it.added = r?.added ?? 0;
    if (r?.error || (r?.errors?.length && !r.added)) {
      // Removed again, so a failing account neither lingers nor sets off connector repairs.
      store.deleteSource(s.id);
      it.sourceId = undefined;
      throw new Error(String(r.error ?? r.errors[0]));
    }
  }

  function startBuild(p: FollowPlatform, first: FollowItem): boolean {
    if (!deps.aiReady()) return false;
    const others = job!.items.filter((x) => x.platform === p && x !== first && (x.status === 'waiting' || x.status === 'queued')).length;
    const url = target(first.platform, first.handle)?.url;
    // The display name comes from the export file (other people's words): only the checked
    // handle goes into the builder's instructions.
    const request =
      `Follow ${display({ platform: first.platform, handle: first.handle })} on ${PLATFORM_LABEL[p]}${url ? ` (${url})` : ''}. ` +
      `This is part of a follows import: ${others} more ${PLATFORM_LABEL[p]} account${others === 1 ? '' : 's'} will reuse this connector, so write (or reuse) one actor for every ${PLATFORM_LABEL[p]} account, with manifest.platform "${p}" and the account as its only required input field (a string), and install this account with it.`;
    const { threadId } = deps.startJob({ kind: 'build', request, parentId: null, origin: 'user' });
    job!.builds[p] = { threadId, status: 'running', startedAt: new Date().toISOString() };
    first.status = 'building';
    return true;
  }

  /** After a build ends: find the source it installed for the first account, if any. */
  function claimBuiltSource(p: FollowPlatform, it: FollowItem, pa: ReturnType<typeof provenActor>) {
    if (!pa) return;
    const s = store.listSources().find((x) => x.connector === 'actor' && x.config.actorId === pa.actor.id && sourceFollowKeys(x).includes(it.key));
    if (s) {
      it.sourceId = s.id;
      it.status = 'done';
      placeInProfile(s.id, it.profileId);
    }
  }

  async function runPlatform(p: FollowPlatform) {
    const items = () => job!.items.filter((x) => x.platform === p);
    let fails = 0;
    let wins = 0;
    for (;;) {
      if (!job || job.cancelled) return;
      // A build in flight for this platform: wait for it, then hand its connector to the rest.
      const build = job.builds[p];
      if (build?.status === 'running') {
        const th = store.getThread(build.threadId);
        const over = Date.now() - Date.parse(build.startedAt) > BUILD_TIMEOUT_MS;
        if (!th || th.status === 'done' || th.status === 'error' || th.status === 'idle' || over) {
          const now = provenActor(store, actorList(), p);
          build.status = now ? 'done' : 'failed';
          const first = items().find((x) => x.status === 'building');
          if (first) {
            claimBuiltSource(p, first, now);
            if (first.status === 'building') Object.assign(first, now ? { status: 'queued', lane: 'actor' } : { status: 'failed', error: 'The AI could not build a connector for this account. Its report is in the AI panel.' });
          }
          for (const x of items()) {
            if (x.status !== 'waiting' && x.status !== 'queued') continue;
            if (now) Object.assign(x, { status: 'queued', lane: 'actor' });
            else if (x.lane !== 'feed') Object.assign(x, { status: 'blocked', error: `No working ${PLATFORM_LABEL[p]} connector: the build did not finish with a tested one.` });
          }
          save(true);
          continue;
        }
      }
      const buildRunning = job.builds[p]?.status === 'running';
      // While a build runs, open-feed accounts of the same platform keep going.
      const it = buildRunning ? items().find((x) => x.status === 'queued' && x.lane === 'feed') : items().find((x) => x.status === 'queued' || x.status === 'waiting');
      if (!it) {
        if (!buildRunning) return;
        await sleep(deps.pollMs ?? 8000);
        continue;
      }
      const pa = it.lane === 'actor' || it.lane === 'build' ? provenActor(store, actorList(), p) : null;
      if ((it.lane === 'build' || it.lane === 'actor') && !pa) {
        if (build) {
          // The platform's one build already ran and left no working connector.
          Object.assign(it, { status: 'blocked', error: `No working ${PLATFORM_LABEL[p]} connector.` });
          continue;
        }
        // No connector: build one (once per platform), then wait for it.
        if (!startBuild(p, it)) {
          for (const x of items()) if ((x.status === 'queued' || x.status === 'waiting') && x.lane !== 'feed') Object.assign(x, { status: 'blocked', error: 'Needs a connector, and building one needs the AI. Set it up in AI settings, then import again.' });
          save(true);
          continue;
        }
        for (const x of items()) if (x.status === 'queued' && x.lane !== 'feed') x.status = 'waiting';
        save(true);
        continue;
      }
      it.status = 'adding';
      save();
      try {
        if (pa && (it.lane === 'actor' || it.lane === 'build')) await addOneActor(it, pa);
        else await addOneFeed(it);
        it.status = 'done';
        wins++;
        if (it.sourceId) placeInProfile(it.sourceId, it.profileId);
      } catch (e) {
        const err = e as Error & { exists?: boolean; fallback?: boolean; status?: number };
        if (err.exists || err.status === 409 || /already connected/i.test(err.message)) Object.assign(it, { status: 'exists', error: undefined });
        else if (err.fallback) Object.assign(it, { status: 'queued', lane: 'build', error: undefined });
        else {
          Object.assign(it, { status: 'failed', error: err.message.slice(0, 200) });
          fails++;
          // The first few of a connector all failing means the connector, not the accounts.
          if (it.lane === 'actor' && wins === 0 && fails >= FAIL_FAST) {
            for (const x of items()) if (x.status === 'queued') Object.assign(x, { status: 'blocked', error: `Paused: the ${PLATFORM_LABEL[p]} connector failed for the first ${FAIL_FAST} accounts. Check it in the Workshop.` });
            save(true);
            return;
          }
        }
      }
      save();
      await sleep(gap(p));
    }
  }

  async function run() {
    if (running || !job) return;
    running = true;
    try {
      // Feeds and connectors interleave across platforms; each platform goes one at a time.
      const platforms = [...new Set(job.items.filter((x) => x.status === 'queued' || x.status === 'waiting' || x.status === 'building').map((x) => x.platform))];
      await Promise.all(platforms.map((p) => runPlatform(p).catch((e) => log(`[follows] ${p}: ${(e as Error).message}`))));
    } finally {
      running = false;
      if (job && !job.items.some((x) => ['queued', 'adding', 'waiting', 'building'].includes(x.status))) job.finishedAt ??= new Date().toISOString();
      save(true);
    }
  }

  function start(body: any): FollowJob {
    if (job && !job.finishedAt && running) throw Object.assign(new Error('An import is already running. Wait for it, or stop it first.'), { status: 409 });
    const targets = cleanTargets(body?.targets);
    if (!targets.length) throw Object.assign(new Error('Pick at least one account.'), { status: 400 });
    const groups = (body?.profiles && typeof body.profiles === 'object' ? body.profiles : {}) as Record<string, unknown>;
    const profileIds = new Set(deps.profiles.list().map((p) => p.id));
    const { items } = plan(targets);
    const lanes = new Map(items.map((i) => [i.key, i.lane]));
    job = {
      id: Math.random().toString(36).slice(2, 10),
      startedAt: new Date().toISOString(),
      builds: {},
      items: targets.map((t) => {
        const lane = lanes.get(t.key)!;
        const pid = String(groups[t.platform] ?? '');
        return {
          key: t.key,
          platform: t.platform,
          handle: t.handle,
          name: t.name,
          avatar: t.avatar,
          profileId: profileIds.has(pid) ? pid : undefined,
          lane,
          status: lane === 'exists' ? 'exists' : lane === 'unsupported' ? 'blocked' : 'queued',
          error: lane === 'unsupported' ? 'Not enough in the export to follow this account.' : undefined,
        };
      }),
    };
    save(true);
    void run();
    return job;
  }

  function cancel() {
    if (!job) return null;
    job.cancelled = true;
    for (const x of job.items) if (x.status === 'queued' || x.status === 'waiting') x.status = 'cancelled';
    for (const x of job.items) if (x.status === 'building') Object.assign(x, { status: 'cancelled', error: 'Stopped. A connector build that already started finishes in the AI panel.' });
    job.finishedAt ??= new Date().toISOString();
    save(true);
    return job;
  }

  /** Public follows of a Bluesky account, read-only through the open AppView API. */
  async function blueskyFollows(handleRaw: unknown): Promise<FollowTarget[]> {
    const me = target('bluesky', String(handleRaw ?? '').trim());
    if (!me) throw Object.assign(new Error('Enter a Bluesky handle like name.bsky.social'), { status: 400 });
    const outList: FollowTarget[] = [];
    let cursor = '';
    for (let page = 0; page < 30; page++) {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(me.handle)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await deps.fetch(url, { headers: { accept: 'application/json' }, maxBytes: 2_000_000 } as any);
      if (r.status === 400 && page === 0) throw Object.assign(new Error('Bluesky does not know that handle.'), { status: 404 });
      if (r.status >= 400) throw Object.assign(new Error(`Bluesky answered HTTP ${r.status}.`), { status: 502 });
      let data: any;
      try {
        data = JSON.parse(r.text);
      } catch {
        throw Object.assign(new Error('Bluesky sent something that is not JSON.'), { status: 502 });
      }
      for (const f of Array.isArray(data?.follows) ? data.follows : []) {
        const t = target('bluesky', String(f?.handle ?? ''), { name: f?.displayName, avatar: f?.avatar });
        if (t && t.handle !== 'handle.invalid') outList.push(t);
      }
      cursor = typeof data?.cursor === 'string' ? data.cursor : '';
      if (!cursor || outList.length >= 3000) break;
    }
    return outList;
  }

  function register(route: RouteFn, HttpError: new (status: number, msg: string) => Error) {
    const wrap = async <T>(fn: () => T | Promise<T>) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const err = e as { status?: number; message?: string };
        throw new HttpError(err.status ?? 500, err.message ?? 'Failed');
      }
    };
    route('POST', '/api/follows/plan', (_q, _s, _p, body) => wrap(() => plan(cleanTargets(body?.targets))));
    route('POST', '/api/follows/bluesky', (_q, _s, _p, body) => wrap(async () => ({ targets: await blueskyFollows(body?.handle) })));
    route('POST', '/api/follows/start', (_q, _s, _p, body) => wrap(() => ({ job: start(body) })));
    route('GET', '/api/follows/job', () => ({ job, running }));
    route('POST', '/api/follows/cancel', () => ({ job: cancel() }));
    route('POST', '/api/follows/clear', () => wrap(() => {
      if (running && job && !job.finishedAt) throw Object.assign(new Error('Stop the import first.'), { status: 409 });
      job = null;
      save(true);
      return { ok: true };
    }));
  }

  // An import interrupted by a restart picks up where it stopped (builds in flight are re-checked).
  function resume() {
    if (!job || job.finishedAt || job.cancelled) return;
    for (const x of job.items) if (x.status === 'adding') x.status = 'queued';
    setTimeout(() => void run(), 4000).unref?.();
  }

  return { plan, start, cancel, register, resume, run, blueskyFollows, current: () => job };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
