// Friends: private, end-to-end encrypted sharing between Aurora instances. See docs/social.md.
//
// Nothing leaves this instance unless the user shares it on purpose. Friendship needs both
// sides: one person makes a single-use invite, the other opens it, and the first accepts. Every
// message is signed and sealed (crypto.ts) and posted to the recipient's relay (relay.ts), which
// sees only ciphertext addressed to rotating mailbox ids. Everything received is untrusted data:
// it is size-capped, stripped to plain text and stored as an ordinary post from the "Friends"
// source, so the reader renders it like any other post and the AI wraps it like any other post.
//
// Tables are social_* and created here, so this module does not touch the main schema version.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Store } from '../db.ts';
import type { Item, Profile } from '../../core/types.ts';
import type { ActorStore } from '../actors/store.ts';
import { safeHttpUrl } from '../../core/normalize.ts';
import { safeFetch } from '../safeFetch.ts';
import * as C from './crypto.ts';
import { startRelay, type RelayHandle } from './relay.ts';
import { createExtras, EXTRA_TYPES } from './extras.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

export interface SocialDeps {
  store: Store;
  dataDir: string;
  changed: (reason: string) => void;
  log: (m: string) => void;
  HttpError: new (status: number, message: string) => Error;
  /** Profiles, so a weekly list can be limited to one profile's sources. */
  profiles?: () => Profile[];
  /** The connector store, for suggesting and importing connectors. Null when the runtime is off. */
  actorStore?: () => ActorStore | null;
}

type FriendStatus = 'pending_in' | 'pending_out' | 'friend' | 'blocked';
interface FriendRow {
  fp: string;
  sign_pub: string;
  enc_pub: string;
  handle: string;
  nickname: string | null;
  relay: string;
  status: FriendStatus;
  created_at: string;
  updated_at: string;
}
interface Snapshot {
  title: string;
  text: string;
  url: string | null;
  author: { name: string; handle: string };
  platform: string;
  publishedAt: string;
  kind: Item['kind'];
  links: string[];
}

export const REACTIONS = ['❤️', '👍', '😂', '😮', '🤔', '🔥'];
const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['post', 'reply', 'repost', 'thread', 'article', 'video']);
const INVITE_PREFIX = 'aurora:invite/v1/';
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const OUTBOX_MAX_AGE_MS = 10 * 24 * 3600_000;
const INCOMING_PER_DAY = 500;
const POLL_MS = Math.max(5, Number(process.env.SOCIAL_POLL_SECONDS ?? 15)) * 1000;

/** Plain text only: control, zero-width and bidi-override characters go, length is capped. */
export function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .slice(0, max)
    .trim();
}
export const cleanUrl = (s: unknown) => (typeof s === 'string' && s.length <= 2000 ? safeHttpUrl(s) : null);

function normalizeRelay(raw: unknown): string | null {
  const u = cleanUrl(raw);
  if (!u || u.length > 300) return null;
  const p = new URL(u);
  if (p.search || p.hash) return null;
  return `${p.origin}${p.pathname.replace(/\/+$/, '')}`;
}

export function createSocial(deps: SocialDeps) {
  const { store, HttpError } = deps;
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_friends (
      fp TEXT PRIMARY KEY, sign_pub TEXT NOT NULL, enc_pub TEXT NOT NULL, handle TEXT NOT NULL, nickname TEXT,
      relay TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_invites (
      id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT);
    CREATE TABLE IF NOT EXISTS social_circles (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_circle_members (circle_id TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (circle_id, fp));
    CREATE TABLE IF NOT EXISTS social_outbox (
      id TEXT PRIMARY KEY, to_fp TEXT NOT NULL, to_sign TEXT NOT NULL, to_enc TEXT NOT NULL, relay TEXT NOT NULL,
      invite_token TEXT, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, last_error TEXT);
    CREATE TABLE IF NOT EXISTS social_seen (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS social_shares (
      local_id TEXT PRIMARY KEY, remote_id TEXT NOT NULL, direction TEXT NOT NULL, peer_fp TEXT, item_id TEXT,
      note TEXT NOT NULL, snapshot TEXT NOT NULL, recipients TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_messages (
      id TEXT PRIMARY KEY, share_local TEXT NOT NULL, peer_fp TEXT NOT NULL, from_me INTEGER NOT NULL, type TEXT NOT NULL,
      text TEXT NOT NULL, at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS social_messages_share ON social_messages(share_local, at);
  `);

  // ------------------------------------------------------------ identity and settings

  const identity = (): C.Identity | null => {
    const raw = store.getSecret('social.identity');
    return raw ? (JSON.parse(raw) as C.Identity) : null;
  };
  const myHandle = () => store.getSetting<string>('social.handle') ?? '';
  const myRelay = () => store.getSetting<string>('social.relay') ?? '';
  const need = () => {
    const me = identity();
    if (!me) throw new HttpError(409, 'Set up Friends first');
    return me;
  };

  // ------------------------------------------------------------ local relay (opt-in)

  let relay: RelayHandle | null = null;
  let localRelayUrl: string | null = null;
  if (process.env.SR_RELAY === '1') {
    const host = process.env.SR_RELAY_HOST ?? '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.ALLOW_NON_LOCAL !== '1') {
      deps.log(`[relay] refusing to bind to ${host}; set ALLOW_NON_LOCAL=1 if you mean it`);
    } else {
      const port = Number(process.env.SR_RELAY_PORT ?? 4334);
      localRelayUrl = normalizeRelay(process.env.SR_RELAY_PUBLIC_URL ?? `http://${host === '::1' ? '[::1]' : host}:${port}`);
      startRelay({ port, host, dataDir: deps.dataDir, log: deps.log }).then(
        (h) => (relay = h),
        (e) => deps.log(`[relay] could not start: ${(e as Error).message}`),
      );
    }
  }

  // ------------------------------------------------------------ relay client

  /**
   * Relay addresses come from invites, so they are untrusted. Public relays go through safeFetch
   * (no private addresses, capped, timed out). A private or loopback relay is only allowed when
   * it is this instance's own relay or SR_SOCIAL_ALLOW_PRIVATE_RELAY=1 (LAN and local testing).
   */
  async function relayCall(base: string, path: 'put' | 'fetch' | 'ack', body: unknown): Promise<any> {
    const url = `${base}/relay/v1/${path}`;
    const allowPrivate = process.env.SR_SOCIAL_ALLOW_PRIVATE_RELAY === '1' || (localRelayUrl !== null && base === localRelayUrl);
    const payload = JSON.stringify(body);
    let status: number;
    let text: string;
    if (allowPrivate) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      status = res.status;
      text = await res.text();
      if (text.length > 6e6) throw new Error('Relay response too large');
    } else {
      const res = await safeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, maxBytes: 6e6, timeoutMs: 15_000 });
      status = res.status;
      text = res.text;
    }
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (status !== 200) throw new Error(`Relay said ${status}${data?.error ? `: ${String(data.error).slice(0, 120)}` : ''}`);
    return data;
  }

  // ------------------------------------------------------------ friends

  const friend = (fp: string) => (db.prepare('SELECT * FROM social_friends WHERE fp = ?').get(fp) as FriendRow | undefined) ?? null;
  const friendName = (f: FriendRow) => f.nickname || f.handle;
  const handleTaken = (name: string, exceptFp: string) =>
    Boolean(db.prepare('SELECT 1 FROM social_friends WHERE fp != ? AND (lower(handle) = lower(?) OR lower(nickname) = lower(?))').get(exceptFp, name, name));
  const keysOf = (f: FriendRow): C.PublicKeys => ({ signPub: f.sign_pub, encPub: f.enc_pub });
  const setStatus = (fp: string, status: FriendStatus) => db.prepare('UPDATE social_friends SET status = ?, updated_at = ? WHERE fp = ?').run(status, new Date().toISOString(), fp);

  function upsertFriend(f: { fp: string; keys: C.PublicKeys; handle: string; relay: string; status: FriendStatus }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO social_friends(fp, sign_pub, enc_pub, handle, relay, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(fp) DO UPDATE SET handle = excluded.handle, relay = excluded.relay, status = excluded.status, updated_at = excluded.updated_at`,
    ).run(f.fp, f.keys.signPub, f.keys.encPub, f.handle, f.relay, f.status, now, now);
  }

  // ------------------------------------------------------------ outbox

  let flushTimer: NodeJS.Timeout | null = null;
  const kick = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void tick();
    }, 50);
  };

  function enqueue(to: FriendRow | { fp: string; keys: C.PublicKeys; relay: string }, type: string, payload: unknown, inviteToken?: string) {
    const keys = 'keys' in to ? to.keys : keysOf(to);
    const body = C.newBody(type, payload);
    db.prepare('INSERT INTO social_outbox(id, to_fp, to_sign, to_enc, relay, invite_token, body, next_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      body.id, to.fp, keys.signPub, keys.encPub, to.relay, inviteToken ?? null, JSON.stringify(body), Date.now(), Date.now(),
    );
    kick();
    return body;
  }

  const mailboxTo = (me: C.Identity, them: C.PublicKeys, epoch = C.epochOf()) => C.mailboxId(C.fetchToken(C.pairwiseBase(me, them), C.fingerprint(them), epoch));

  let lastSendError: string | null = null;
  async function flush(me: C.Identity) {
    const now = Date.now();
    db.prepare('DELETE FROM social_outbox WHERE created_at < ?').run(now - OUTBOX_MAX_AGE_MS);
    const rows = db.prepare('SELECT * FROM social_outbox WHERE next_at <= ? ORDER BY created_at LIMIT 50').all(now) as any[];
    for (const r of rows) {
      const them = { signPub: String(r.to_sign), encPub: String(r.to_enc) };
      const mailbox = r.invite_token ? C.mailboxId(String(r.invite_token)) : mailboxTo(me, them);
      try {
        const env = C.seal(me, them, mailbox, JSON.parse(String(r.body)));
        await relayCall(String(r.relay), 'put', { to: mailbox, env });
        db.prepare('DELETE FROM social_outbox WHERE id = ?').run(r.id);
        lastSendError = null;
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        lastSendError = (e as Error).message;
        db.prepare('UPDATE social_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, now + Math.min(3600_000, 15_000 * 2 ** attempts), lastSendError, r.id);
      }
    }
  }

  // ------------------------------------------------------------ receiving

  const replay: C.ReplayStore = {
    seen: (id) => Boolean(db.prepare('SELECT 1 FROM social_seen WHERE id = ?').get(id)),
    remember: (id, ts) => void db.prepare('INSERT OR IGNORE INTO social_seen(id, ts) VALUES(?, ?)').run(id, ts),
  };
  const incoming = new Map<string, number[]>();
  function underCap(fp: string) {
    const now = Date.now();
    const list = (incoming.get(fp) ?? []).filter((t) => now - t < 86400_000);
    if (list.length >= INCOMING_PER_DAY) return false;
    list.push(now);
    incoming.set(fp, list);
    return true;
  }

  let lastPollAt: string | null = null;
  let lastPollError: string | null = null;

  async function poll(me: C.Identity) {
    const base = myRelay();
    if (!base) return;
    const myFp = C.fingerprint(me);
    const epoch = C.epochOf();
    type Ctx = { kind: 'pair'; f: FriendRow } | { kind: 'invite'; id: string; secret: string };
    const byToken = new Map<string, Ctx>();
    const listening = db.prepare("SELECT * FROM social_friends WHERE status IN ('friend', 'pending_out')").all() as unknown as FriendRow[];
    for (const f of listening) {
      const b = C.pairwiseBase(me, keysOf(f));
      for (const e of [epoch, epoch - 1]) byToken.set(C.fetchToken(b, myFp, e), { kind: 'pair', f });
    }
    const invites = db.prepare('SELECT id, secret FROM social_invites WHERE used_by IS NULL AND expires_at > ?').all(Date.now()) as { id: string; secret: string }[];
    for (const i of invites) byToken.set(C.inviteToken(i.secret), { kind: 'invite', id: i.id, secret: i.secret });
    const tokens = [...byToken.keys()];
    let changed = false;
    for (let i = 0; i < tokens.length; i += 64) {
      const chunk = tokens.slice(i, i + 64);
      const out = await relayCall(base, 'fetch', { tokens: chunk });
      const acks: { token: string; ids: string[] }[] = [];
      for (const [token, msgs] of Object.entries((out?.boxes ?? {}) as Record<string, { id: string; env: unknown }[]>)) {
        const ctx = byToken.get(token);
        if (!ctx || !Array.isArray(msgs)) continue;
        const ids: string[] = [];
        for (const m of msgs.slice(0, 200)) {
          ids.push(String(m.id));
          try {
            if (handle(me, ctx, m.env)) changed = true;
          } catch (e) {
            // Undecryptable, forged, replayed or malformed: drop it. It is acknowledged so the relay forgets it.
            if (!(e instanceof C.EnvelopeError)) deps.log(`[friends] dropped a message: ${(e as Error).message}`);
          }
        }
        acks.push({ token, ids });
      }
      if (acks.length) await relayCall(base, 'ack', { acks });
    }
    db.prepare('DELETE FROM social_seen WHERE ts < ?').run(Date.now() - C.WINDOW_PAST_MS - 86400_000);
    if (changed) deps.changed('friends');
  }

  function handle(me: C.Identity, ctx: { kind: 'pair'; f: FriendRow } | { kind: 'invite'; id: string; secret: string }, env: unknown): boolean {
    const msg = C.open(me, env, replay);
    const p = (msg.body.payload ?? {}) as Record<string, unknown>;
    if (ctx.kind === 'invite') {
      if (msg.body.type !== 'hello') return false;
      if (p.proof !== C.inviteProof(ctx.secret, msg.from.fp)) return false;
      const handleName = clean(p.handle, 32);
      const rel = normalizeRelay(p.relay);
      if (!HANDLE_RE.test(handleName) || !rel || msg.from.fp === C.fingerprint(me)) return false;
      const existing = friend(msg.from.fp);
      if (existing?.status === 'blocked' || existing?.status === 'friend') return false;
      // One poll can carry several hellos for the same invite; only the first may use it.
      if (db.prepare('UPDATE social_invites SET used_by = ? WHERE id = ? AND used_by IS NULL').run(msg.from.fp, ctx.id).changes !== 1) return false;
      upsertFriend({ fp: msg.from.fp, keys: msg.from, handle: handleName, relay: rel, status: 'pending_in' });
      return true;
    }
    const f = ctx.f;
    // The mailbox already implies the sender, but the signature is what proves it.
    if (msg.from.fp !== f.fp || !underCap(f.fp)) return false;
    const type = msg.body.type;
    if (type === 'welcome' || type === 'profile') {
      // A welcome completes a request I sent; a profile update only counts from an existing friend.
      if (type === 'profile' && f.status !== 'friend') return false;
      const handleName = clean(p.handle, 32);
      const rel = normalizeRelay(p.relay);
      // A friend may rename themselves, but not to a name another friend already shows under.
      const ok = HANDLE_RE.test(handleName) && !handleTaken(handleName, f.fp);
      db.prepare('UPDATE social_friends SET status = ?, handle = ?, relay = ?, updated_at = ? WHERE fp = ?').run(
        'friend', ok ? handleName : f.handle, rel ?? f.relay, new Date().toISOString(), f.fp,
      );
      return true;
    }
    if (f.status !== 'friend') return false;
    if (type === 'bye') {
      removeFriendRow(f.fp);
      return true;
    }
    if (type === 'share') return receiveShare(f, msg.body.ts, p);
    if (type === 'reply' || type === 'react') return receiveMessage(f, msg.body, p);
    if (EXTRA_TYPES.has(type)) return extras.receive(f, type, msg.body.ts, p);
    return false;
  }

  function friendsSourceId(): string {
    const existing = store.listSources().find((s) => s.connector === 'friends');
    if (existing) return existing.id;
    const s = store.createSource({ connector: 'friends', label: 'Friends', platform: 'aurora', config: {} });
    store.updateSource(s.id, { status: 'ok', statusDetail: 'Shares from your Aurora friends arrive here, end-to-end encrypted.' });
    return s.id;
  }

  function snapshotFrom(raw: unknown): Snapshot | null {
    const s = raw as Record<string, any>;
    if (!s || typeof s !== 'object') return null;
    const platform = clean(s.platform, 40).toLowerCase();
    const published = typeof s.publishedAt === 'string' && !Number.isNaN(Date.parse(s.publishedAt)) ? new Date(s.publishedAt).toISOString() : new Date().toISOString();
    return {
      title: clean(s.title, 300),
      text: clean(s.text, 6000),
      url: cleanUrl(s.url),
      author: { name: clean(s.author?.name, 100), handle: clean(s.author?.handle, 100) },
      platform: PLATFORM_RE.test(platform) ? platform : 'web',
      publishedAt: published,
      kind: KINDS.has(s.kind) ? s.kind : 'post',
      links: (Array.isArray(s.links) ? s.links : []).slice(0, 10).map(cleanUrl).filter((l: string | null): l is string => Boolean(l)),
    };
  }

  function receiveShare(f: FriendRow, ts: number, p: Record<string, unknown>): boolean {
    const remoteId = clean(p.shareId, 64);
    const snap = snapshotFrom(p.item);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(remoteId) || !snap) return false;
    const localId = `${f.fp.slice(0, 16)}-${remoteId}`;
    if (db.prepare('SELECT 1 FROM social_shares WHERE local_id = ?').get(localId)) return false;
    const note = clean(p.note, 2000);
    const now = new Date().toISOString();
    const at = new Date(Math.min(ts, Date.now())).toISOString();
    const itemId = `aurora:${localId}`;
    const name = friendName(f);
    const quotedText = [snap.title, snap.text].filter(Boolean).join('\n\n');
    store.tx(() => {
      db.prepare('INSERT INTO social_shares(local_id, remote_id, direction, peer_fp, item_id, note, snapshot, recipients, at) VALUES(?,?,?,?,?,?,?,?,?)').run(
        localId, remoteId, 'in', f.fp, itemId, note, JSON.stringify(snap), '[]', at,
      );
      store.upsertItem({
        id: itemId,
        sourceId: friendsSourceId(),
        platform: 'aurora',
        externalId: localId,
        url: snap.url ?? '',
        author: { name, handle: `@${f.handle}` },
        text: note,
        links: [snap.url, ...snap.links].filter((l, i, a): l is string => Boolean(l) && a.indexOf(l) === i).slice(0, 10),
        media: [],
        quoted: { author: { name: snap.author.name || snap.platform, handle: snap.author.handle || undefined }, text: quotedText, url: snap.url ?? undefined },
        kind: 'post',
        publishedAt: at,
        ingestedAt: now,
        provenance: { connector: 'friends', connectorVersion: 1, via: 'friend' },
        dedupeKey: itemId,
        isDemo: false,
      });
    });
    return true;
  }

  function receiveMessage(f: FriendRow, body: C.Body, p: Record<string, unknown>): boolean {
    const remoteId = clean(p.shareId, 64);
    // A share is either one I sent to this friend, or one this friend sent me.
    const mine = db.prepare("SELECT local_id, recipients FROM social_shares WHERE direction = 'out' AND remote_id = ?").get(remoteId) as { local_id: string; recipients: string } | undefined;
    let shareLocal: string | null = null;
    if (mine && (JSON.parse(mine.recipients) as string[]).includes(f.fp)) shareLocal = mine.local_id;
    else {
      const theirs = db.prepare("SELECT local_id FROM social_shares WHERE direction = 'in' AND peer_fp = ? AND remote_id = ?").get(f.fp, remoteId) as { local_id: string } | undefined;
      shareLocal = theirs?.local_id ?? null;
    }
    if (!shareLocal) return false;
    const at = new Date(Math.min(body.ts, Date.now())).toISOString();
    if (body.type === 'react') {
      const emoji = typeof p.emoji === 'string' && (p.emoji === '' || REACTIONS.includes(p.emoji)) ? p.emoji : null;
      if (emoji === null) return false;
      db.prepare("DELETE FROM social_messages WHERE share_local = ? AND peer_fp = ? AND from_me = 0 AND type = 'react'").run(shareLocal, f.fp);
      if (emoji) db.prepare('INSERT INTO social_messages(id, share_local, peer_fp, from_me, type, text, at) VALUES(?,?,?,?,?,?,?)').run(body.id, shareLocal, f.fp, 0, 'react', emoji, at);
      return true;
    }
    const text = clean(p.text, 2000);
    if (!text) return false;
    db.prepare('INSERT OR IGNORE INTO social_messages(id, share_local, peer_fp, from_me, type, text, at) VALUES(?,?,?,?,?,?,?)').run(body.id, shareLocal, f.fp, 0, 'reply', text, at);
    return true;
  }

  const circleRows = () =>
    (db.prepare('SELECT * FROM social_circles').all() as { id: string; profile: string | null }[]).map((c) => ({
      profile: c.profile,
      members: (db.prepare('SELECT fp FROM social_circle_members WHERE circle_id = ?').all(c.id) as { fp: string }[]).map((r) => r.fp),
    }));
  const extras = createExtras<FriendRow>({
    store,
    HttpError,
    friend,
    friendName,
    enqueue: (to, type, payload) => enqueue(to, type, payload),
    clean,
    cleanUrl,
    friendsSourceId,
    circleMembers: (id) => (db.prepare('SELECT fp FROM social_circle_members WHERE circle_id = ?').all(id) as { fp: string }[]).map((r) => r.fp),
    profiles: () => deps.profiles?.() ?? [],
    profileOf: (fp) => {
      // The one profile this friend's circles map to, if exactly one: their weekly list defaults to it.
      const mapped = new Set(circleRows().filter((c) => c.profile && c.members.includes(fp)).map((c) => c.profile!));
      return mapped.size === 1 ? [...mapped][0] : null;
    },
    actorStore: () => deps.actorStore?.() ?? null,
    changed: deps.changed,
  });

  // ------------------------------------------------------------ the loop

  let ticking = false;
  async function tick() {
    const me = identity();
    if (!me || ticking) return;
    ticking = true;
    try {
      try {
        extras.tick();
      } catch (e) {
        deps.log(`social: weekly list and collection sync failed: ${(e as Error).message}`);
      }
      await flush(me);
      await poll(me);
      lastPollAt = new Date().toISOString();
      lastPollError = null;
    } catch (e) {
      lastPollError = (e as Error).message;
    } finally {
      ticking = false;
    }
  }
  const loop = setInterval(() => void tick(), POLL_MS);
  loop.unref();
  setTimeout(() => void tick(), 1500).unref();

  // ------------------------------------------------------------ actions

  function removeFriendRow(fp: string) {
    extras.forget(fp);
    db.prepare('DELETE FROM social_circle_members WHERE fp = ?').run(fp);
    db.prepare('DELETE FROM social_friends WHERE fp = ?').run(fp);
  }

  function purgeFrom(fp: string) {
    const items = db.prepare("SELECT item_id, local_id FROM social_shares WHERE direction = 'in' AND peer_fp = ?").all(fp) as { item_id: string; local_id: string }[];
    store.tx(() => {
      for (const { item_id, local_id } of items) {
        db.prepare('DELETE FROM item_state WHERE item_id = ?').run(item_id);
        db.prepare('DELETE FROM item_sources WHERE item_id = ?').run(item_id);
        db.prepare('DELETE FROM items WHERE id = ?').run(item_id);
        db.prepare('DELETE FROM social_messages WHERE share_local = ?').run(local_id);
      }
      db.prepare("DELETE FROM social_shares WHERE direction = 'in' AND peer_fp = ?").run(fp);
      db.prepare('DELETE FROM social_messages WHERE peer_fp = ?').run(fp);
      db.prepare('DELETE FROM social_outbox WHERE to_fp = ?').run(fp);
      extras.forget(fp);
    });
  }

  function encodeInvite(me: C.Identity, secret: string, expires: number) {
    const data = { v: 1, h: myHandle(), s: me.signPub, e: me.encPub, r: myRelay(), k: secret, x: expires };
    return INVITE_PREFIX + Buffer.from(JSON.stringify(data)).toString('base64url');
  }

  function decodeInvite(link: string) {
    const raw = String(link ?? '').trim();
    const at = raw.indexOf(INVITE_PREFIX);
    if (at < 0 || raw.length > 4000) throw new HttpError(400, 'That is not an Aurora invite link');
    let d: any;
    try {
      d = JSON.parse(Buffer.from(raw.slice(at + INVITE_PREFIX.length).replace(/\s+/g, ''), 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(400, 'The invite link is damaged. Ask for a new one.');
    }
    const handle = clean(d?.h, 32);
    const relayUrl = normalizeRelay(d?.r);
    if (d?.v !== 1 || !C.isKey(d.s) || !C.isKey(d.e) || !HANDLE_RE.test(handle) || !relayUrl || typeof d.k !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(d.k) || typeof d.x !== 'number')
      throw new HttpError(400, 'The invite link is damaged. Ask for a new one.');
    if (d.x < Date.now()) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
    const keys = { signPub: d.s as string, encPub: d.e as string };
    return { handle, relay: relayUrl, secret: d.k as string, expires: d.x as number, keys, fp: C.fingerprint(keys) };
  }

  function circlesOf(fp: string): string[] {
    return (db.prepare('SELECT circle_id FROM social_circle_members WHERE fp = ?').all(fp) as { circle_id: string }[]).map((r) => r.circle_id);
  }

  function friendView(f: FriendRow) {
    return { fp: f.fp, fpShort: C.groupFingerprint(f.fp), handle: f.handle, nickname: f.nickname, name: friendName(f), relay: f.relay, status: f.status, since: f.created_at, circles: circlesOf(f.fp) };
  }

  function overview() {
    const me = identity();
    const friends = (db.prepare('SELECT * FROM social_friends ORDER BY status, lower(coalesce(nickname, handle))').all() as unknown as FriendRow[]).map(friendView);
    const circles = (db.prepare('SELECT * FROM social_circles ORDER BY lower(name)').all() as { id: string; name: string; profile: string | null }[]).map((c) => ({
      id: c.id,
      name: c.name,
      profile: c.profile,
      members: (db.prepare('SELECT fp FROM social_circle_members WHERE circle_id = ?').all(c.id) as { fp: string }[]).map((r) => r.fp),
    }));
    const invites = (db.prepare('SELECT id, created_at, expires_at FROM social_invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').all(Date.now()) as any[]).map((i) => ({
      id: i.id,
      createdAt: i.created_at,
      expiresAt: new Date(Number(i.expires_at)).toISOString(),
    }));
    const outbox = db.prepare('SELECT COUNT(*) AS n, MAX(last_error) AS err FROM social_outbox').get() as { n: number; err: string | null };
    const unread = (db.prepare('SELECT COUNT(*) AS n FROM social_messages WHERE from_me = 0 AND read = 0').get() as { n: number }).n;
    const fp = me ? C.fingerprint(me) : null;
    return {
      enabled: Boolean(me),
      me: me && fp ? { handle: myHandle(), fp, fpShort: C.groupFingerprint(fp), relay: myRelay() } : null,
      localRelay: localRelayUrl,
      friends,
      circles,
      invites,
      reactions: REACTIONS,
      outbox: { pending: outbox.n, lastError: outbox.n ? (outbox.err ?? lastSendError) : null },
      lastPollAt,
      lastPollError,
      unread,
      pendingIn: friends.filter((f) => f.status === 'pending_in').length,
      extras: extras.summary(),
    };
  }

  function threadView(localId: string) {
    const s = db.prepare('SELECT * FROM social_shares WHERE local_id = ?').get(localId) as any;
    if (!s) throw new HttpError(404, 'No such share');
    const msgs = db.prepare('SELECT * FROM social_messages WHERE share_local = ? ORDER BY at, rowid').all(localId) as any[];
    const peers: string[] = s.direction === 'in' ? [s.peer_fp] : JSON.parse(s.recipients);
    const conversations = peers.map((fp) => {
      const f = friend(fp);
      const mine = msgs.filter((m) => m.peer_fp === fp);
      return {
        peer: { fp, name: f ? friendName(f) : 'Removed friend', status: f?.status ?? 'removed' },
        reaction: mine.find((m) => m.type === 'react' && !m.from_me)?.text ?? null,
        myReaction: mine.find((m) => m.type === 'react' && m.from_me)?.text ?? null,
        messages: mine.filter((m) => m.type === 'reply').map((m) => ({ id: m.id, fromMe: Boolean(m.from_me), text: m.text, at: m.at })),
      };
    });
    const marked = Number(db.prepare('UPDATE social_messages SET read = 1 WHERE share_local = ? AND from_me = 0 AND read = 0').run(localId).changes);
    return {
      localId,
      marked,
      direction: s.direction as 'in' | 'out',
      note: s.note as string,
      at: s.at as string,
      itemId: s.item_id as string | null,
      snapshot: JSON.parse(s.snapshot) as Snapshot,
      conversations,
    };
  }

  function shareList() {
    const rows = db.prepare('SELECT local_id FROM social_shares ORDER BY at DESC LIMIT 100').all() as { local_id: string }[];
    // threadView marks read; the list view should not, so read the unread counts first.
    const unreadBy = new Map((db.prepare('SELECT share_local, COUNT(*) AS n FROM social_messages WHERE from_me = 0 AND read = 0 GROUP BY share_local').all() as any[]).map((r) => [r.share_local, r.n]));
    return rows.map((r) => {
      const s = db.prepare('SELECT * FROM social_shares WHERE local_id = ?').get(r.local_id) as any;
      const peers: string[] = s.direction === 'in' ? [s.peer_fp] : JSON.parse(s.recipients);
      const msgs = db.prepare("SELECT COUNT(*) AS n FROM social_messages WHERE share_local = ? AND type = 'reply'").get(r.local_id) as { n: number };
      const reacts = (db.prepare("SELECT text FROM social_messages WHERE share_local = ? AND type = 'react' AND from_me = 0").all(r.local_id) as { text: string }[]).map((x) => x.text);
      const snap = JSON.parse(s.snapshot) as Snapshot;
      return {
        localId: r.local_id,
        direction: s.direction,
        note: s.note,
        at: s.at,
        title: snap.title || snap.text.slice(0, 140),
        url: snap.url,
        peers: peers.map((fp) => {
          const f = friend(fp);
          return f ? friendName(f) : 'Removed friend';
        }),
        replies: msgs.n,
        reactions: reacts,
        unread: unreadBy.get(r.local_id) ?? 0,
      };
    });
  }

  // ------------------------------------------------------------ routes

  function register(route: RouteFn) {
    route('GET', '/api/social', () => overview());
    extras.register(route);

    route('POST', '/api/social/setup', (_q, _s, _p, body) => {
      if (identity()) throw new HttpError(409, 'Friends is already set up');
      const handleName = clean(body?.handle, 32);
      if (!HANDLE_RE.test(handleName)) throw new HttpError(400, 'Pick a handle: letters, digits, dot, dash or underscore, up to 32');
      const rel = normalizeRelay(body?.relay || localRelayUrl);
      if (!rel) throw new HttpError(400, 'Give a relay address (http or https)');
      store.setSecret('social.identity', JSON.stringify(C.generateIdentity()));
      store.setSetting('social.handle', handleName);
      store.setSetting('social.relay', rel);
      kick();
      return overview();
    });

    route('PATCH', '/api/social/me', (_q, _s, _p, body) => {
      need();
      const patch: { handle?: string; relay?: string } = {};
      if (body?.handle !== undefined) {
        const h = clean(body.handle, 32);
        if (!HANDLE_RE.test(h)) throw new HttpError(400, 'Handle: letters, digits, dot, dash or underscore, up to 32');
        patch.handle = h;
        store.setSetting('social.handle', h);
      }
      if (body?.relay !== undefined) {
        const r = normalizeRelay(body.relay);
        if (!r) throw new HttpError(400, 'Relay must be an http or https address');
        patch.relay = r;
        store.setSetting('social.relay', r);
      }
      // Friends learn the new handle or relay. Messages already on the old relay stay there until it expires them.
      for (const f of db.prepare("SELECT * FROM social_friends WHERE status = 'friend'").all() as unknown as FriendRow[]) enqueue(f, 'profile', { handle: myHandle(), relay: myRelay() });
      return overview();
    });

    route('POST', '/api/social/invites', () => {
      const me = need();
      if (!myRelay()) throw new HttpError(409, 'Set a relay first');
      const id = randomUUID();
      const secret = C.randomSecret();
      const expires = Date.now() + INVITE_TTL_MS;
      db.prepare('INSERT INTO social_invites(id, secret, created_at, expires_at) VALUES(?,?,?,?)').run(id, secret, new Date().toISOString(), expires);
      kick();
      return { id, link: encodeInvite(me, secret, expires), expiresAt: new Date(expires).toISOString(), fpShort: C.groupFingerprint(C.fingerprint(me)) };
    });

    route('DELETE', '/api/social/invites/:id', (_q, _s, p) => {
      db.prepare('DELETE FROM social_invites WHERE id = ?').run(p.id);
      return overview();
    });

    route('POST', '/api/social/invites/preview', (_q, _s, _p, body) => {
      const inv = decodeInvite(body?.link);
      return { handle: inv.handle, fpShort: C.groupFingerprint(inv.fp), relay: inv.relay, expiresAt: new Date(inv.expires).toISOString() };
    });

    route('POST', '/api/social/invites/accept', (_q, _s, _p, body) => {
      const me = need();
      const inv = decodeInvite(body?.link);
      if (inv.fp === C.fingerprint(me)) throw new HttpError(400, 'That is your own invite');
      const existing = friend(inv.fp);
      if (existing?.status === 'blocked') throw new HttpError(409, 'You blocked this person. Unblock them first.');
      if (existing?.status === 'friend') throw new HttpError(409, `You are already friends with ${friendName(existing)}`);
      upsertFriend({ fp: inv.fp, keys: inv.keys, handle: inv.handle, relay: inv.relay, status: 'pending_out' });
      enqueue({ fp: inv.fp, keys: inv.keys, relay: inv.relay }, 'hello', { proof: C.inviteProof(inv.secret, C.fingerprint(me)), handle: myHandle(), relay: myRelay() }, C.inviteToken(inv.secret));
      return overview();
    });

    route('POST', '/api/social/friends/:fp/accept', (_q, _s, p) => {
      need();
      const f = friend(p.fp);
      if (!f || f.status !== 'pending_in') throw new HttpError(404, 'No such request');
      setStatus(f.fp, 'friend');
      enqueue(f, 'welcome', { handle: myHandle(), relay: myRelay() });
      return overview();
    });

    route('POST', '/api/social/friends/:fp/decline', (_q, _s, p) => {
      const f = friend(p.fp);
      // Declining or cancelling is silent: the other side is never told.
      if (f && (f.status === 'pending_in' || f.status === 'pending_out')) removeFriendRow(f.fp);
      return overview();
    });

    route('POST', '/api/social/friends/:fp/remove', (_q, _s, p) => {
      need();
      const f = friend(p.fp);
      if (!f) throw new HttpError(404, 'No such friend');
      // Anything still queued for them (shares, lists, collections) must not go out after this.
      db.prepare('DELETE FROM social_outbox WHERE to_fp = ?').run(f.fp);
      if (f.status === 'friend') enqueue(f, 'bye', {});
      removeFriendRow(f.fp);
      deps.changed('friends');
      return overview();
    });

    route('POST', '/api/social/friends/:fp/block', (_q, _s, p) => {
      const f = friend(p.fp);
      if (!f) throw new HttpError(404, 'No such friend');
      // Blocking is silent. Their shares and replies are deleted here and nothing more from them is fetched.
      purgeFrom(f.fp);
      db.prepare('DELETE FROM social_circle_members WHERE fp = ?').run(f.fp);
      setStatus(f.fp, 'blocked');
      deps.changed('friends');
      return overview();
    });

    route('POST', '/api/social/friends/:fp/unblock', (_q, _s, p) => {
      const f = friend(p.fp);
      if (f?.status === 'blocked') removeFriendRow(f.fp);
      return overview();
    });

    route('PATCH', '/api/social/friends/:fp', (_q, _s, p, body) => {
      const f = friend(p.fp);
      if (!f) throw new HttpError(404, 'No such friend');
      const nick = clean(body?.nickname, 60);
      db.prepare('UPDATE social_friends SET nickname = ?, updated_at = ? WHERE fp = ?').run(nick || null, new Date().toISOString(), f.fp);
      return overview();
    });

    const saveCircle = (id: string, body: any) => {
      const name = clean(body?.name, 60);
      if (!name) throw new HttpError(400, 'Name the circle');
      const members: string[] = Array.isArray(body?.members) ? body.members.filter((fp: unknown) => typeof fp === 'string' && friend(fp)?.status === 'friend') : [];
      const profile = body?.profile === undefined ? undefined : clean(body.profile, 60) || null;
      store.tx(() => {
        db.prepare('INSERT INTO social_circles(id, name, profile, created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(id, name, profile ?? null, new Date().toISOString());
        if (profile !== undefined) db.prepare('UPDATE social_circles SET profile = ? WHERE id = ?').run(profile, id);
        if (Array.isArray(body?.members)) {
          db.prepare('DELETE FROM social_circle_members WHERE circle_id = ?').run(id);
          for (const fp of members) db.prepare('INSERT OR IGNORE INTO social_circle_members(circle_id, fp) VALUES(?, ?)').run(id, fp);
        }
      });
      // A circle mapped to a profile changes which friends' shares that profile shows.
      deps.changed('friends');
      return overview();
    };
    route('POST', '/api/social/circles', (_q, _s, _p, body) => saveCircle(randomUUID(), body));
    route('PATCH', '/api/social/circles/:id', (_q, _s, p, body) => {
      if (!db.prepare('SELECT 1 FROM social_circles WHERE id = ?').get(p.id)) throw new HttpError(404, 'No such circle');
      return saveCircle(p.id, body);
    });
    route('DELETE', '/api/social/circles/:id', (_q, _s, p) => {
      db.prepare('DELETE FROM social_circle_members WHERE circle_id = ?').run(p.id);
      db.prepare('DELETE FROM social_circles WHERE id = ?').run(p.id);
      deps.changed('friends');
      return overview();
    });

    route('POST', '/api/social/share', (_q, _s, _p, body) => {
      need();
      const item = store.getItem(String(body?.itemId ?? ''));
      if (!item) throw new HttpError(404, 'No such post');
      if (item.provenance.connector === 'friends') throw new HttpError(400, 'Shares from friends stay between you and them, so they cannot be passed on.');
      const fps = new Set<string>(Array.isArray(body?.friends) ? body.friends.filter((x: unknown) => typeof x === 'string') : []);
      for (const cid of Array.isArray(body?.circles) ? body.circles : []) {
        for (const r of db.prepare('SELECT fp FROM social_circle_members WHERE circle_id = ?').all(String(cid)) as { fp: string }[]) fps.add(r.fp);
      }
      const targets = [...fps].map(friend).filter((f): f is FriendRow => f?.status === 'friend');
      if (!targets.length) throw new HttpError(400, 'Pick at least one friend');
      const note = clean(body?.note, 2000);
      const snap: Snapshot = {
        title: clean(item.title, 300),
        text: clean(item.text, 6000),
        url: cleanUrl(item.url),
        author: { name: clean(item.author.name, 100), handle: clean(item.author.handle, 100) },
        platform: PLATFORM_RE.test(item.platform) ? item.platform : 'web',
        publishedAt: item.publishedAt,
        kind: item.kind,
        links: item.links.slice(0, 10).map(cleanUrl).filter((l): l is string => Boolean(l)),
      };
      const shareId = randomUUID();
      db.prepare('INSERT INTO social_shares(local_id, remote_id, direction, peer_fp, item_id, note, snapshot, recipients, at) VALUES(?,?,?,?,?,?,?,?,?)').run(
        shareId, shareId, 'out', null, item.id, note, JSON.stringify(snap), JSON.stringify(targets.map((t) => t.fp)), new Date().toISOString(),
      );
      for (const t of targets) enqueue(t, 'share', { shareId, note, item: snap });
      return { ok: true, shareId, sentTo: targets.map(friendName) };
    });

    route('GET', '/api/social/shares', () => shareList());
    route('GET', '/api/social/thread/:id', (_q, _s, p) => threadView(p.id));

    const target = (localId: string, peer: unknown) => {
      const s = db.prepare('SELECT * FROM social_shares WHERE local_id = ?').get(localId) as any;
      if (!s) throw new HttpError(404, 'No such share');
      const fp = s.direction === 'in' ? s.peer_fp : String(peer ?? '');
      if (s.direction === 'out' && !(JSON.parse(s.recipients) as string[]).includes(fp)) throw new HttpError(400, 'Pick who to reply to');
      const f = friend(fp);
      if (f?.status !== 'friend') throw new HttpError(409, 'You are no longer friends with this person');
      return { s, f };
    };

    route('POST', '/api/social/reply', (_q, _s, _p, body) => {
      need();
      const { s, f } = target(String(body?.shareId ?? ''), body?.peer);
      const text = clean(body?.text, 2000);
      if (!text) throw new HttpError(400, 'Write something first');
      const sent = enqueue(f, 'reply', { shareId: s.remote_id, text });
      db.prepare('INSERT INTO social_messages(id, share_local, peer_fp, from_me, type, text, at, read) VALUES(?,?,?,?,?,?,?,1)').run(sent.id, s.local_id, f.fp, 1, 'reply', text, new Date().toISOString());
      return threadView(s.local_id);
    });

    route('POST', '/api/social/react', (_q, _s, _p, body) => {
      need();
      const { s, f } = target(String(body?.shareId ?? ''), body?.peer);
      const emoji = String(body?.emoji ?? '');
      if (emoji && !REACTIONS.includes(emoji)) throw new HttpError(400, 'Unknown reaction');
      const sent = enqueue(f, 'react', { shareId: s.remote_id, emoji });
      db.prepare("DELETE FROM social_messages WHERE share_local = ? AND peer_fp = ? AND from_me = 1 AND type = 'react'").run(s.local_id, f.fp);
      if (emoji) db.prepare('INSERT INTO social_messages(id, share_local, peer_fp, from_me, type, text, at, read) VALUES(?,?,?,?,?,?,?,1)').run(sent.id, s.local_id, f.fp, 1, 'react', emoji, new Date().toISOString());
      return threadView(s.local_id);
    });

    route('POST', '/api/social/sync', async () => {
      await tick();
      return overview();
    });
  }

  return {
    register,
    tick,
    /** Profile id to the friends (fingerprint prefixes) whose shares that profile shows, from circles mapped to profiles. */
    routing: () => extras.routing(circleRows()),
    close: async () => {
      clearInterval(loop);
      await relay?.close();
    },
  };
}
