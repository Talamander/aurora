// Thread grouping: explicit self-replies, numbered chains, and the cases that must stay apart.
// Every post here is a test fixture, not app data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleFromThread, collapseThreads, groupThreads, stripMarker, threadFor, threadMarker } from '../core/threads.ts';
import type { Item } from '../core/types.ts';

const T0 = Date.parse('2026-10-13T08:00:00Z');
let seq = 0;
function post(p: Partial<Item> & { text: string; min?: number; who?: string }): Item {
  const ext = p.externalId ?? `t${++seq}`;
  const platform = p.platform ?? 'bluesky';
  const who = p.who ?? 'ana';
  return {
    id: `${platform}:${ext}`,
    sourceId: p.sourceId ?? 'src-1',
    platform,
    externalId: ext,
    url: `https://example.test/${ext}`,
    author: { name: who.toUpperCase(), handle: `@${who}` },
    text: p.text,
    links: [],
    media: p.media ?? [],
    kind: p.kind ?? 'post',
    replyTo: p.replyTo ?? null,
    publishedAt: new Date(T0 + (p.min ?? 0) * 60_000).toISOString(),
    ingestedAt: new Date(T0).toISOString(),
    provenance: { connector: 'test', connectorVersion: 1, via: 'api' },
    dedupeKey: `k-${ext}`,
    isDemo: false,
    state: { read: false, saved: false, archived: false, collections: [] },
  };
}

test('thread markers read numbers and the spool, not fractions or dates', () => {
  assert.deepEqual(threadMarker({ text: '1/ Here is why', kind: 'post' }), { n: 1, of: null });
  assert.deepEqual(threadMarker({ text: 'and that is the point 2/7', kind: 'post' }), { n: 2, of: 7 });
  assert.deepEqual(threadMarker({ text: 'The end (7/7)', kind: 'post' }), { n: 7, of: 7 });
  assert.deepEqual(threadMarker({ text: 'A thread \u{1F9F5}', kind: 'post' }), { n: null, of: null });
  assert.equal(threadMarker({ text: 'Rated it 9/5, would not recommend', kind: 'post' }), null);
  assert.equal(threadMarker({ text: 'see https://example.com/a/1/2', kind: 'post' }), null);
  assert.equal(threadMarker({ text: 'Meeting moved to 2026/10/14', kind: 'post' }), null);
  assert.equal(threadMarker({ text: 'Just a post', kind: 'post' }), null);
});

test('explicit self-replies form one thread rooted at the first post', () => {
  const a = post({ text: 'Root post about caching', externalId: 'at://a' });
  const b = post({ text: 'second part', externalId: 'at://b', replyTo: 'at://a', kind: 'reply', min: 1 });
  const c = post({ text: 'third part', externalId: 'at://c', replyTo: 'at://b', kind: 'reply', min: 2 });
  const g = groupThreads([c, b, a]);
  assert.deepEqual(threadFor(g, c.id), [a.id, b.id, c.id]);
  assert.equal(g.threadOf.get(b.id), a.id);
});

test('a reply to someone else never joins their thread', () => {
  const a = post({ text: 'Ana starts', externalId: 'at://a1' });
  const b = post({ text: 'Bo replies', externalId: 'at://b1', replyTo: 'at://a1', kind: 'reply', who: 'bo', min: 1 });
  const c = post({ text: 'Ana answers Bo', externalId: 'at://a2', replyTo: 'at://b1', kind: 'reply', min: 2 });
  const g = groupThreads([a, b, c]);
  assert.equal(g.threadOf.size, 0);
});

test('numbered posts from one author chain within 15 minutes', () => {
  const list = [
    post({ text: 'Why design systems fail 1/3', min: 0 }),
    post({ text: '2/3 They document components, not decisions.', min: 2 }),
    post({ text: 'Write the decision down. 3/3', min: 10 }),
    post({ text: 'Unrelated lunch post', min: 11 }),
  ];
  const g = groupThreads(list);
  assert.deepEqual(threadFor(g, list[2].id), [list[0].id, list[1].id, list[2].id]);
  assert.equal(threadFor(g, list[3].id), null);
});

test('numbered posts by different authors or sources stay apart', () => {
  const list = [
    post({ text: 'Ana on caching 1/2', min: 0 }),
    post({ text: '2/2 from Bo, about something else', who: 'bo', min: 1 }),
    post({ text: '2/2 Ana, but from another source', sourceId: 'src-2', min: 1 }),
  ];
  assert.equal(groupThreads(list).threadOf.size, 0);
});

test('false positives: a gap, a skipped number, a lone middle and a repost do not chain', () => {
  const gap = [post({ text: 'Part one 1/2', min: 0 }), post({ text: 'Part two 2/2', min: 40 })];
  assert.equal(groupThreads(gap).threadOf.size, 0);
  const skip = [post({ text: '1/ start', min: 0 }), post({ text: '3/ jumped', min: 1 })];
  assert.equal(groupThreads(skip).threadOf.size, 0);
  const middle = [post({ text: 'Scored 4/5', min: 0 }), post({ text: 'Now 5/5', min: 1 })];
  assert.equal(groupThreads(middle).threadOf.size, 0);
  const rp = [post({ text: '1/2 original', min: 0, kind: 'repost' }), post({ text: '2/2 original', min: 1, kind: 'repost' })];
  assert.equal(groupThreads(rp).threadOf.size, 0);
  const totals = [post({ text: '1/3 a', min: 0 }), post({ text: '2/5 b', min: 1 })];
  assert.equal(groupThreads(totals).threadOf.size, 0);
});

test('a spool opener takes a numbered follow-up', () => {
  const list = [post({ text: 'A thread on on-call notes \u{1F9F5}', min: 0 }), post({ text: '1/ Say what is broken.', min: 3 }), post({ text: '2/ Say what you tried.', min: 4 })];
  const g = groupThreads(list);
  assert.equal(threadFor(g, list[2].id)?.length, 3);
});

test('collapse keeps one entry per thread at the first visible place, preferring the root', () => {
  const list = [post({ text: 'Start 1/3', min: 0 }), post({ text: '2/3 middle', min: 1 }), post({ text: '3/3 end', min: 2 }), post({ text: 'solo', min: 3 })];
  const g = groupThreads(list);
  const newestFirst = [...list].reverse().map((item) => ({ item }));
  const out = collapseThreads(newestFirst, g);
  assert.deepEqual(out.map((e) => e.item.text), ['solo', 'Start 1/3']);
  // Root filtered out: the first visible member stands in for it.
  const noRoot = collapseThreads(newestFirst.filter((e) => e.item.id !== list[0].id), g);
  assert.deepEqual(noRoot.map((e) => e.item.text), ['solo', '3/3 end']);
});

test('the thread article joins the posts in order, strips numbering and keeps each link', () => {
  const list = [
    post({ text: 'Why design systems fail 1/2', min: 0, media: [{ type: 'image', url: 'https://img.test/a.jpg' }, { type: 'image', url: 'http://img.test/insecure.jpg' }] }),
    post({ text: '2/2 They document components.\n\nNot decisions.', min: 1 }),
  ];
  const a = articleFromThread(list)!;
  assert.equal(a.itemId, list[0].id);
  assert.equal(a.title, 'Why design systems fail');
  const texts = a.blocks.map((b) => (b.t === 'p' ? b.spans.map((s) => s.text).join('') : b.t));
  assert.deepEqual(texts, ['Why design systems fail', 'img', '1 of 2', 'They document components.', 'Not decisions.', '2 of 2']);
  const links = a.blocks.flatMap((b) => (b.t === 'p' ? b.spans.filter((s) => s.href).map((s) => s.href) : []));
  assert.deepEqual(links, [list[0].url, list[1].url]);
  assert.equal(stripMarker('(3/7) last bit'), 'last bit');
});

test('grouping 100k posts stays fast', () => {
  const items: Item[] = [];
  for (let i = 0; i < 100_000; i++) {
    const t = i % 50 === 0 ? `${(i / 50) % 3 + 1}/3 numbered part` : i % 7 === 0 ? 'ratio 3/4 of people agree' : `plain post number ${i}`;
    items.push(post({ text: t, who: `u${i % 400}`, sourceId: `s${i % 60}`, min: i }));
  }
  groupThreads(items.slice()); // warm the JIT on a different array
  const t0 = performance.now();
  groupThreads(items);
  const ms = performance.now() - t0;
  assert.ok(ms < 120, `took ${ms.toFixed(1)} ms`);
  console.log(`groupThreads 100k: ${ms.toFixed(1)} ms`);
});
