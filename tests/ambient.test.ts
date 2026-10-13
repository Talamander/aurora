import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlides, excerpt, peopleIn, personKey, toSlide } from '../core/ambient.ts';
import type { Item } from '../core/types.ts';

// Fictional posts, made up for these tests.
let n = 0;
function item(p: Omit<Partial<Item>, 'state'> & { state?: Partial<Item['state']> } = {}): Item {
  n++;
  return {
    id: `t:${n}`,
    sourceId: 's1',
    platform: 'rss',
    externalId: String(n),
    url: `https://example.test/${n}`,
    author: { name: `Person ${n % 3}`, handle: `p${n % 3}` },
    text: `A fictional post number ${n} with enough words to show.`,
    links: [],
    media: [],
    kind: 'post',
    publishedAt: new Date(2026, 9, 1, 0, n).toISOString(),
    ingestedAt: new Date(2026, 9, 1).toISOString(),
    provenance: 'feed' as unknown as Item['provenance'],
    dedupeKey: `k${n}`,
    isDemo: false,
    ...p,
    state: { read: false, saved: false, archived: false, collections: [], ...(p.state ?? {}) } as Item['state'],
  } as Item;
}

test('toSlide picks a kind for each post', () => {
  assert.equal(toSlide(item({ media: [{ type: 'image', url: 'https://img.test/a.jpg' }] }))?.kind, 'photo');
  assert.equal(toSlide(item({ media: [{ type: 'video', url: 'https://v.test/a', thumb: 'https://v.test/a.jpg' }] }))?.kind, 'video');
  assert.equal(toSlide(item({ kind: 'article', title: 'A long read' }))?.kind, 'article');
  assert.equal(toSlide(item())?.kind, 'text');
  // A video without a thumbnail and with no words has nothing to show.
  assert.equal(toSlide(item({ text: 'ok', media: [{ type: 'video', url: 'https://v.test/b' }] })), null);
});

test('photos use the thumbnail (the proxied picture) before the original', () => {
  const s = toSlide(item({ media: [{ type: 'image', url: 'https://img.test/a.jpg', thumb: '/api/img?u=x' }] }));
  assert.equal(s?.image, '/api/img?u=x');
});

test('excerpt cuts at a word and marks the cut', () => {
  assert.equal(excerpt('short', 20), 'short');
  const e = excerpt('one two three four five six seven', 16);
  assert.ok(e.endsWith('…'));
  assert.ok(e.length <= 17);
  assert.ok(!e.includes('fiv'));
});

test('buildSlides filters, drops archived posts and orders newest first', () => {
  const a = item({ media: [{ type: 'image', url: 'https://img.test/1.jpg' }] });
  const b = item();
  const c = item({ state: { archived: true } });
  const d = item({ media: [{ type: 'image', url: 'https://img.test/2.jpg' }] });
  const all = buildSlides([a, b, c, d]);
  assert.deepEqual(all.map((s) => s.item.id), [d.id, b.id, a.id]);
  assert.deepEqual(buildSlides([a, b, c, d], { photosOnly: true }).map((s) => s.item.id), [d.id, a.id]);
  assert.deepEqual(buildSlides([a, b, d], { person: personKey(b) }).map((s) => s.item.id), [b.id]);
});

test('a shuffle repeats for the same seed and spreads people out', () => {
  const posts = Array.from({ length: 30 }, () => item());
  const one = buildSlides(posts, {}, { seed: 42 }).map((s) => s.item.id);
  const two = buildSlides(posts, {}, { seed: 42 }).map((s) => s.item.id);
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, buildSlides(posts).map((s) => s.item.id));
  const slides = buildSlides(posts, {}, { seed: 7 });
  for (let i = 1; i < slides.length; i++) assert.notEqual(personKey(slides[i].item), personKey(slides[i - 1].item));
});

test('peopleIn counts people with something to show', () => {
  const ppl = peopleIn([item(), item(), item(), item({ text: '' })]);
  assert.ok(ppl.length >= 2);
  assert.ok(ppl.every((p) => p.count >= 1));
});
