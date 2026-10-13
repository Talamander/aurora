import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, sourceReports } from '../core/sourceReport.ts';
import type { Item, Source } from '../core/types.ts';

const NOW = new Date(2026, 9, 13, 12, 0);
const src = (id: string, ageDays = 90): Source =>
  ({ id, connector: 'rss', label: id.toUpperCase(), platform: 'rss', config: {}, status: 'ok', itemCount: 0, enabled: true, isDemo: false, createdAt: new Date(NOW.getTime() - ageDays * 86_400_000).toISOString() }) as Source;
let n = 0;
const post = (sourceId: string, daysAgo: number, state: Partial<Item['state']> = {}, text = 'A thoughtful post about type design and long reads'): Item =>
  ({
    id: `p${++n}`, sourceId, platform: 'rss', externalId: String(n), url: `https://example.com/${n}`, author: { name: 'A' }, text, links: [], media: [], kind: 'post',
    publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    state: { read: false, saved: false, archived: false, collections: [], ...state },
  }) as unknown as Item;

test('counts, daily buckets and verdicts per source', () => {
  const items: Item[] = [];
  // a: 40 posts, 4 saved, 20 read: keep.
  for (let i = 0; i < 40; i++) items.push(post('a', i % 30, { read: i < 20, saved: i < 4 }));
  // b: 60 posts, nothing kept, 2 read: let go.
  for (let i = 0; i < 60; i++) items.push(post('b', i % 30, { read: i < 2 }));
  // c: an old post outside the window is ignored; one Read later finished and one alert hit.
  items.push(post('c', 45, { saved: true }));
  const later = post('c', 2, { read: true, collections: ['Read later'] });
  const hit = post('c', 3);
  items.push(later, hit);
  const reps = sourceReports({ items, sources: [src('a'), src('b'), src('c'), src('d', 2)], ctx: { topics: [] }, alertHits: new Set([hit.id]), highlighted: new Set([later.id]), now: NOW });
  const by = Object.fromEntries(reps.map((r) => [r.sourceId, r]));
  assert.equal(by.a.posts, 40);
  assert.equal(by.a.saved, 4);
  assert.equal(by.a.read, 20);
  assert.equal(by.a.verdict, 'keep');
  assert.equal(by.a.daily.posts.reduce((x, y) => x + y, 0), 40);
  assert.equal(by.a.daily.posts.length, 30);
  assert.equal(by.b.verdict, 'let-go');
  assert.match(by.b.reason, /You kept none of its 60 posts in 30 days/);
  assert.equal(by.c.posts, 2);
  assert.equal(by.c.laterDone, 1);
  assert.equal(by.c.highlighted, 1);
  assert.equal(by.c.alertHits, 1);
  assert.equal(by.c.kept, 2);
  assert.equal(by.d.verdict, 'new');
  // Let go sorts first.
  assert.equal(reps[0].sourceId, 'b');
});

test('judge wording carries the numbers', () => {
  const busy = { posts: 412, read: 40, kept: 2, saved: 2, rulesHid: 251, hidden: 0 };
  assert.equal(judge(busy, 60).verdict, 'quieter');
  assert.match(judge(busy, 60).reason, /You kept 2 of 412 posts in 30 days .*rules hid 61%/);
  assert.equal(judge({ posts: 0, read: 0, kept: 0, saved: 0, rulesHid: 0, hidden: 0 }, 60).verdict, 'keep');
  assert.equal(judge({ posts: 10, read: 1, kept: 1, saved: 1, rulesHid: 0, hidden: 0 }, 60).verdict, 'keep');
});
