// Friends, part two: the weekly list, shared collections and suggested connectors, run between two
// real stores with every message going through seal() and open(). Also: consent rules, revocation,
// stale versions, sanitising hostile entries, size caps and circle-to-profile routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.ts';
import type { Item, Profile } from '../core/types.ts';
import { makeLens, scopeLibrary } from '../core/profiles.ts';
import { createActorStore } from '../server/actors/store.ts';
import { EnvelopeError, MemoryReplay, epochOf, fingerprint, generateIdentity, newBody, open, seal, type Identity } from '../server/social/crypto.ts';
import { clean, cleanUrl } from '../server/social/index.ts';
import { BODY_BUDGET, createExtras, type FriendLike } from '../server/social/extras.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (req: any, res: any, params: Record<string, string>, body: any, url: URL) => unknown;

interface Side {
  dir: string;
  id: Identity;
  fp: string;
  store: Store;
  extras: ReturnType<typeof createExtras<FriendLike>>;
  routes: Map<string, Handler>;
  call: (method: string, path: string, params?: Record<string, string>, body?: unknown) => any;
  sent: { type: string; bytes: number; ct: number }[];
  friendsSource: string;
  actors: ReturnType<typeof createActorStore>;
}

/** Two instances, friends with each other, wired through real envelopes. */
function pair(profiles: Profile[] = []) {
  const sides: Side[] = [];
  const replay = [new MemoryReplay(), new MemoryReplay()];
  for (const name of ['maya', 'jonah']) {
    const dir = mkdtempSync(join(tmpdir(), `sr-social2-${name}-`));
    const id = generateIdentity();
    const store = new Store(dir);
    const routes = new Map<string, Handler>();
    sides.push({
      dir,
      id,
      fp: fingerprint(id),
      store,
      routes,
      sent: [],
      friendsSource: store.createSource({ connector: 'friends', label: 'Friends', platform: 'aurora', config: {} }).id,
      actors: createActorStore(dir),
      call: (method, path, params = {}, body = {}) => {
        const h = routes.get(`${method} ${path}`);
        if (!h) throw new Error(`no route ${method} ${path}`);
        return h(null, null, params, body, new URL('http://x'));
      },
      extras: null as never,
    });
  }
  sides.forEach((me, i) => {
    const other = sides[1 - i];
    const asFriend: FriendLike = { fp: other.fp, handle: i === 0 ? 'jonah' : 'maya', nickname: null, status: 'friend' };
    me.extras = createExtras<FriendLike>({
      store: me.store,
      HttpError,
      friend: (fp) => (fp === other.fp ? asFriend : null),
      friendName: (f) => `@${f.handle}`,
      enqueue: (_to, type, payload) => {
        const body = newBody(type, payload);
        const env = seal(me.id, other.id, 'mbox', body);
        me.sent.push({ type, bytes: Buffer.byteLength(JSON.stringify(body)), ct: env.ct.length });
        const msg = open(other.id, env, replay[1 - i]);
        assert.equal(msg.from.fp, me.fp);
        const meToThem: FriendLike = { fp: me.fp, handle: i === 0 ? 'maya' : 'jonah', nickname: null, status: 'friend' };
        other.extras.receive(meToThem, msg.body.type, msg.body.ts, msg.body.payload as Record<string, unknown>);
        return body;
      },
      clean,
      cleanUrl,
      friendsSourceId: () => me.friendsSource,
      circleMembers: () => [other.fp],
      profiles: () => profiles,
      actorStore: () => me.actors,
      changed: () => undefined,
    });
    me.extras.register((method, path, h) => void me.routes.set(`${method} ${path}`, h));
  });
  const done = () => sides.forEach((s) => rmSync(s.dir, { recursive: true, force: true }));
  return { maya: sides[0], jonah: sides[1], done };
}

function post(id: string, sourceId: string, extra: Partial<Item> = {}): Omit<Item, 'state'> {
  return {
    id, sourceId, platform: 'x', externalId: id, url: `https://example.com/${id}`, author: { name: 'Ada', handle: '@ada' }, title: `Post ${id}`,
    text: 'hello there', links: [], media: [], kind: 'post', publishedAt: '2026-10-10T00:00:00.000Z', ingestedAt: '2026-10-10T00:00:00.000Z',
    provenance: { connector: 'rss', connectorVersion: 1, via: 'feed' }, dedupeKey: id, isDemo: false, ...extra,
  };
}

const prof = (id: string, name: string, sourceIds: string[]): Profile => ({
  id, name, icon: 'home', color: '#7aa2f7', sourceIds, own: { views: [], pages: [], aiRules: [] }, position: 0, createdAt: '2026-10-01T00:00:00.000Z',
}) as Profile;

const rejects = (fn: () => unknown, status: number) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status, `expected ${status}`);

test('weekly list: off by default, nothing sent on enable, exact preview, first send by hand, revocable', () => {
  const { maya, jonah, done } = pair();
  try {
    const src = maya.store.createSource({ connector: 'rss', label: 'Feed', platform: 'web', config: {} });
    for (const id of ['a', 'b', 'c']) maya.store.upsertItem(post(id, src.id));
    maya.store.upsertItem(post('demo', src.id, { isDemo: true }));
    maya.store.upsertItem(post('aurora:f-1', maya.friendsSource, { provenance: { connector: 'friends', connectorVersion: 1, via: 'friend' } }));
    maya.store.patchState(['a', 'b', 'c', 'demo', 'aurora:f-1'], { saved: true });

    const p0 = maya.call('GET', '/api/social/digest/:fp', { fp: jonah.fp });
    assert.equal(p0.enabled, false);
    rejects(() => maya.call('POST', '/api/social/digest/:fp/send', { fp: jonah.fp }, { itemIds: ['a'] }), 409);

    const p1 = maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { enabled: true });
    assert.equal(maya.sent.length, 0, 'enabling sends nothing');
    // Friend shares and demo posts never go into a list.
    assert.deepEqual(p1.entries.map((e: any) => e.itemId).sort(), ['a', 'b', 'c']);
    // Automatic weekly sending needs one list sent by hand first.
    rejects(() => maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { auto: true }), 409);

    // Only posts that were in the preview and ticked go; an unknown id is ignored.
    const sent = maya.call('POST', '/api/social/digest/:fp/send', { fp: jonah.fp }, { itemIds: ['a', 'c', 'not-there', 'demo'] });
    assert.equal(sent.sent, 2);
    assert.deepEqual(maya.sent.map((s) => s.type), ['digest']);
    const inbox = jonah.extras.inbox();
    assert.equal(inbox.digests.length, 1);
    assert.deepEqual(inbox.digests[0].entries.map((e) => e.title).sort(), ['Post a', 'Post c']);
    assert.ok(!inbox.digests[0].entries.some((e) => e.id === 'a'), 'local item ids do not travel');
    assert.equal(jonah.extras.summary().inboxNew, 1);

    rejects(() => maya.call('POST', '/api/social/digest/:fp/send', { fp: jonah.fp }, { itemIds: ['b'] }), 409);
    assert.equal(maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { auto: true }).auto, true);

    // Jonah keeps one: it becomes a saved Friends post, still not re-shareable.
    const kept = jonah.call('POST', '/api/social/inbox/keep', {}, { peer: maya.fp, kind: 'digest', week: inbox.digests[0].week, entryId: inbox.digests[0].entries[0].id });
    const item = jonah.store.getItem(kept.itemId)!;
    assert.equal(item.provenance.connector, 'friends');
    assert.equal(item.state.saved, true);
    assert.ok(item.externalId.startsWith(maya.fp.slice(0, 16)));

    // Turning it off is a revocation: Jonah's copy goes.
    maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { enabled: false });
    assert.equal(maya.sent.at(-1)!.type, 'digest_off');
    assert.equal(jonah.extras.inbox().digests.length, 0);
    assert.equal(maya.call('GET', '/api/social/digest/:fp', { fp: jonah.fp }).confirmed, false, 'turning back on asks for a hand-sent list again');
  } finally {
    done();
  }
});

test('weekly list: automatic send only after confirmation, skips and profile scope respected, mute deletes', () => {
  const work = prof('work', 'Work', []);
  const { maya, jonah, done } = pair([work]);
  try {
    const a = maya.store.createSource({ connector: 'rss', label: 'Work feed', platform: 'web', config: {} });
    const b = maya.store.createSource({ connector: 'rss', label: 'Games', platform: 'web', config: {} });
    work.sourceIds.push(a.id);
    maya.store.upsertItem(post('w1', a.id));
    maya.store.upsertItem(post('w2', a.id));
    maya.store.upsertItem(post('g1', b.id));
    maya.store.patchState(['w1', 'w2', 'g1'], { saved: true });
    maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { enabled: true, scope: 'work' });
    maya.call('POST', '/api/social/digest-skip', {}, { itemId: 'w2' });
    const p = maya.call('GET', '/api/social/digest/:fp', { fp: jonah.fp });
    assert.deepEqual(p.entries.map((e: any) => e.itemId), ['w1']);

    maya.extras.tick(true);
    assert.equal(maya.sent.length, 0, 'no automatic list before one was sent by hand');

    maya.call('POST', '/api/social/digest/:fp/send', { fp: jonah.fp }, { itemIds: ['w1'] });
    maya.call('PATCH', '/api/social/digest/:fp', { fp: jonah.fp }, { auto: true });
    // Pretend a week went by.
    maya.store.db.prepare('UPDATE social_digest_out SET last_week = ?, last_sent_at = ?').run(epochOf() - 1, new Date(Date.now() - 8 * 86400_000).toISOString());
    maya.extras.tick(true);
    assert.equal(maya.sent.filter((s) => s.type === 'digest').length, 2);

    // Jonah hides Maya's lists: deleted, and new ones are dropped.
    jonah.call('POST', '/api/social/digest-mute/:fp', { fp: maya.fp }, {});
    assert.equal(jonah.extras.inbox().digests.length, 0);
    const ok = jonah.extras.receive({ fp: maya.fp, handle: 'maya', nickname: null, status: 'friend' }, 'digest', Date.now(), { week: epochOf(), entries: [{ id: 'abcdefgh1234', title: 'x' }] });
    assert.equal(ok, false);
  } finally {
    done();
  }
});

test('shared collection: versioned updates, stale versions ignored, unshare deletes', () => {
  const { maya, jonah, done } = pair();
  try {
    const src = maya.store.createSource({ connector: 'rss', label: 'Feed', platform: 'web', config: {} });
    maya.store.addCollection('Recipes');
    maya.store.upsertItem(post('r1', src.id));
    maya.store.upsertItem(post('r2', src.id));
    maya.store.patchState(['r1'], { collections: ['Recipes'] });
    rejects(() => maya.call('POST', '/api/social/collections', {}, { name: 'Recipes', friends: [] }), 400);
    rejects(() => maya.call('POST', '/api/social/collections', {}, { name: 'Nope', friends: [jonah.fp] }), 404);

    const out = maya.call('POST', '/api/social/collections', {}, { name: 'Recipes', friends: [jonah.fp] });
    assert.equal(out.outgoing[0].version, 1);
    let got = jonah.extras.inbox().collections;
    assert.equal(got.length, 1);
    assert.equal(got[0].title, 'Recipes');
    assert.equal(got[0].entries.length, 1);

    // No change, no message.
    maya.extras.tick(true);
    assert.equal(maya.sent.length, 1);
    maya.store.patchState(['r2'], { collections: ['Recipes'] });
    maya.extras.tick(true);
    got = jonah.extras.inbox().collections;
    assert.equal(got[0].version, 2);
    assert.equal(got[0].entries.length, 2);

    // A replayed or reordered older version never overwrites a newer one.
    const maya4jonah: FriendLike = { fp: maya.fp, handle: 'maya', nickname: null, status: 'friend' };
    assert.equal(jonah.extras.receive(maya4jonah, 'coll', Date.now(), { collId: got[0].collId, name: 'Old', version: 1, entries: [] }), false);
    assert.equal(jonah.extras.inbox().collections[0].title, 'Recipes');

    maya.call('POST', '/api/social/collections/:id/unshare', { id: out.outgoing[0].id }, {});
    assert.equal(maya.sent.at(-1)!.type, 'coll_off');
    assert.equal(jonah.extras.inbox().collections.length, 0);

    // Deleting the collection locally also tells friends.
    maya.call('POST', '/api/social/collections', {}, { name: 'Recipes', circles: ['c1'] });
    assert.equal(jonah.extras.inbox().collections.length, 1);
    maya.store.deleteCollection('Recipes');
    maya.extras.tick(true);
    assert.equal(jonah.extras.inbox().collections.length, 0);
  } finally {
    done();
  }
});

test('connector suggestion: a card only; import goes through the bundle importer as an untested import', () => {
  const { maya, jonah, done } = pair();
  try {
    maya.actors.write({ manifest: { id: 'insta-saved', name: 'Instagram saved', runtime: 'node', platform: 'instagram', tier: 'http', hosts: ['www.instagram.com'], description: 'Reads your saved posts' }, code: 'export default async function run() { return []; }\n' });
    jonah.actors.write({ manifest: { id: 'insta-saved', name: 'Mine', runtime: 'node', platform: 'instagram', tier: 'http', hosts: [] }, code: 'export default 1;\n' });
    rejects(() => maya.call('POST', '/api/social/recommend', {}, { actorId: 'insta-saved', friends: [] }), 400);
    maya.call('POST', '/api/social/recommend', {}, { actorId: 'insta-saved', friends: [jonah.fp], note: 'works for me' });
    const box = jonah.extras.inbox();
    assert.equal(box.recs.length, 1);
    assert.equal(box.recs[0].connector.name, 'Instagram saved');
    assert.deepEqual(box.recs[0].connector.hosts, ['www.instagram.com']);
    assert.equal(jonah.actors.list().length, 1, 'nothing installed on receipt');

    const imp = jonah.call('POST', '/api/social/recs/:id/import', { id: box.recs[0].id }, {});
    assert.equal(imp.renamed, true, 'an id clash renames instead of overwriting');
    const got = jonah.actors.get(imp.actorId)!;
    assert.equal(got.manifest.createdBy, 'import');
    assert.match(got.manifest.notes ?? '', /Suggested by @maya.*Not tested here yet/);
    assert.equal(jonah.actors.get('insta-saved')!.manifest.name, 'Mine');
    assert.equal(jonah.call('POST', '/api/social/recs/:id/import', { id: box.recs[0].id }, {}).already, true);

    // Too big to send stays a file export.
    maya.actors.write({ manifest: { id: 'huge', runtime: 'node', hosts: [] }, code: `// ${'x'.repeat(190_000)}\n` });
    rejects(() => maya.call('POST', '/api/social/recommend', {}, { actorId: 'huge', friends: [jonah.fp] }), 413);

    // A forged bundle is dropped on receipt.
    const maya4jonah: FriendLike = { fp: maya.fp, handle: 'maya', nickname: null, status: 'friend' };
    assert.equal(jonah.extras.receive(maya4jonah, 'connector', Date.now(), { recId: 'abcdefgh-1', bundle: { format: 'other', formatVersion: 1, manifest: { id: 'x1' }, code: 'x' } }), false);
    assert.equal(jonah.extras.receive(maya4jonah, 'connector', Date.now(), { recId: 'abcdefgh-2', bundle: { format: 'social-reader-actor', formatVersion: 1, manifest: { id: '../etc' }, code: 'x' } }), false);
  } finally {
    done();
  }
});

test('hostile entries are reduced to capped plain text with safe links', () => {
  const { maya, jonah, done } = pair();
  try {
    const maya4jonah: FriendLike = { fp: maya.fp, handle: 'maya', nickname: null, status: 'friend' };
    const ok = jonah.extras.receive(maya4jonah, 'digest', Date.now(), {
      week: epochOf(),
      entries: [
        { id: 'abcdefgh0001', title: 'Hi\u202Egnp.exe\u200B', text: 'y'.repeat(5000), url: 'javascript:alert(1)', author: { name: '<b>x</b>' }, platform: 'X!!', kind: 'script', at: 'nope' },
        { id: '../../bad', title: 'dropped: bad id' },
        { id: 'abcdefgh0002' },
        ...Array.from({ length: 40 }, (_, i) => ({ id: `abcdefgh1${String(i).padStart(3, '0')}`, title: `t${i}`, url: 'https://ok.example/p' })),
      ],
    });
    assert.equal(ok, true);
    const [d] = jonah.extras.inbox().digests;
    assert.equal(d.entries.length, 23, 'at most 25 entries read, invalid ones dropped');
    const e = d.entries[0];
    assert.equal(e.title, 'Hignp.exe', 'bidi override and zero-width characters are stripped');
    assert.equal(e.text.length, 600);
    assert.equal(e.url, null);
    assert.equal(e.author.name, '<b>x</b>', 'kept as text; React renders it as text');
    assert.equal(e.platform, 'web');
    assert.equal(e.kind, 'post');
    assert.equal(d.entries[1].url, 'https://ok.example/p');
    // A week far from now is refused.
    assert.equal(jonah.extras.receive(maya4jonah, 'digest', Date.now(), { week: epochOf() + 10, entries: [{ id: 'abcdefgh0003', title: 'x' }] }), false);
  } finally {
    done();
  }
});

test('a full shared collection fits the padded envelope; oversized bodies cannot be sealed', () => {
  const { maya, jonah, done } = pair();
  try {
    const src = maya.store.createSource({ connector: 'rss', label: 'Feed', platform: 'web', config: {} });
    maya.store.addCollection('Big');
    const ids: string[] = [];
    for (let i = 0; i < 140; i++) {
      const id = `big${i}`;
      ids.push(id);
      maya.store.upsertItem(post(id, src.id, { title: 'T'.repeat(300), text: 'Ü'.repeat(3000), url: `https://example.com/${'p'.repeat(1500)}/${i}` }));
    }
    maya.store.patchState(ids, { collections: ['Big'] });
    maya.call('POST', '/api/social/collections', {}, { name: 'Big', friends: [jonah.fp] });
    const [msg] = maya.sent;
    assert.ok(msg.bytes <= BODY_BUDGET, 'fits the largest padding bucket once base64-encoded');
    assert.ok(msg.ct <= 360_000, 'under the relay envelope cap');
    const [c] = jonah.extras.inbox().collections;
    assert.equal(c.truncated, true);
    assert.ok(c.entries.length > 0 && c.entries.length <= 100);

    assert.throws(() => seal(maya.id, jonah.id, 'mbox', newBody('coll', { pad: 'z'.repeat(300_000) })), (e: unknown) => e instanceof EnvelopeError || e instanceof Error);
  } finally {
    done();
  }
});

test('removing a friend forgets what they sent and stops sharing with them', () => {
  const { maya, jonah, done } = pair();
  try {
    const src = maya.store.createSource({ connector: 'rss', label: 'Feed', platform: 'web', config: {} });
    maya.store.addCollection('C');
    maya.store.upsertItem(post('c1', src.id));
    maya.store.patchState(['c1'], { collections: ['C'] });
    maya.call('POST', '/api/social/collections', {}, { name: 'C', friends: [jonah.fp] });
    assert.equal(jonah.extras.inbox().collections.length, 1);
    jonah.extras.forget(maya.fp);
    assert.equal(jonah.extras.inbox().collections.length, 0);
    maya.extras.forget(jonah.fp);
    assert.equal(maya.call('GET', '/api/social/collections').outgoing.length, 0);
  } finally {
    done();
  }
});

test('circles mapped to a profile route friends’ shares into it', () => {
  const fam = prof('fam', 'Family', ['rss1']);
  const work = prof('work', 'Work', ['rss2', 'friends']);
  const mom = 'a'.repeat(64);
  const boss = 'b'.repeat(64);
  const share = (fp: string, n: number) => ({ sourceId: 'friends', externalId: `${fp.slice(0, 16)}-share${n}`, provenance: { connector: 'friends', connectorVersion: 1, via: 'friend' as const } });
  const routing = { fam: [mom.slice(0, 16)] };
  const famLens = makeLens([fam, work], 'fam', routing);
  assert.equal(famLens.item(share(mom, 1)), true, 'routed friend shows even though Friends is not a source of the profile');
  assert.equal(famLens.item(share(boss, 1)), false);
  assert.equal(famLens.item({ sourceId: 'rss1', externalId: 'x', provenance: { connector: 'rss', connectorVersion: 1, via: 'feed' } }), true);
  const workLens = makeLens([fam, work], 'work', routing);
  assert.equal(workLens.item(share(boss, 1)), true, 'no circle mapped: the Friends source rule applies');
  assert.equal(makeLens([fam, work], 'all', routing).item(share(boss, 2)), true);

  const items = [share(mom, 1), share(boss, 2)].map((s, i) => ({ ...post(`aurora:${i}`, 'friends'), ...s }) as unknown as Item);
  const lib = {
    items,
    sources: [{ id: 'friends', connector: 'friends' }, { id: 'rss1', connector: 'rss' }] as any,
    views: [], topics: [], collections: [], syncRuns: [], connectors: [],
    profiles: [fam, work],
    friendRouting: routing,
  };
  const scoped = scopeLibrary(lib, 'fam');
  assert.deepEqual(scoped.items.map((i) => i.externalId), [`${mom.slice(0, 16)}-share1`]);
  assert.ok(scoped.sources.some((s) => s.id === 'friends'), 'the Friends source shows in a routed profile');
});
