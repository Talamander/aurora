// Filtering, search syntax, dedupe and noise classification against known input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, clearClause, DEFAULT_SPEC, normalizeSpec, parseQuery, activeClauses } from '../core/filter.ts';
import { classifyNoise } from '../core/classify.ts';
import { canonicalUrl, dedupeKeyFor, htmlToText, safeHttpUrl } from '../core/normalize.ts';
import type { FilterSpec, Item, Topic } from '../core/types.ts';

let n = 0;
function item(p: Partial<Item> & { text: string }): Item {
  n += 1;
  const base: Item = {
    id: `rss:${n}`,
    sourceId: 'src-a',
    platform: 'rss',
    externalId: String(n),
    url: `https://example.com/post/${n}`,
    author: { name: 'Ada Example', handle: 'ada' },
    text: p.text,
    links: [],
    media: [],
    lang: 'en',
    kind: 'post',
    publishedAt: '2026-10-10T12:00:00.000Z',
    ingestedAt: '2026-10-10T12:00:00.000Z',
    provenance: { connector: 'rss', connectorVersion: 1, via: 'feed' },
    dedupeKey: `t:${n}`,
    isDemo: false,
    state: { read: false, saved: false, archived: false, collections: [] },
  };
  return { ...base, ...p, state: { ...base.state, ...(p.state ?? {}) } };
}

const topics: Topic[] = [{ id: 'db', name: 'Databases', terms: ['sqlite', 'postgres'] }];
const ctx = { topics, sourceLabels: { 'src-a': 'Feed A', 'src-b': 'Feed B' }, now: new Date('2026-10-12T12:00:00Z') };
const run = (items: Item[], spec: Partial<FilterSpec>) => applyFilters(items, normalizeSpec(spec), ctx);
const ids = (r: ReturnType<typeof run>) => r.visible.map((e) => e.item.id);

const a = item({ text: 'Notes on SQLite write-ahead logging and checkpoints.', publishedAt: '2026-10-11T09:00:00Z' });
const b = item({ text: 'Postgres vacuum tuning, a field guide.', sourceId: 'src-b', author: { name: 'Bo Example', handle: 'bo' }, lang: 'de', publishedAt: '2026-10-09T09:00:00Z' });
const c = item({ text: 'Like and retweet if you agree! Follow for more', state: { read: true, saved: false, archived: false, collections: [] } });
const d = item({ text: 'A photo from the hills.', media: [{ type: 'image', url: 'https://example.com/a.jpg' }], kind: 'post', state: { read: false, saved: true, archived: false, collections: ['walks'] } });
const e = item({ text: 'Archived thought about caching.', state: { read: true, saved: false, archived: true, collections: [] } });
const all = [a, b, c, d, e];

test('default spec hides archived items only', () => {
  const r = run(all, {});
  assert.deepEqual(ids(r).sort(), [a, b, c, d].map((x) => x.id).sort());
  assert.equal(r.hiddenBy.archived, 1);
});

test('read, saved and archived state filters compose', () => {
  assert.deepEqual(ids(run(all, { read: 'unread' })).sort(), [a, b, d].map((x) => x.id).sort());
  assert.deepEqual(ids(run(all, { saved: 'saved' })), [d.id]);
  assert.deepEqual(ids(run(all, { archived: 'only' })), [e.id]);
  assert.deepEqual(ids(run(all, { read: 'unread', collection: 'walks' })), [d.id]);
});

test('items read during a visit stay in an unread list', () => {
  const r = applyFilters([c], normalizeSpec({ read: 'unread' }), { ...ctx, keepRead: new Set([c.id]) });
  assert.equal(r.visible.length, 1);
});

test('include keywords honour any/all mode, exclude mutes', () => {
  assert.deepEqual(ids(run(all, { include: ['sqlite', 'postgres'] })).sort(), [a.id, b.id].sort());
  assert.deepEqual(ids(run(all, { include: ['sqlite', 'checkpoints'], includeMode: 'all' })), [a.id]);
  const muted = run(all, { exclude: ['postgres'] });
  assert.ok(!ids(muted).includes(b.id));
  assert.match(muted.hidden.find((h) => h.item.id === b.id)!.hidden[0].label, /Muted word/);
});

test('keyword matching is whole-word and accent-insensitive', () => {
  const x = item({ text: 'Café culture and résumé tips' });
  assert.equal(run([x], { include: ['cafe'] }).visible.length, 1);
  assert.equal(run([x], { include: ['caf'] }).visible.length, 0);
});

test('sources, authors, language, type and date filters', () => {
  assert.deepEqual(ids(run(all, { sources: ['src-b'] })), [b.id]);
  assert.ok(!ids(run(all, { excludeSources: ['src-b'] })).includes(b.id));
  assert.deepEqual(ids(run(all, { authors: ['bo'] })), [b.id]);
  assert.deepEqual(ids(run(all, { langs: ['de'] })), [b.id]);
  assert.deepEqual(ids(run(all, { contentTypes: ['image'] })), [d.id]);
  assert.deepEqual(ids(run(all, { dateFrom: '2026-10-11' })), [a.id]);
  assert.deepEqual(ids(run(all, { dateTo: '2026-10-09' })), [b.id]);
});

test('topics match by term and explain the match', () => {
  const r = run(all, { topics: ['db'] });
  assert.deepEqual(ids(r).sort(), [a.id, b.id].sort());
  assert.ok(r.visible[0].matched.some((m) => m.kind === 'topic'));
});

test('noise classifier flags engagement bait and respects overrides', () => {
  const v = classifyNoise(c);
  assert.equal(v.isNoise, true);
  assert.ok(v.signals.length > 0);
  assert.equal(classifyNoise({ ...c, state: { ...c.state, noiseOverride: true } }).isNoise, false);
  assert.equal(classifyNoise({ ...a, state: { ...a.state, noiseOverride: false } }).isNoise, true);
  assert.equal(classifyNoise(a).isNoise, false);
  const r = run(all, { hideNoise: true });
  assert.ok(!ids(r).includes(c.id));
  assert.match(r.hidden.find((h) => h.item.id === c.id)!.hidden[0].label, /^Noise:/);
});

test('search syntax: terms, phrases, negation, from:, site:', () => {
  const q = parseQuery('sqlite "field guide" -vacuum from:@Bo site:example.com');
  assert.deepEqual(q.terms, ['sqlite']);
  assert.deepEqual(q.phrases, ['field guide']);
  assert.deepEqual(q.negated, ['vacuum']);
  assert.deepEqual(q.from, ['bo']);
  assert.deepEqual(q.site, ['example.com']);
  assert.deepEqual(ids(run(all, { query: 'sqlite' })), [a.id]);
  assert.deepEqual(ids(run(all, { query: '"field guide"' })), [b.id]);
  assert.ok(!ids(run(all, { query: '-postgres' })).includes(b.id));
  assert.deepEqual(ids(run(all, { query: 'from:bo' })), [b.id]);
});

test('duplicates across sources collapse to the richest copy', () => {
  const key = dedupeKeyFor({ url: 'https://example.com/x', text: '', links: ['https://www.example.com/story?utm_source=x'], kind: 'post' });
  const short = item({ text: 'Good read', dedupeKey: key, sourceId: 'src-a' });
  const long = item({ text: 'Good read: a long summary of the story with real detail.', dedupeKey: key, sourceId: 'src-b' });
  const r = run([short, long], {});
  assert.deepEqual(ids(r), [long.id]);
  assert.deepEqual(r.visible[0].duplicates, [short.id]);
  assert.equal(run([short, long], { hideDuplicates: false }).visible.length, 2);
});

test('canonical URLs drop tracking and unify X status links', () => {
  assert.equal(canonicalUrl('https://www.example.com/a?utm_source=t&id=2#top'), canonicalUrl('https://example.com/a?id=2'));
  assert.equal(canonicalUrl('https://twitter.com/ada/status/123'), canonicalUrl('https://x.com/ada/status/123?s=20'));
});

test('clearClause resets one clause; activeClauses counts them', () => {
  const s = normalizeSpec({ read: 'unread', include: ['sqlite'], sort: 'oldest' });
  assert.deepEqual(activeClauses(s).sort(), ['include', 'read']);
  const cleared = clearClause(s, 'include');
  assert.deepEqual(cleared.include, []);
  assert.equal(cleared.read, 'unread');
  assert.equal(clearClause(s, 'duplicate').hideDuplicates, false);
  assert.equal(DEFAULT_SPEC.hideDuplicates, true);
});

test('no matches is distinguishable from no content', () => {
  const none = run([], { query: 'x' });
  assert.equal(none.total, 0);
  const miss = run(all, { query: 'nothingmatches' });
  assert.equal(miss.visible.length, 0);
  assert.equal(miss.total, all.length);
  assert.equal(miss.hiddenBy.query, all.length);
});

test('htmlToText strips markup and unsafe links, keeps inline spacing', () => {
  const r = htmlToText('<p>Python <a href="https://ex.com/a">3.15</a>! is <b>here</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a><pre>line one\nline two</pre>');
  assert.match(r.text, /Python 3\.15! is here/);
  assert.ok(!r.text.includes('alert'));
  assert.deepEqual(r.links, ['https://ex.com/a']);
  assert.match(r.text, /line one\nline two/);
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,hi'), null);
});

test('noise phrases match whole words only', () => {
  const quiet = ['because code review matters here', 'loving #adobe tools lately', 'raindrop app is nice for bookmarks'];
  for (const t of quiet) assert.equal(classifyNoise(item({ text: t })).isNoise, false, t);
  assert.equal(classifyNoise(item({ text: 'Use code SAVE10 at checkout today' })).isNoise, true);
});

test('a filtered-out fuller copy does not hide the other copy', () => {
  const key = 'u:example.com/story';
  const inB = item({ text: 'Story', dedupeKey: key, sourceId: 'src-b' });
  const inA = item({ text: 'Story, with a much longer summary from feed A', dedupeKey: key, sourceId: 'src-a' });
  assert.deepEqual(ids(run([inA, inB], { sources: ['src-b'] })), [inB.id]);
});

test('different commentary on the same link is not a duplicate', () => {
  const link = ['https://example.com/article'];
  const k1 = dedupeKeyFor({ url: 'https://x.com/a/status/1', text: 'This is the clearest explanation of WAL I have read, especially the part on checkpoints.', links: link, kind: 'post' });
  const k2 = dedupeKeyFor({ url: 'https://x.com/b/status/2', text: 'Strongly disagree with the conclusion here; the benchmark ignores fsync costs entirely.', links: link, kind: 'post' });
  assert.notEqual(k1, k2);
  assert.notEqual(canonicalUrl('https://forum.example/viewtopic.php?t=1'), canonicalUrl('https://forum.example/viewtopic.php?t=2'));
});

test('language guess answers only when clear', async () => {
  const { guessLang } = await import('../core/lang.ts');
  assert.equal(guessLang('Una tipografía pensada para pantallas pequeñas cambia más de lo que parece'), 'es');
  assert.equal(guessLang('I remember hearing that the project did not use version control at all'), 'en');
  assert.equal(guessLang('ok cool'), null);
});

test('code blocks keep indentation and blank lines as one fenced paragraph', async () => {
  const { paragraphs, codeBlock, previewText } = await import('../web/src/format.ts');
  const { text } = htmlToText('<p>Try:</p><pre><code>def f(x):\n    if x &lt; 2:\n\n        return 1\n</code></pre><p>Done</p>');
  const ps = paragraphs(text);
  assert.equal(ps.length, 3);
  assert.equal(codeBlock(ps[1]), 'def f(x):\n    if x < 2:\n\n        return 1');
  assert.equal(codeBlock(ps[0]), null);
  assert.ok(!previewText(text).includes('```'));
});
