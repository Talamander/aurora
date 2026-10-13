// The cached item list and the chunked library wire format must never serve stale data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.ts';
import { chunkItems, createLibraryWire, MAX_CHUNK } from '../server/libraryWire.ts';
import type { Item } from '../core/types.ts';

function draft(n: number, sourceId: string, publishedAt: string, text = `post ${n}`): Omit<Item, 'state'> {
  return {
    id: `rss:${n}`, sourceId, platform: 'rss', externalId: String(n), url: `https://example.com/${n}`,
    author: { name: 'Ada' }, text, links: [], media: [], kind: 'post', publishedAt,
    ingestedAt: publishedAt, provenance: { connector: 'test', connectorVersion: 1, via: 'import' }, dedupeKey: `t:${n}`, isDemo: false,
  };
}
const day = (d: number) => new Date(Date.UTC(2026, 9, 1) - d * 86_400_000).toISOString();
const fresh = (store: Store) =>
  (store.db.prepare('SELECT i.id, s.read FROM items i LEFT JOIN item_state s ON s.item_id = i.id ORDER BY i.published_at DESC').all() as { id: string; read: number | null }[]).map((r) => `${r.id}:${r.read ?? 0}`);
const cached = (store: Store) => store.listItems().map((i) => `${i.id}:${+i.state.read}`);

function withStore(fn: (store: Store, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-cache-'));
  try {
    const store = new Store(dir);
    fn(store, dir);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the item cache follows inserts, state changes, raw deletes and other connections', () => {
  withStore((store, dir) => {
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} });
    for (let n = 0; n < 20; n++) store.upsertItem(draft(n, src.id, day(n)));
    const first = store.listItems();
    const v1 = store.itemsVersion();
    assert.deepEqual(cached(store), fresh(store));
    assert.equal(store.itemsVersion(), v1, 'no change, same version');
    assert.ok(store.listItems().every((it, i) => it === first[i]), 'unchanged items keep their identity');

    store.patchState(['rss:3'], { read: true });
    const second = store.listItems();
    assert.notEqual(store.itemsVersion(), v1);
    assert.deepEqual(cached(store), fresh(store));
    assert.notEqual(second[3], first[3]);
    assert.equal(second[4], first[4], 'only the changed item is re-read');

    // Writes whose statements carry their own conflict policy (upserts) must still work.
    store.patchState(['rss:3'], { saved: true });
    store.patchState(['rss:3'], { read: false });
    store.upsertItem(draft(4, src.id, day(4), 'post 4, edited'));
    assert.deepEqual(cached(store), fresh(store));
    assert.equal(store.listItems().find((i) => i.id === 'rss:4')?.text, 'post 4, edited');
    assert.equal(store.listItems().find((i) => i.id === 'rss:3')?.state.saved, true);

    store.upsertItem(draft(99, src.id, day(-1)));
    assert.deepEqual(cached(store), fresh(store));
    assert.equal(store.listItems()[0].id, 'rss:99', 'a newer post goes on top');

    store.tx(() => {
      store.db.prepare('DELETE FROM item_state WHERE item_id = ?').run('rss:3');
      store.db.prepare('DELETE FROM items WHERE id = ?').run('rss:5');
    });
    assert.deepEqual(cached(store), fresh(store));

    // A rolled back write leaves the cache as it was.
    assert.throws(() => store.tx(() => {
      store.db.prepare('INSERT INTO item_state(item_id, read, saved, archived, collections) VALUES(?, 1, 0, 0, ?)').run('rss:6', '[]');
      throw new Error('nope');
    }), /nope/);
    assert.deepEqual(cached(store), fresh(store));

    // Another connection (the MCP server with writes on, a second process).
    const other = new Store(dir);
    other.patchState(['rss:7'], { read: true });
    other.upsertItem(draft(100, src.id, day(-2)));
    other.db.close();
    assert.deepEqual(cached(store), fresh(store));
    assert.equal(store.listItems()[0].id, 'rss:100');

    store.deleteSource(src.id);
    assert.deepEqual(store.listItems(), []);
  });
});

test('a read-only connection (the MCP server) sees writes from the app', () => {
  withStore((store) => {
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} });
    store.upsertItem(draft(1, src.id, day(1)));
    const ro = Object.create(Store.prototype) as Store;
    ro.db = new DatabaseSync(store.path, { readOnly: true });
    assert.deepEqual(ro.listItems().map((i) => i.id), ['rss:1']);
    store.upsertItem(draft(2, src.id, day(0)));
    store.patchState(['rss:1'], { read: true });
    assert.deepEqual(ro.listItems().map((i) => `${i.id}:${+i.state.read}`), ['rss:2:0', 'rss:1:1']);
    ro.db.close();
  });
});

test('callers get their own array', () => {
  withStore((store) => {
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} });
    store.upsertItem(draft(1, src.id, day(1)));
    const a = store.listItems();
    a.length = 0;
    assert.equal(store.listItems().length, 1);
  });
});

test('the full library is byte-for-byte what JSON.stringify used to send, and chunks add up to it', () => {
  withStore((store) => {
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} });
    for (let n = 0; n < 60; n++) store.upsertItem(draft(n, src.id, day(n), `post ${n} “quoted” ünïcode`));
    const rest = () => ({ sources: store.listSources(), views: store.listViews(), topics: store.listTopics(), collections: store.listCollections(), syncRuns: [], connectors: [], aiProgress: undefined });
    const wire = createLibraryWire({ version: () => store.itemsVersion(), items: () => store.listItems(), rest });
    const expected = JSON.stringify({ items: store.listItems(), ...rest() });
    assert.equal(wire.full(null).body().toString(), expected);
    assert.equal(gunzipSync(wire.full('gzip').body()).toString(), expected);

    const m = wire.manifest();
    assert.equal(m.itemsTotal, 60);
    assert.ok(m.itemChunks.length >= 8, 'one chunk per week');
    const joined = m.itemChunks.flatMap((c) => JSON.parse(wire.chunk(c.key, null)!.body.toString()) as Item[]);
    assert.deepEqual(joined.map((i) => i.id), store.listItems().map((i) => i.id));

    const etag = wire.full(null).etag;
    assert.equal(wire.full(null).etag, etag, 'stable while nothing changes');
    store.patchState(['rss:0'], { saved: true });
    assert.notEqual(wire.full(null).etag, etag);
    const m2 = wire.manifest();
    const changed = m2.itemChunks.filter((c, i) => c.hash !== m.itemChunks[i].hash);
    assert.equal(changed.length, 1, 'saving one post changes one chunk');
    assert.equal(changed[0].key, m.itemChunks[0].key);
    assert.equal(wire.chunk('no-such-week', null), null);
  });
});

test('a busy week is split, and rewriting a post unchanged keeps its chunk hash', () => {
  const items = Array.from({ length: MAX_CHUNK + 10 }, (_, n) => ({ ...draft(n, 's', day(0)), state: { read: false, saved: false, archived: false, collections: [] } }) as Item);
  const a = chunkItems(items);
  assert.deepEqual(a.map((c) => c.n), [MAX_CHUNK, 10]);
  const copy = items.map((it) => ({ ...it }));
  const b = chunkItems(copy, new Map(a.map((c) => [c.key, c])));
  assert.deepEqual(b.map((c) => c.hash), a.map((c) => c.hash));
});
