import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeek, weekFromId, weekId, weekRange, weekStart } from '../core/week.ts';
import type { Item, Library } from '../core/types.ts';

const start = weekStart(new Date(2026, 9, 7, 12)); // Monday 5 October 2026
const { end } = weekRange(start);
const day = (d: number, h = 10) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h).toISOString();

let n = 0;
function item(p: Omit<Partial<Item>, 'state'> & { state?: Partial<Item['state']> } = {}): Item {
  n++;
  return {
    id: `t:${n}`, sourceId: 's1', platform: 'rss', externalId: String(n), url: `https://example.com/${n}`,
    author: { name: 'Ada', handle: 'ada' }, text: 'A thoughtful note about compilers and type systems.', links: [], media: [],
    kind: 'post', publishedAt: day(1), ingestedAt: day(1), provenance: { connector: 'rss', connectorVersion: 1, via: 'feed' },
    dedupeKey: `k${n}`, isDemo: false,
    ...p,
    state: { read: false, saved: false, archived: false, collections: [], noiseOverride: null, readAt: null, savedAt: null, ...p.state },
  } as Item;
}

const lib = (items: Item[]): Library => ({
  items, sources: [{ id: 's1', label: 'Ada · Blog', platform: 'rss' } as any, { id: 's2', label: 'Grace · Blog', platform: 'rss' } as any],
  views: [], topics: [{ id: 'tp', name: 'Compilers', terms: ['compilers'] }], collections: [], syncRuns: [], connectors: [],
});

test('week ids round-trip, including the 53-week year', () => {
  assert.equal(weekId(start), '2026-W41');
  assert.equal(weekFromId('2026-W41')?.getTime(), start.getTime());
  assert.equal(weekId(weekStart(new Date(2026, 11, 31))), '2026-W53');
  assert.equal(weekId(weekStart(new Date(2026, 0, 1))), '2026-W01');
  assert.equal(weekFromId('2026-W99'), null);
});

test('counts reading inside the week only, and what rules set aside', () => {
  const longread = item({ kind: 'article', title: 'How compilers think', author: { name: 'Grace', handle: 'grace' }, sourceId: 's2', state: { read: true, readAt: day(2), saved: true, savedAt: day(2) } });
  const items = [
    longread,
    item({ state: { read: true, readAt: day(0) } }),
    item({ state: { read: true, readAt: day(2, 22) } }),
    item({ state: { read: true, readAt: day(-1) } }), // last week: not counted
    item({ state: { read: true, readAt: day(7) } }), // next week: not counted
    item({ text: 'Like if you agree! Follow for more! Comment below!' }), // engagement bait: set aside
    item({ state: { noiseOverride: false } }), // marked as noise by the reader
    item({ ingestedAt: day(-3), publishedAt: day(-3) }), // compilers last week, for growth
  ];
  const s = computeWeek({
    lib: lib(items),
    reading: [{ itemId: longread.id, progress: 1, updatedAt: day(2) }, { itemId: longread.id + 'x', progress: 1, updatedAt: day(2) }],
    words: { [longread.id]: 2300 },
    highlights: [{ id: 'h1', itemId: longread.id, quote: 'A compiler is a promise.', createdAt: day(2) }],
    start,
    end,
  });
  assert.equal(s.weekId, '2026-W41');
  assert.equal(s.read, 3);
  assert.equal(s.saved, 1);
  assert.equal(s.minutes, 10); // 2300 words at 230 a minute, read to the end
  assert.equal(s.articles, 1);
  assert.equal(s.highlights, 1);
  assert.deepEqual(s.days, [1, 0, 2, 0, 0, 0, 0]);
  assert.equal(s.arrived, 7);
  assert.equal(s.setAside, 2);
  assert.equal(s.noise, 2);
  assert.equal(s.best?.itemId, longread.id);
  assert.equal(s.best?.highlight?.quote, 'A compiler is a promise.');
  assert.equal(s.people[0].name, 'Ada');
  assert.equal(s.topic?.name, 'Compilers');
  assert.equal(s.topic?.before, 1);
  assert.equal(s.quiet, false);
});

test('a week with nothing read is quiet, and demo posts count only in an all-demo library', () => {
  const s = computeWeek({ lib: lib([item(), item({ isDemo: true, state: { read: true, readAt: day(1) } })]), reading: [], words: {}, highlights: [], start, end });
  assert.equal(s.quiet, true);
  assert.equal(s.read, 0);
  assert.equal(s.best, null);
  const demo = computeWeek({ lib: lib([item({ isDemo: true, state: { read: true, readAt: day(1) } })]), reading: [], words: {}, highlights: [], start, end });
  assert.equal(demo.read, 1);
});
