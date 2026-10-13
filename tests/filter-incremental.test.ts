// Re-filtering after a few items change must match a full pass exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_SPEC, normalizeSpec } from '../core/filter.ts';
import type { FilterSpec, Item } from '../core/types.ts';

const words = ['sqlite', 'garden', 'giveaway follow like', 'rust', 'coffee'];
const items: Item[] = Array.from({ length: 300 }, (_, k) => ({
  id: `rss:${k}`,
  sourceId: 'src-a',
  platform: 'rss',
  externalId: String(k),
  url: `https://example.com/post/${k}`,
  author: { name: 'Ada Example', handle: 'ada' },
  text: `${words[k % 5]} post ${k}`,
  links: [],
  media: [],
  lang: 'en',
  kind: 'post',
  publishedAt: new Date(Date.UTC(2026, 9, 10) - Math.floor(k / 2) * 3_600_000).toISOString(),
  ingestedAt: '2026-10-10T12:00:00.000Z',
  provenance: { connector: 'rss', connectorVersion: 1, via: 'feed' },
  // Two in every ten share a dedupe key, so changes to those re-check their whole group.
  dedupeKey: k % 10 < 2 ? `shared:${Math.floor(k / 10)}` : `t:${k}`,
  isDemo: false,
  state: { read: k % 3 === 0, saved: k % 17 === 0, archived: false, collections: [] },
}));

const dups = (e: ReturnType<typeof applyFilters>['visible'][number]) => `${e.item.id}<${e.duplicateOf ?? ''}>${e.duplicates.join(',')}`;
const shape = (r: ReturnType<typeof applyFilters>) => ({ v: r.visible.map(dups), h: r.hidden.map(dups), by: r.hiddenBy });

test('passing the previous result gives the same answer as a full pass', () => {
  const specs: Partial<FilterSpec>[] = [
    { read: 'unread', hideNoise: true },
    { query: 'sqlite', sort: 'relevance' },
    { hideDuplicates: true, sort: 'oldest' },
    { saved: 'saved', archived: 'any' },
  ];
  for (const partial of specs) {
    const spec = normalizeSpec({ ...DEFAULT_SPEC, ...partial });
    let list = items;
    let keep: ReadonlySet<string> = new Set();
    let prev = applyFilters(list, spec, { topics: [], keepRead: keep });
    for (const step of [[4, 5], [0], [1, 11, 12], [150, 151, 152, 153], []]) {
      list = list.map((it, i) => (step.includes(i) ? { ...it, state: { ...it.state, read: !it.state.read, saved: !it.state.saved } } : it));
      keep = new Set([...keep, ...step.map((i) => list[i].id)]);
      const quick = applyFilters(list, spec, { topics: [], keepRead: keep }, prev);
      const full = applyFilters(list, spec, { topics: [], keepRead: keep });
      assert.deepEqual(shape(quick), shape(full), `${JSON.stringify(partial)} after changing ${step}`);
      prev = quick;
    }
  }
});

test('a different spec or list size never reuses the previous result', () => {
  const spec = normalizeSpec({ ...DEFAULT_SPEC });
  const prev = applyFilters(items, spec, { topics: [] });
  const other = normalizeSpec({ ...DEFAULT_SPEC, query: 'rust' });
  assert.deepEqual(shape(applyFilters(items, other, { topics: [] }, prev)), shape(applyFilters(items, other, { topics: [] })));
  const fewer = items.slice(10);
  assert.deepEqual(shape(applyFilters(fewer, spec, { topics: [] }, prev)), shape(applyFilters(fewer, spec, { topics: [] })));
});
