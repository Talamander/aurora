import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontPage, toStory } from '../core/frontPage.ts';
import type { Evaluation } from '../core/filter.ts';
import type { Item, ItemState } from '../core/types.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const item = (id: string, over: Partial<Item> = {}, state: Partial<ItemState> = {}): Item =>
  ({
    id, sourceId: 's1', platform: 'rss', externalId: id, url: `https://example.com/${id}`, author: { name: 'Ann', handle: 'ann' },
    text: `A post called ${id} with enough words in it to be worth setting on the page.`, links: [], media: [], kind: 'post',
    publishedAt: hoursAgo(2), isDemo: false, state: { read: false, saved: false, archived: false, collections: [], ...state }, ...over,
  }) as unknown as Item;

const ev = (it: Item, over: Partial<Evaluation> = {}): Evaluation =>
  ({ item: it, visible: true, hidden: [], matched: [], noise: { isNoise: false, reasons: [] }, topics: [], duplicateOf: null, duplicates: [], score: 0, ...over }) as unknown as Evaluation;

const pic = (u = 'https://img.example.com/a.jpg') => [{ type: 'image', url: u }] as Item['media'];

test('the lead is a story with a picture, and no post appears twice', () => {
  const items = [
    item('plain', { sourceId: 's1' }),
    item('article', { sourceId: 's2', kind: 'article', title: 'A long read about rivers', text: 'Rivers move. '.repeat(40), media: pic() }),
    item('photo', { sourceId: 's3', media: pic('https://img.example.com/b.jpg') }),
    ...Array.from({ length: 12 }, (_, i) => item(`p${i}`, { sourceId: `s${i % 4}`, publishedAt: hoursAgo(3 + i) })),
  ];
  const page = buildFrontPage(items.map((i) => ev(i)), items, { now: NOW });
  assert.equal(page.lead?.item.id, 'article');
  assert.equal(page.lead?.head, 'A long read about rivers');
  const ids = [page.lead!, ...page.secondary, ...page.photos, ...page.briefs, ...page.people.map((p) => p.story)].map((s) => s.item.id);
  assert.equal(new Set(ids).size, ids.length);
  // Secondary stories never share a source with each other or the lead.
  const srcs = [page.lead!, ...page.secondary].map((s) => s.item.sourceId);
  assert.equal(new Set(srcs).size, srcs.length);
});

test('hidden posts, duplicates and archived posts stay off the page', () => {
  const a = item('a'), b = item('b'), c = item('c', {}, { archived: true });
  const page = buildFrontPage([ev(a, { visible: false }), ev(b, { duplicateOf: 'x' }), ev(c)], [a, b, c], { now: NOW });
  assert.equal(page.lead, null);
  assert.equal(page.considered, 0);
});

test('only https or proxied pictures are used', () => {
  assert.equal(toStory(item('h', { media: pic('http://insecure.example.com/a.jpg') }))?.image, undefined);
  assert.equal(toStory(item('j', { media: [{ type: 'image', url: 'javascript:alert(1)' }] as Item['media'] }))?.image, undefined);
  assert.equal(toStory(item('p', { media: [{ type: 'image', url: 'https://x/a.jpg', thumb: '/api/img?u=x&t=y' }] as Item['media'] }))?.image, '/api/img?u=x&t=y');
});

test('people you keep get a box with their own story', () => {
  const lib = [
    item('old1', { author: { name: 'Bea', handle: 'bea' }, publishedAt: hoursAgo(200) }, { saved: true }),
    item('old2', { author: { name: 'Bea', handle: 'bea' }, publishedAt: hoursAgo(220) }, { saved: true }),
  ];
  const fresh = [
    item('lead', { kind: 'article', title: 'Big news', text: 'Words '.repeat(80), media: pic() }),
    item('bea-new', { sourceId: 's9', author: { name: 'Bea', handle: 'bea' } }),
  ];
  const all = [...lib, ...fresh];
  const page = buildFrontPage(fresh.map((i) => ev(i)), all, { now: NOW });
  assert.equal(page.people[0]?.name, 'Bea');
  assert.equal(page.people[0]?.kept, 6);
});

test('an old library still gets a front page from its newest posts', () => {
  const items = Array.from({ length: 5 }, (_, i) => item(`o${i}`, { publishedAt: hoursAgo(24 * 30 + i) }));
  const page = buildFrontPage(items.map((i) => ev(i)), items, { now: NOW });
  assert.ok(page.lead);
  assert.equal(page.newest, items[0].publishedAt);
});
