// Friends, part two: the weekly list of saved posts, shared collections and suggested
// connectors. See docs/social.md. Everything here rides the same signed, sealed, padded and
// replay-checked envelopes as shares (crypto.ts), and follows the same rules:
//
// - Nothing is sent without a deliberate act. The weekly list is off for every friend until you
//   turn it on, and the first list only goes out after you have seen exactly what is in it.
//   Collections go out only when you share them. A connector goes out only when you suggest it.
// - Everything is revocable. Turning the weekly list off, or unsharing a collection, sends a
//   tombstone; the friend's Aurora deletes what you sent. (A modified Aurora could keep a copy:
//   sharing is trust, and the UI says so.)
// - Everything received is untrusted plain text, capped, with no remote images. A suggested
//   connector is saved as an untested import at most, by hand: it never runs until it passes
//   a test run in the sandbox, like any connector file.

import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../db.ts';
import type { Item, Profile } from '../../core/types.ts';
import type { ActorStore } from '../actors/store.ts';
import { BUNDLE_FORMAT, importBundle } from '../actorBundles.ts';
import { ACTOR_ID_RE } from '../actors/store.ts';
import { epochOf, MAX_PLAINTEXT } from './crypto.ts';

export interface FriendLike {
  fp: string;
  handle: string;
  nickname: string | null;
  status: string;
}

export interface ExtrasCtx<F extends FriendLike> {
  store: Store;
  HttpError: new (status: number, message: string) => Error;
  friend: (fp: string) => F | null;
  friendName: (f: F) => string;
  enqueue: (to: F, type: string, payload: unknown) => unknown;
  clean: (s: unknown, max: number) => string;
  cleanUrl: (s: unknown) => string | null;
  friendsSourceId: () => string;
  circleMembers: (circleId: string) => string[];
  profiles: () => Profile[];
  /** The profile a friend's circles map to, used as the default weekly-list scope. */
  profileOf?: (fp: string) => string | null;
  actorStore: () => ActorStore | null;
  changed: (reason: string) => void;
}

/** One post in a weekly list or a shared collection, as it travels: plain text, capped. */
export interface Entry {
  id: string;
  title: string;
  text: string;
  url: string | null;
  author: { name: string; handle: string };
  platform: string;
  kind: Item['kind'];
  at: string;
}

export const EXTRA_TYPES = new Set(['digest', 'digest_off', 'coll', 'coll_off', 'connector']);
const DIGEST_MAX = 25;
const COLL_MAX = 100;
const DIGESTS_KEPT = 8;
const COLLS_PER_FRIEND = 30;
const RECS_PER_FRIEND = 20;
const CONNECTOR_CODE_MAX = 180_000;
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['post', 'reply', 'repost', 'thread', 'article', 'video']);
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const WEEK_MS = 7 * 24 * 3600_000;
// The signed body travels base64-encoded inside the padded plaintext (crypto.ts seal), so a body
// can use about three quarters of the largest padding bucket, less the keys and signature.
export const BODY_BUDGET = Math.floor(((MAX_PLAINTEXT - 1024) * 3) / 4);

type RouteFn = (method: string, path: string, handler: (req: any, res: any, params: Record<string, string>, body: any, url: URL) => unknown) => void;

export function createExtras<F extends FriendLike>(ctx: ExtrasCtx<F>) {
  const { store, HttpError, clean, cleanUrl } = ctx;
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_digest_out (
      fp TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'all',
      confirmed_at TEXT, last_sent_at TEXT, last_week INTEGER);
    CREATE TABLE IF NOT EXISTS social_digest_skip (item_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS social_digest_in (
      peer_fp TEXT NOT NULL, week INTEGER NOT NULL, entries TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (peer_fp, week));
    CREATE TABLE IF NOT EXISTS social_digest_mute (fp TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS social_coll_out (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, recipients TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_coll_in (
      peer_fp TEXT NOT NULL, coll_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, entries TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (peer_fp, coll_id));
    CREATE TABLE IF NOT EXISTS social_recs (
      id TEXT PRIMARY KEY, peer_fp TEXT NOT NULL, note TEXT NOT NULL, summary TEXT NOT NULL, bundle TEXT NOT NULL,
      at TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT);
  `);

  const live = (fp: string) => {
    const f = ctx.friend(fp);
    return f && f.status === 'friend' ? f : null;
  };
  const nameOf = (fp: string) => {
    const f = ctx.friend(fp);
    return f ? ctx.friendName(f) : 'Removed friend';
  };

  // ------------------------------------------------------------ entries

  function entryOf(it: Item, textMax: number): Entry {
    return {
      // A stable id that does not reveal local ids (which can carry source ids).
      id: createHash('sha256').update(`aurora-entry\0${it.id}`).digest('hex').slice(0, 24),
      title: clean(it.title, 300),
      text: clean(it.text, textMax),
      url: cleanUrl(it.url),
      author: { name: clean(it.author.name, 100), handle: clean(it.author.handle, 100) },
      platform: PLATFORM_RE.test(it.platform) ? it.platform : 'web',
      kind: it.kind,
      at: it.publishedAt,
    };
  }

  /** The receiving side: rebuild an entry from untrusted input, or drop it. */
  function entryFrom(raw: unknown, textMax: number): Entry | null {
    const e = raw as Record<string, any>;
    if (!e || typeof e !== 'object') return null;
    const id = clean(e.id, 64);
    if (!ID_RE.test(id)) return null;
    const platform = clean(e.platform, 40).toLowerCase();
    const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
    const out: Entry = {
      id,
      title: clean(e.title, 300),
      text: clean(e.text, textMax),
      url: cleanUrl(e.url),
      author: { name: clean(e.author?.name, 100), handle: clean(e.author?.handle, 100) },
      platform: PLATFORM_RE.test(platform) ? platform : 'web',
      kind: KINDS.has(e.kind) ? e.kind : 'post',
      at,
    };
    return out.title || out.text || out.url ? out : null;
  }

  const entriesFrom = (raw: unknown, max: number, textMax: number) =>
    (Array.isArray(raw) ? raw : []).slice(0, max).map((e) => entryFrom(e, textMax)).filter((e): e is Entry => Boolean(e));

  /** Posts that may go to a friend at all: never a friend's own share, never demo data. */
  const shareable = (it: Item) => it.provenance.connector !== 'friends' && !it.isDemo;

  // ------------------------------------------------------------ weekly list: sending

  interface DigestOut {
    fp: string;
    enabled: number;
    auto: number;
    scope: string;
    confirmed_at: string | null;
    last_sent_at: string | null;
    last_week: number | null;
  }
  const digestOut = (fp: string): DigestOut =>
    (db.prepare('SELECT * FROM social_digest_out WHERE fp = ?').get(fp) as DigestOut | undefined) ?? { fp, enabled: 0, auto: 0, scope: defaultScope(fp), confirmed_at: null, last_sent_at: null, last_week: null };
  // A friend in a circle mapped to a profile starts with that profile's sources, not the whole library.
  const defaultScope = (fp: string) => {
    const p = ctx.profileOf?.(fp);
    return p && ctx.profiles().some((x) => x.id === p) ? p : 'all';
  };
  /** Sources read through a signed-in browser session: their posts are often friends-only or private. */
  const signedInSources = () => {
    const as = ctx.actorStore();
    if (!as) return new Set<string>();
    return new Set(store.listSources().filter((s) => s.connector === 'actor' && as.get(String(s.config.actorId ?? ''))?.manifest.tier === 'session').map((s) => s.id));
  };
  const skipped = () => new Set((db.prepare('SELECT item_id FROM social_digest_skip').all() as { item_id: string }[]).map((r) => r.item_id));

  /** Exactly what the next list to this friend would hold. Sending recomputes it and only keeps posts the user saw here. */
  function digestCandidates(d: DigestOut) {
    const since = d.last_sent_at ? Date.parse(d.last_sent_at) : Date.now() - WEEK_MS;
    const skip = skipped();
    const profile = d.scope !== 'all' ? ctx.profiles().find((p) => p.id === d.scope) : null;
    const inScope = profile ? new Set(profile.sourceIds) : null;
    // The weekly list is everything saved, and can go out on its own: never include posts that came
    // through a signed-in session, which may be someone else's private post. Share those by hand.
    const signedIn = signedInSources();
    return store
      .listItems()
      .filter((it) => it.state.saved && it.state.savedAt && Date.parse(it.state.savedAt) > since && shareable(it) && !skip.has(it.id) && (!inScope || inScope.has(it.sourceId)) && !signedIn.has(it.sourceId))
      .sort((a, b) => Date.parse(b.state.savedAt!) - Date.parse(a.state.savedAt!))
      .slice(0, DIGEST_MAX);
  }

  function digestPreview(fp: string) {
    const d = digestOut(fp);
    const items = digestCandidates(d);
    return {
      fp,
      name: nameOf(fp),
      enabled: Boolean(d.enabled),
      auto: Boolean(d.auto),
      scope: d.scope,
      confirmed: Boolean(d.confirmed_at),
      lastSentAt: d.last_sent_at,
      sentThisWeek: d.last_week === epochOf(),
      since: d.last_sent_at ?? new Date(Date.now() - WEEK_MS).toISOString(),
      entries: items.map((it) => ({ itemId: it.id, title: clean(it.title, 300) || clean(it.text, 140), author: clean(it.author.name, 100), platform: it.platform, url: cleanUrl(it.url), savedAt: it.state.savedAt })),
    };
  }

  function sendDigest(f: F, items: Item[]) {
    const d = digestOut(f.fp);
    const week = epochOf();
    const entries = items.map((it) => entryOf(it, 600));
    ctx.enqueue(f, 'digest', { week, entries });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO social_digest_out(fp, enabled, auto, scope, confirmed_at, last_sent_at, last_week) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(fp) DO UPDATE SET confirmed_at = coalesce(social_digest_out.confirmed_at, excluded.confirmed_at), last_sent_at = excluded.last_sent_at, last_week = excluded.last_week`,
    ).run(f.fp, d.enabled, d.auto, d.scope, now, now, week);
    return entries.length;
  }

  /** Called from the social loop: automatic weekly lists, only for friends who confirmed one by hand before. */
  let lastTick = 0;
  function tick(force = false) {
    // The loop runs every few seconds; reading the whole library that often is wasteful.
    if (!force && Date.now() - lastTick < 60_000) return;
    lastTick = Date.now();
    const week = epochOf();
    const due = db.prepare("SELECT * FROM social_digest_out WHERE enabled = 1 AND auto = 1 AND confirmed_at IS NOT NULL AND (last_week IS NULL OR last_week < ?)").all(week) as unknown as DigestOut[];
    for (const d of due) {
      const f = live(d.fp);
      if (!f) continue;
      const items = digestCandidates(d);
      // An empty week sends nothing, and the next list still covers everything since the last one.
      if (items.length) sendDigest(f, items);
    }
    syncCollections();
  }

  // ------------------------------------------------------------ shared collections: sending

  interface CollOut {
    id: string;
    name: string;
    recipients: string;
    version: number;
    hash: string;
    created_at: string;
    updated_at: string;
  }

  function collectionEntries(name: string) {
    const items = store
      .listItems()
      .filter((it) => it.state.collections.includes(name) && shareable(it))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    let entries = items.slice(0, COLL_MAX).map((it) => entryOf(it, 400));
    // Keep the sealed message under the largest padding bucket, with room for the envelope.
    while (entries.length && Buffer.byteLength(JSON.stringify(entries)) > BODY_BUDGET - 4_000) entries = entries.slice(0, Math.floor(entries.length * 0.85));
    return { entries, truncated: entries.length < items.length };
  }

  const hashOf = (name: string, entries: Entry[]) => JSON.stringify([name, entries.map((e) => [e.id, e.title, e.text.length, e.url])]);

  function sendCollection(c: CollOut, to: string[], entries: Entry[], truncated: boolean) {
    for (const fp of to) {
      const f = live(fp);
      if (f) ctx.enqueue(f, 'coll', { collId: c.id, name: c.name, version: c.version, entries, truncated });
    }
  }

  /** A shared collection is a living share: when its posts change, friends get the new version. */
  function syncCollections() {
    const known = new Set(store.listCollections());
    for (const c of db.prepare('SELECT * FROM social_coll_out').all() as unknown as CollOut[]) {
      const recips = JSON.parse(c.recipients) as string[];
      if (!known.has(c.name)) {
        // The collection was deleted here: tell friends it is gone.
        for (const fp of recips) {
          const f = live(fp);
          if (f) ctx.enqueue(f, 'coll_off', { collId: c.id });
        }
        db.prepare('DELETE FROM social_coll_out WHERE id = ?').run(c.id);
        continue;
      }
      const { entries, truncated } = collectionEntries(c.name);
      const h = hashOf(c.name, entries);
      if (h === c.hash) continue;
      const next = { ...c, version: c.version + 1, hash: h, updated_at: new Date().toISOString() };
      db.prepare('UPDATE social_coll_out SET version = ?, hash = ?, updated_at = ? WHERE id = ?').run(next.version, h, next.updated_at, c.id);
      sendCollection(next, recips, entries, truncated);
    }
  }

  function targetsOf(body: any): F[] {
    const fps = new Set<string>(Array.isArray(body?.friends) ? body.friends.filter((x: unknown) => typeof x === 'string') : []);
    for (const cid of Array.isArray(body?.circles) ? body.circles : []) for (const fp of ctx.circleMembers(String(cid))) fps.add(fp);
    return [...fps].map(live).filter((f): f is F => Boolean(f));
  }

  // ------------------------------------------------------------ receiving

  function receive(f: F, type: string, ts: number, p: Record<string, unknown>): boolean {
    const at = new Date(Math.min(ts, Date.now())).toISOString();
    if (type === 'digest') {
      if (db.prepare('SELECT 1 FROM social_digest_mute WHERE fp = ?').get(f.fp)) return false;
      const week = Number(p.week);
      if (!Number.isInteger(week) || Math.abs(week - epochOf()) > 3) return false;
      const entries = entriesFrom(p.entries, DIGEST_MAX, 600);
      if (!entries.length) return false;
      db.prepare('INSERT INTO social_digest_in(peer_fp, week, entries, note, at) VALUES(?,?,?,?,?) ON CONFLICT(peer_fp, week) DO UPDATE SET entries = excluded.entries, at = excluded.at, seen = 0').run(
        f.fp, week, JSON.stringify(entries), '', at,
      );
      db.prepare('DELETE FROM social_digest_in WHERE peer_fp = ? AND week NOT IN (SELECT week FROM social_digest_in WHERE peer_fp = ? ORDER BY week DESC LIMIT ?)').run(f.fp, f.fp, DIGESTS_KEPT);
      return true;
    }
    if (type === 'digest_off') {
      db.prepare('DELETE FROM social_digest_in WHERE peer_fp = ?').run(f.fp);
      return true;
    }
    if (type === 'coll') {
      const collId = clean(p.collId, 64);
      const version = Number(p.version);
      const name = clean(p.name, 80);
      if (!ID_RE.test(collId) || !Number.isInteger(version) || version < 1 || !name) return false;
      const cur = db.prepare('SELECT version FROM social_coll_in WHERE peer_fp = ? AND coll_id = ?').get(f.fp, collId) as { version: number } | undefined;
      if (cur && cur.version >= version) return false;
      if (!cur && (db.prepare('SELECT COUNT(*) AS n FROM social_coll_in WHERE peer_fp = ?').get(f.fp) as { n: number }).n >= COLLS_PER_FRIEND) return false;
      const entries = entriesFrom(p.entries, COLL_MAX, 400);
      db.prepare(
        `INSERT INTO social_coll_in(peer_fp, coll_id, name, version, entries, truncated, at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(peer_fp, coll_id) DO UPDATE SET name = excluded.name, version = excluded.version, entries = excluded.entries, truncated = excluded.truncated, at = excluded.at, seen = 0`,
      ).run(f.fp, collId, name, version, JSON.stringify(entries), p.truncated ? 1 : 0, at);
      return true;
    }
    if (type === 'coll_off') {
      const collId = clean(p.collId, 64);
      return Number(db.prepare('DELETE FROM social_coll_in WHERE peer_fp = ? AND coll_id = ?').run(f.fp, collId).changes) > 0;
    }
    if (type === 'connector') {
      const recId = clean(p.recId, 64);
      if (!ID_RE.test(recId)) return false;
      const id = `${f.fp.slice(0, 16)}-${recId}`;
      if (db.prepare('SELECT 1 FROM social_recs WHERE id = ?').get(id)) return false;
      if ((db.prepare("SELECT COUNT(*) AS n FROM social_recs WHERE peer_fp = ? AND status = 'new'").get(f.fp) as { n: number }).n >= RECS_PER_FRIEND) return false;
      const b = p.bundle as Record<string, any>;
      const m = b?.manifest as Record<string, any>;
      if (!b || b.format !== BUNDLE_FORMAT || b.formatVersion !== 1 || !m || typeof m.id !== 'string' || !ACTOR_ID_RE.test(m.id) || typeof b.code !== 'string' || !b.code.trim() || b.code.length > CONNECTOR_CODE_MAX)
        return false;
      // What the card shows, rebuilt as capped plain text. The bundle itself is only ever handed to the importer.
      const summary = {
        id: m.id,
        name: clean(m.name, 80) || m.id,
        description: clean(m.description, 400),
        platform: PLATFORM_RE.test(String(m.platform ?? '')) ? String(m.platform) : 'web',
        runtime: m.runtime === 'python' ? 'python' : 'node',
        tier: clean(m.tier, 20),
        hosts: (Array.isArray(m.hosts) ? m.hosts : []).slice(0, 12).map((h: unknown) => clean(h, 120)).filter(Boolean),
        lines: b.code.split('\n').length,
      };
      db.prepare('INSERT INTO social_recs(id, peer_fp, note, summary, bundle, at, status) VALUES(?,?,?,?,?,?,?)').run(id, f.fp, clean(p.note, 1000), JSON.stringify(summary), JSON.stringify({ format: b.format, formatVersion: 1, exportedAt: clean(b.exportedAt, 40), manifest: m, code: b.code }), at, 'new');
      return true;
    }
    return false;
  }

  /** A friend was removed or blocked: forget everything they sent and stop sending to them. */
  function forget(fp: string) {
    db.prepare('DELETE FROM social_digest_in WHERE peer_fp = ?').run(fp);
    db.prepare('DELETE FROM social_coll_in WHERE peer_fp = ?').run(fp);
    db.prepare('DELETE FROM social_recs WHERE peer_fp = ?').run(fp);
    db.prepare('DELETE FROM social_digest_out WHERE fp = ?').run(fp);
    db.prepare('DELETE FROM social_digest_mute WHERE fp = ?').run(fp);
    for (const c of db.prepare('SELECT id, recipients FROM social_coll_out').all() as { id: string; recipients: string }[]) {
      const rest = (JSON.parse(c.recipients) as string[]).filter((x) => x !== fp);
      if (rest.length) db.prepare('UPDATE social_coll_out SET recipients = ? WHERE id = ?').run(JSON.stringify(rest), c.id);
      else db.prepare('DELETE FROM social_coll_out WHERE id = ?').run(c.id);
    }
  }

  // ------------------------------------------------------------ views

  function inbox() {
    const digests = (db.prepare('SELECT * FROM social_digest_in ORDER BY week DESC, at DESC LIMIT 40').all() as any[]).map((d) => ({
      peer: d.peer_fp,
      name: nameOf(d.peer_fp),
      week: Number(d.week),
      at: d.at,
      seen: Boolean(d.seen),
      thisWeek: Number(d.week) >= epochOf() - 1,
      entries: JSON.parse(d.entries) as Entry[],
    }));
    const collections = (db.prepare('SELECT * FROM social_coll_in ORDER BY at DESC').all() as any[]).map((c) => ({
      peer: c.peer_fp,
      name: nameOf(c.peer_fp),
      collId: c.coll_id,
      title: c.name,
      version: Number(c.version),
      at: c.at,
      seen: Boolean(c.seen),
      truncated: Boolean(c.truncated),
      entries: JSON.parse(c.entries) as Entry[],
    }));
    const recs = (db.prepare("SELECT * FROM social_recs WHERE status != 'dismissed' ORDER BY at DESC").all() as any[]).map((r) => ({
      id: r.id,
      peer: r.peer_fp,
      name: nameOf(r.peer_fp),
      note: r.note,
      at: r.at,
      status: r.status as 'new' | 'imported',
      actorId: r.actor_id as string | null,
      connector: JSON.parse(r.summary),
    }));
    const muted = (db.prepare('SELECT fp FROM social_digest_mute').all() as { fp: string }[]).map((r) => r.fp);
    return { digests, collections, recs, muted };
  }

  function summary() {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      inboxNew: n('SELECT COUNT(*) AS n FROM social_digest_in WHERE seen = 0') + n('SELECT COUNT(*) AS n FROM social_coll_in WHERE seen = 0') + n("SELECT COUNT(*) AS n FROM social_recs WHERE status = 'new'"),
      digestsOn: (db.prepare('SELECT fp FROM social_digest_out WHERE enabled = 1').all() as { fp: string }[]).map((r) => r.fp),
    };
  }

  function outgoing() {
    return (db.prepare('SELECT * FROM social_coll_out ORDER BY updated_at DESC').all() as unknown as CollOut[]).map((c) => {
      const recips = JSON.parse(c.recipients) as string[];
      return { id: c.id, name: c.name, version: c.version, updatedAt: c.updated_at, recipients: recips.map((fp) => ({ fp, name: nameOf(fp) })) };
    });
  }

  /** Friend shares that a profile shows: circles mapped to a profile route their members' shares there. */
  function routing(circles: { profile: string | null; members: string[] }[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const c of circles) if (c.profile) (out[c.profile] ??= []).push(...c.members.map((fp) => fp.slice(0, 16)));
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
    return out;
  }

  // ------------------------------------------------------------ routes

  function register(route: RouteFn) {
    // Weekly list, sender side.
    route('GET', '/api/social/digest/:fp', (_q, _s, p) => {
      if (!live(p.fp)) throw new HttpError(404, 'No such friend');
      return digestPreview(p.fp);
    });

    route('PATCH', '/api/social/digest/:fp', (_q, _s, p, body) => {
      const f = live(p.fp);
      if (!f) throw new HttpError(404, 'No such friend');
      const d = digestOut(f.fp);
      const enabled = body?.enabled === undefined ? Boolean(d.enabled) : Boolean(body.enabled);
      const auto = body?.auto === undefined ? Boolean(d.auto) : Boolean(body.auto);
      let scope = d.scope;
      if (body?.scope !== undefined) {
        const s = String(body.scope);
        if (s !== 'all' && !ctx.profiles().some((x) => x.id === s)) throw new HttpError(400, 'No such profile');
        scope = s;
      }
      // Automatic sending needs one list confirmed by hand first, so the first send is always seen.
      if (auto && !d.confirmed_at) throw new HttpError(409, 'Send the first list yourself, so you see exactly what goes out. Then it can go weekly on its own.');
      db.prepare(
        `INSERT INTO social_digest_out(fp, enabled, auto, scope) VALUES(?,?,?,?)
         ON CONFLICT(fp) DO UPDATE SET enabled = excluded.enabled, auto = excluded.auto, scope = excluded.scope`,
      ).run(f.fp, +enabled, +(enabled && auto), scope);
      if (d.enabled && !enabled) {
        // Turning it off is a revocation: their Aurora deletes the lists you sent.
        ctx.enqueue(f, 'digest_off', {});
        db.prepare('UPDATE social_digest_out SET confirmed_at = NULL, auto = 0 WHERE fp = ?').run(f.fp);
      }
      return digestPreview(f.fp);
    });

    route('POST', '/api/social/digest/:fp/send', (_q, _s, p, body) => {
      const f = live(p.fp);
      if (!f) throw new HttpError(404, 'No such friend');
      const d = digestOut(f.fp);
      if (!d.enabled) throw new HttpError(409, 'Turn on the weekly list for this friend first');
      if (d.last_week === epochOf()) throw new HttpError(409, 'This week’s list already went out. The next one can go next week.');
      // Only posts the user was shown and kept ticked: the server recomputes the list and intersects.
      const picked = new Set<string>(Array.isArray(body?.itemIds) ? body.itemIds.filter((x: unknown) => typeof x === 'string') : []);
      const items = digestCandidates(d).filter((it) => picked.has(it.id));
      if (!items.length) throw new HttpError(400, 'Nothing to send: tick at least one post');
      const n = sendDigest(f, items);
      return { ...digestPreview(f.fp), sent: n };
    });

    route('POST', '/api/social/digest-skip', (_q, _s, _p, body) => {
      const id = String(body?.itemId ?? '');
      if (!store.getItem(id)) throw new HttpError(404, 'No such post');
      if (body?.skip === false) db.prepare('DELETE FROM social_digest_skip WHERE item_id = ?').run(id);
      else db.prepare('INSERT OR IGNORE INTO social_digest_skip(item_id) VALUES(?)').run(id);
      return { ok: true };
    });

    // Weekly list, receiver side: hide (and delete) a friend's lists, or show them again.
    route('POST', '/api/social/digest-mute/:fp', (_q, _s, p, body) => {
      if (!ctx.friend(p.fp)) throw new HttpError(404, 'No such friend');
      if (body?.muted === false) db.prepare('DELETE FROM social_digest_mute WHERE fp = ?').run(p.fp);
      else {
        db.prepare('INSERT OR IGNORE INTO social_digest_mute(fp) VALUES(?)').run(p.fp);
        db.prepare('DELETE FROM social_digest_in WHERE peer_fp = ?').run(p.fp);
      }
      return inbox();
    });

    // Shared collections, sender side.
    route('GET', '/api/social/collections', () => ({ outgoing: outgoing(), local: store.listCollections() }));

    route('POST', '/api/social/collections', (_q, _s, _p, body) => {
      const name = String(body?.name ?? '');
      if (!store.listCollections().includes(name)) throw new HttpError(404, 'No such collection');
      const targets = targetsOf(body);
      if (!targets.length) throw new HttpError(400, 'Pick at least one friend');
      const existing = db.prepare('SELECT * FROM social_coll_out WHERE name = ?').get(name) as CollOut | undefined;
      const { entries, truncated } = collectionEntries(name);
      if (!entries.length) throw new HttpError(400, 'That collection has nothing in it that can be shared yet');
      const now = new Date().toISOString();
      const before = existing ? (JSON.parse(existing.recipients) as string[]) : [];
      const recips = [...new Set([...before, ...targets.map((t) => t.fp)])];
      const c: CollOut = existing
        ? { ...existing, recipients: JSON.stringify(recips), hash: hashOf(name, entries), updated_at: now }
        : { id: randomUUID(), name, recipients: JSON.stringify(recips), version: 1, hash: hashOf(name, entries), created_at: now, updated_at: now };
      db.prepare(
        `INSERT INTO social_coll_out(id, name, recipients, version, hash, created_at, updated_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET recipients = excluded.recipients, hash = excluded.hash, updated_at = excluded.updated_at`,
      ).run(c.id, c.name, c.recipients, c.version, c.hash, c.created_at, c.updated_at);
      // New recipients get the current version; existing ones already have it (or get it on the next change).
      sendCollection(c, existing ? recips.filter((fp) => !before.includes(fp)) : recips, entries, truncated);
      return { outgoing: outgoing(), local: store.listCollections(), sentTo: targets.filter((t) => !before.includes(t.fp)).map(ctx.friendName) };
    });

    route('POST', '/api/social/collections/:id/unshare', (_q, _s, p, body) => {
      const c = db.prepare('SELECT * FROM social_coll_out WHERE id = ?').get(p.id) as CollOut | undefined;
      if (!c) throw new HttpError(404, 'No such shared collection');
      const recips = JSON.parse(c.recipients) as string[];
      const drop = typeof body?.fp === 'string' ? recips.filter((x) => x === body.fp) : recips;
      for (const fp of drop) {
        const f = live(fp);
        if (f) ctx.enqueue(f, 'coll_off', { collId: c.id });
      }
      const rest = recips.filter((x) => !drop.includes(x));
      if (rest.length) db.prepare('UPDATE social_coll_out SET recipients = ? WHERE id = ?').run(JSON.stringify(rest), c.id);
      else db.prepare('DELETE FROM social_coll_out WHERE id = ?').run(c.id);
      return { outgoing: outgoing(), local: store.listCollections() };
    });

    // Suggest a connector, sender side.
    route('POST', '/api/social/recommend', (_q, _s, _p, body) => {
      const as = ctx.actorStore();
      if (!as) throw new HttpError(404, 'The connector runtime is not available');
      const got = as.get(String(body?.actorId ?? ''));
      if (!got) throw new HttpError(404, 'No such connector');
      if (got.code.length > CONNECTOR_CODE_MAX) throw new HttpError(413, 'This connector is too big to send to a friend. Export it as a file instead.');
      const targets = targetsOf(body);
      if (!targets.length) throw new HttpError(400, 'Pick at least one friend');
      const bundle = { format: BUNDLE_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), manifest: got.manifest, code: got.code };
      const note = clean(body?.note, 1000);
      if (Buffer.byteLength(JSON.stringify({ recId: randomUUID(), bundle, note })) > BODY_BUDGET) throw new HttpError(413, 'This connector is too big to send to a friend. Export it as a file instead.');
      const recId = randomUUID();
      for (const t of targets) ctx.enqueue(t, 'connector', { recId, note, bundle });
      return { ok: true, sentTo: targets.map(ctx.friendName) };
    });

    // Inbox: weekly lists, collections and suggestions from friends.
    route('GET', '/api/social/inbox', () => inbox());

    route('POST', '/api/social/inbox/seen', () => {
      db.prepare('UPDATE social_digest_in SET seen = 1 WHERE seen = 0').run();
      db.prepare('UPDATE social_coll_in SET seen = 1 WHERE seen = 0').run();
      return { ok: true };
    });

    route('POST', '/api/social/inbox/keep', (_q, _s, _p, body) => {
      const peer = String(body?.peer ?? '');
      const f = ctx.friend(peer);
      if (!f) throw new HttpError(404, 'No such friend');
      let list: Entry[] = [];
      if (body?.kind === 'digest') {
        const row = db.prepare('SELECT entries FROM social_digest_in WHERE peer_fp = ? AND week = ?').get(peer, Number(body?.week)) as { entries: string } | undefined;
        list = row ? JSON.parse(row.entries) : [];
      } else {
        const row = db.prepare('SELECT entries FROM social_coll_in WHERE peer_fp = ? AND coll_id = ?').get(peer, String(body?.collId ?? '')) as { entries: string } | undefined;
        list = row ? JSON.parse(row.entries) : [];
      }
      const e = list.find((x) => x.id === body?.entryId);
      if (!e) throw new HttpError(404, 'That post is no longer there');
      // Kept posts become ordinary saved posts from the Friends source, still plain text, still never re-shareable.
      const itemId = `aurora:${f.fp.slice(0, 16)}-k-${e.id}`.slice(0, 120);
      const now = new Date().toISOString();
      store.upsertItem({
        id: itemId,
        sourceId: ctx.friendsSourceId(),
        platform: e.platform,
        externalId: itemId.slice('aurora:'.length),
        url: e.url ?? '',
        author: { name: e.author.name || e.platform, handle: e.author.handle || undefined },
        title: e.title || undefined,
        text: e.text,
        links: e.url ? [e.url] : [],
        media: [],
        kind: e.kind,
        publishedAt: e.at,
        ingestedAt: now,
        provenance: { connector: 'friends', connectorVersion: 1, via: 'friend' },
        dedupeKey: e.url ?? itemId,
        isDemo: false,
      });
      store.patchState([itemId], { saved: true });
      ctx.changed('friends');
      return { ok: true, itemId };
    });

    route('POST', '/api/social/recs/:id/import', (_q, _s, p) => {
      const as = ctx.actorStore();
      if (!as) throw new HttpError(404, 'The connector runtime is not available');
      const r = db.prepare('SELECT * FROM social_recs WHERE id = ?').get(p.id) as any;
      if (!r) throw new HttpError(404, 'No such suggestion');
      if (r.status === 'imported' && r.actor_id && as.get(r.actor_id)) return { ok: true, actorId: r.actor_id, already: true };
      const out = importBundle(as, JSON.parse(r.bundle), {
        HttpError,
        maxCode: CONNECTOR_CODE_MAX,
        note: `Suggested by ${nameOf(r.peer_fp)} through Aurora Friends on ${new Date().toISOString().slice(0, 10)}${r.note ? `: "${String(r.note).slice(0, 200)}"` : ''}. Not tested here yet.`,
      });
      db.prepare("UPDATE social_recs SET status = 'imported', actor_id = ? WHERE id = ?").run(out.manifest.id, p.id);
      return { ok: true, actorId: out.manifest.id, renamed: out.renamed };
    });

    route('POST', '/api/social/recs/:id/dismiss', (_q, _s, p) => {
      db.prepare("UPDATE social_recs SET status = 'dismissed', bundle = '{}' WHERE id = ?").run(p.id);
      return inbox();
    });
  }

  return { receive, forget, tick, register, summary, routing, inbox };
}
