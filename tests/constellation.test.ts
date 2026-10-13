import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounds, buildConstellation, engagement, neighbourIn, simulate } from '../core/constellation.ts';
import type { Item, Source, Topic } from '../core/types.ts';

const NOW = new Date(2026, 9, 13, 12, 0);
const src = (id: string, platform = 'rss'): Source =>
  ({ id, connector: 'rss', label: id.toUpperCase(), platform, config: {}, status: 'ok', itemCount: 0, enabled: true, isDemo: false, createdAt: NOW.toISOString() }) as Source;
let n = 0;
const post = (sourceId: string, author: string, daysAgo: number, state: Partial<Item['state']> = {}, text = 'A post'): Item =>
  ({
    id: `p${++n}`, sourceId, platform: 'rss', externalId: String(n), url: `https://example.com/${n}`, author: { name: author, handle: `@${author.toLowerCase()}` }, text, links: [], media: [], kind: 'post',
    publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), isDemo: false,
    state: { read: false, saved: false, archived: false, collections: [], ...state },
  }) as unknown as Item;

const topics: Topic[] = [{ id: 'type', name: 'Type design', terms: ['kerning'] }, { id: 'home', name: 'Home lab', terms: ['proxmox'] }];

test('engagement weighs saves and highlights above reads', () => {
  const p = post('a', 'Ann', 1, { read: true, saved: true });
  assert.equal(engagement(p), 4);
  assert.equal(engagement(p, new Set([p.id])), 7);
  assert.equal(engagement(post('a', 'Ann', 1, { collections: ['Read later'] })), 1);
});

test('builds people, sources and topics with links, inside the window only', () => {
  const items = [
    post('a', 'Ann', 1, { read: true, saved: true }, 'Notes on kerning'),
    post('a', 'Ann', 2, { read: true }, 'More kerning'),
    post('b', 'Ann', 3, {}, 'proxmox cluster'),
    post('b', 'Bob', 4, { read: true }, 'proxmox again'),
    post('b', 'Bob', 5),
    post('b', 'Bob', 6),
    post('a', 'Old', 200, { saved: true }, 'kerning long ago'),
    post('a', 'Quiet', 3), // one post, no engagement: stays out
  ];
  const g = buildConstellation({ items, sources: [src('a'), src('b', 'bluesky')], topics, now: NOW });
  const ids = g.nodes.map((x) => x.id).sort();
  assert.deepEqual(ids, ['p:@ann', 'p:@bob', 's:a', 's:b', 't:home', 't:type']);
  assert.equal(g.posts, 7);
  const ann = g.nodes.find((x) => x.id === 'p:@ann')!;
  assert.equal(ann.posts, 3);
  assert.equal(ann.saved, 1);
  assert.equal(ann.platform, 'rss'); // posts in a most
  assert.equal(ann.lastText, 'Notes on kerning');
  const bob = g.nodes.find((x) => x.id === 'p:@bob')!;
  assert.equal(bob.platform, 'bluesky');
  assert.ok(ann.r > bob.r, 'more engagement, bigger star');
  const linked = (a: string, b: string) => g.links.some((l) => (g.nodes[l.a].id === a && g.nodes[l.b].id === b) || (g.nodes[l.a].id === b && g.nodes[l.b].id === a));
  assert.ok(linked('p:@ann', 's:a'));
  assert.ok(linked('p:@ann', 't:type'));
  assert.ok(linked('p:@bob', 't:home'));
  assert.ok(linked('t:home', 's:b'));
  assert.ok(!linked('p:@bob', 's:a'));
});

test('caps node counts and stays deterministic', () => {
  const items: Item[] = [];
  for (let i = 0; i < 400; i++) items.push(post(`s${i % 40}`, `P${i}`, i % 80, { read: i % 2 === 0, saved: i % 7 === 0 }));
  const sources = Array.from({ length: 40 }, (_, i) => src(`s${i}`));
  const g1 = buildConstellation({ items, sources, topics, now: NOW });
  const g2 = buildConstellation({ items, sources, topics, now: NOW });
  assert.ok(g1.nodes.length <= 150);
  assert.equal(g1.nodes.filter((x) => x.kind === 'source').length, 24);
  assert.deepEqual(g1.nodes.map((x) => [x.id, x.x, x.y]), g2.nodes.map((x) => [x.id, x.x, x.y]));
});

test('layout settles without overlap between big nodes and finds arrow neighbours', () => {
  const items: Item[] = [];
  for (let i = 0; i < 120; i++) items.push(post(`s${i % 6}`, `P${i % 30}`, i % 60, { read: i % 3 === 0, saved: i % 9 === 0 }, i % 2 ? 'kerning' : 'proxmox'));
  const g = buildConstellation({ items, sources: Array.from({ length: 6 }, (_, i) => src(`s${i}`)), topics, now: NOW });
  const sim = simulate(g, 300);
  let guard = 0;
  while (!sim.step(40)) guard++;
  assert.ok(guard < 10);
  for (const node of g.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
  const big = g.nodes.filter((x) => x.kind !== 'person');
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++) assert.ok(Math.hypot(big[i].x - big[j].x, big[i].y - big[j].y) > (big[i].r + big[j].r) * 0.8, `${big[i].id} and ${big[j].id} overlap`);
  const b = bounds(g.nodes);
  assert.ok(b.x1 > b.x0 && b.y1 > b.y0);

  const pts = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: -10, y: 0 }, { x: 0, y: -10 }, { x: 0, y: 12 }];
  assert.equal(neighbourIn(pts, 0, 'right'), 1);
  assert.equal(neighbourIn(pts, 0, 'left'), 2);
  assert.equal(neighbourIn(pts, 0, 'up'), 3);
  assert.equal(neighbourIn(pts, 0, 'down'), 4);
  assert.equal(neighbourIn(pts, 1, 'right'), -1);
});
