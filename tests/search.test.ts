// Full-text search: the query translation, snippets as plain text, ranking, sync and related posts.
// All posts here are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.ts';
import { createSearch, parseSnippet, toMatch } from '../server/search.ts';
import type { Item } from '../core/types.ts';

function draft(n: number, sourceId: string, text: string, extra: Partial<Item> = {}): Omit<Item, 'state'> {
  const publishedAt = new Date(Date.UTC(2026, 9, 1) - n * 3_600_000).toISOString();
  return {
    id: `rss:${n}`, sourceId, platform: 'rss', externalId: String(n), url: `https://example.com/${n}`,
    author: { name: 'Ada Lane', handle: 'ada' }, text, links: [], media: [], kind: 'post', publishedAt,
    ingestedAt: publishedAt, provenance: { connector: 'test', connectorVersion: 1, via: 'import' }, dedupeKey: `t:${n}`, isDemo: false,
    ...extra,
  };
}

async function withSearch(fn: (store: Store, search: ReturnType<typeof createSearch>, src: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-search-'));
  try {
    const store = new Store(dir);
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} }).id;
    const search = createSearch({ store, dataDir: dir, log: () => {} });
    await fn(store, search, src);
    search.close();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('queries translate to FTS5 with prefixes, phrases, exclusions and from:', () => {
  assert.equal(toMatch('sqlite wal')?.match, '"sqlite"* AND "wal"*');
  assert.equal(toMatch('"write ahead" -mysql')?.match, '("write ahead") NOT ("mysql")');
  assert.equal(toMatch('from:@ada rust')?.match, '"rust"* AND author : "ada"*');
  assert.deepEqual(toMatch('rust site:example.com')?.site, ['example.com']);
  assert.equal(toMatch('-only -negatives'), null);
  assert.equal(toMatch('   '), null);
  // Quotes and FTS5 operators inside a word are data, not syntax.
  assert.equal(toMatch('a"b OR')?.match, '"a""b"* AND "or"*');
});

test('snippets come back as plain text with ranges, whitespace collapsed', () => {
  const s = parseSnippet('  the \u0002WAL\u0003 mode\n\n made \u0002writes\u0003 fast  ');
  assert.equal(s.text, 'the WAL mode made writes fast');
  assert.deepEqual(s.ranges.map(([a, b]) => s.text.slice(a, b)), ['WAL', 'writes']);
  // Markup in a post stays text.
  const h = parseSnippet('<img src=x onerror=alert(1)> \u0002tag\u0003');
  assert.equal(h.text, '<img src=x onerror=alert(1)> tag');
});

test('search ranks title matches first, finds prefixes, and follows edits and deletes', async () => {
  await withSearch(async (store, search, src) => {
    store.upsertItem(draft(1, src, 'A note about gardening and some sqlite in passing.'));
    store.upsertItem(draft(2, src, 'Body text about tuning', { title: 'SQLite tuning for small servers' }));
    store.upsertItem(draft(3, src, 'Nothing relevant here at all.'));
    await search.build();
    let r = search.search('sqlite');
    assert.deepEqual(r.results.map((h) => h.id), ['rss:2', 'rss:1']);
    assert.ok(r.results[0].snippet.ranges.length > 0);
    assert.equal(search.search('sqli').results.length, 2, 'prefix match');
    assert.deepEqual(search.search('sqlite -gardening').results.map((h) => h.id), ['rss:2']);
    assert.deepEqual(search.search('from:ada tuning').results.map((h) => h.id), ['rss:2']);
    assert.equal(search.search('from:bob tuning').results.length, 0);
    // Scoped to a set of ids (a profile).
    assert.deepEqual(search.search('sqlite', { ids: new Set(['rss:1']) }).results.map((h) => h.id), ['rss:1']);

    store.upsertItem(draft(3, src, 'Now this one mentions SQLite too.'));
    r = search.search('sqlite');
    assert.equal(r.results.length, 3, 'edit is picked up on the next query');
    store.db.prepare('DELETE FROM items WHERE id = ?').run('rss:1');
    assert.deepEqual(search.search('gardening').results, [], 'delete is picked up');
    assert.equal(search.status().indexed, 2);
  });
});

test('a restart re-indexes only what changed, and highlights are searchable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-search-'));
  try {
    const store = new Store(dir);
    const src = store.createSource({ connector: 'rss', label: 'Feed', platform: 'rss', config: {} }).id;
    for (let n = 0; n < 50; n++) store.upsertItem(draft(n, src, `post number ${n} about compilers`));
    let search = createSearch({ store, dataDir: dir, log: () => {} });
    await search.build();
    assert.equal(search.status().indexed, 50);
    search.close();

    store.db.exec(`CREATE TABLE IF NOT EXISTS lf_highlights (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, block INTEGER NOT NULL DEFAULT 0, quote TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'lamp', created_at TEXT NOT NULL)`);
    store.db.prepare('INSERT INTO lf_highlights(id, item_id, quote, note, created_at) VALUES(?,?,?,?,?)').run('h1', 'rss:7', 'register allocation', 'reread this zebra', new Date().toISOString());
    search = createSearch({ store, dataDir: dir, log: () => {} });
    await search.build();
    assert.deepEqual(search.search('zebra').results.map((h) => h.id), ['rss:7']);
    search.close();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('more like this prefers shared rare words and skips the post itself', async () => {
  await withSearch(async (store, search, src) => {
    store.upsertItem(draft(1, src, 'Kestrels hover over the meadow hunting voles at dusk.'));
    store.upsertItem(draft(2, src, 'A kestrel was hunting voles near the meadow fence.', { author: { name: 'Bo Reed' } }));
    store.upsertItem(draft(3, src, 'The meadow had a picnic and some music.', { author: { name: 'Cy North' } }));
    for (let n = 4; n < 30; n++) store.upsertItem(draft(n, src, `Unrelated post ${n} about databases and queues.`, { author: { name: `Person ${n}` } }));
    await search.build();
    const rel = search.related('rss:1');
    assert.ok(rel.length >= 1);
    assert.equal(rel[0].id, 'rss:2');
    assert.ok(rel[0].shared.includes('voles'));
    assert.ok(!rel.some((h) => h.id === 'rss:1'));
  });
});
