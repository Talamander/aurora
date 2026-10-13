import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPrivateAddress, safeFetch } from '../server/safeFetch.ts';
import { parseFeed, discoverFeedLinks, rssConnector } from '../server/connectors/rss.ts';
import { mapAuthorFeed, normalizeActor } from '../server/connectors/bluesky.ts';
import { buildAuthUrl, makePkce, mapBookmarksResponse, xBookmarksConnector } from '../server/connectors/xApi.ts';
import { detectAndParse, parseCsv } from '../server/connectors/importers.ts';
import { connectorInfos, feedConnectors, importParsers } from '../server/connectors/index.ts';
import { createHash } from 'node:crypto';
import type { SafeFetch, SafeFetchResult } from '../server/connectors/types.ts';

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const NOW = new Date('2026-01-01T00:00:00Z');

// ---------------- safeFetch ----------------

test('isPrivateAddress classifies addresses', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1',
    'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'ff02::1', '64:ff9b::7f00:1', 'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('safeFetch rejects local and non-http targets without network', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://localhost:8080/',
    'file:///etc/passwd',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://user:pass@example.com/',
    'ftp://example.com/',
    'http://intranet/',
    'http://10.0.0.5/',
    'http://0x7f000001/',
  ]) {
    await assert.rejects(safeFetch(url), (e: Error) => e.name === 'SafeFetchError', url);
  }
});

// ---------------- RSS ----------------

test('parseFeed: RSS 2.0', () => {
  const feed = parseFeed(fx('rss2.xml'), 'https://blog.example.com/feed.xml', NOW);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'Example Blog & Notes');
  assert.equal(feed.platform, 'rss');
  assert.equal(feed.items.length, 2);
  const [a, b] = feed.items;
  assert.equal(a.title, 'First post: hello');
  assert.equal(a.url, 'https://blog.example.com/first');
  assert.match(a.externalId, /^[0-9a-f]{8}:post-1$/, 'non-URL guids are namespaced by feed');
  assert.equal(a.author.name, 'Jane Writer');
  assert.equal(a.author.url, 'https://blog.example.com/');
  assert.equal(a.publishedAt, '2024-10-01T10:00:00.000Z');
  assert.equal(a.kind, 'article');
  assert.equal(a.lang, 'en');
  assert.match(a.text, /Hello/);
  assert.doesNotMatch(a.text, /alert|<|script/);
  assert.deepEqual(a.links, ['https://other.example.org/page']);
  const mediaUrls = a.media.map((m) => m.url);
  assert.ok(mediaUrls.includes('https://cdn.example.com/photo.jpg'));
  assert.ok(mediaUrls.includes('https://blog.example.com/img.png'));
  assert.ok(mediaUrls.includes('https://cdn.example.com/podcast.mp3'));
  assert.equal(a.provenance.connector, 'rss');
  assert.equal(a.provenance.via, 'feed');
  // relative link, no date, no author
  assert.equal(b.url, 'https://blog.example.com/second');
  assert.equal(b.externalId, 'https://blog.example.com/second');
  assert.equal(b.author.name, 'Example Blog & Notes');
  assert.equal(b.publishedAt, NOW.toISOString());
  assert.equal(b.text, 'Escaped & html');
});

test('parseFeed: Atom', () => {
  const feed = parseFeed(fx('atom.xml'), 'https://atom.example.net/feed.xml', NOW);
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Atom Example');
  assert.equal(feed.link, 'https://atom.example.net/');
  const [a, b] = feed.items;
  assert.equal(a.url, 'https://atom.example.net/1');
  assert.equal(a.title, 'Entry & one');
  assert.match(a.externalId, /^[0-9a-f]{8}:tag:atom.example.net,2024:1$/);
  assert.equal(a.author.name, 'Pierre');
  assert.equal(a.author.url, 'https://atom.example.net/pierre');
  assert.equal(a.publishedAt, '2024-09-01T12:00:00.000Z');
  assert.equal(a.text, 'Bonjour lien');
  assert.deepEqual(a.links, ['https://link.example.org/x']);
  assert.equal(a.lang, 'fr');
  assert.equal(b.url, 'https://atom.example.net/2');
  assert.equal(b.text, 'Plain summary');
  assert.equal(b.publishedAt, '2024-09-03T12:00:00.000Z');
});

test('parseFeed: YouTube channel feed', () => {
  const feed = parseFeed(fx('youtube.xml'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc', NOW);
  assert.equal(feed.platform, 'youtube');
  const [v] = feed.items;
  assert.equal(v.kind, 'video');
  assert.equal(v.platform, 'youtube');
  assert.equal(v.url, 'https://www.youtube.com/watch?v=vid123');
  assert.equal(v.title, 'How to test feeds');
  assert.match(v.text, /A video about testing/);
  assert.deepEqual(v.links, ['https://example.com/notes']);
  assert.equal(v.media[0].type, 'video');
  assert.equal(v.media[0].thumb, 'https://i1.ytimg.com/vi/vid123/hqdefault.jpg');
  assert.ok(!v.media.some((m) => m.url.includes('/v/vid123')));
});

test('parseFeed: platform guess and errors', () => {
  const rss = fx('rss2.xml');
  assert.equal(parseFeed(rss, 'https://bsky.app/profile/alice.bsky.social/rss').platform, 'bluesky');
  assert.equal(parseFeed(rss, 'https://bsky.app/profile/alice.bsky.social/rss').items[0].kind, 'post');
  assert.equal(parseFeed(rss, 'https://example.social/@bob.rss').platform, 'mastodon');
  assert.equal(parseFeed(rss, 'https://mastodon.social/@bob.rss').platform, 'mastodon');
  assert.equal(parseFeed(rss, 'https://www.reddit.com/r/rss/.rss').platform, 'reddit');
  assert.throws(() => parseFeed('<html><body>nope</body></html>', 'https://x.example/'), /Not an RSS/);
  assert.throws(() => parseFeed('{"json": true}', 'https://x.example/'));
});

test('discoverFeedLinks finds alternate feeds in HTML', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/s.css">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link type='application/atom+xml' rel='alternate' href='https://cdn.example.com/atom'>
    <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
  </head></html>`;
  assert.deepEqual(discoverFeedLinks(html, 'https://site.example.com/blog/'), ['https://site.example.com/feed.xml', 'https://cdn.example.com/atom']);
});

test('rss prepareConfig follows an HTML page to its feed once', async () => {
  const calls: string[] = [];
  const fake: SafeFetch = async (url): Promise<SafeFetchResult> => {
    calls.push(url);
    if (url === 'https://blog.example.com/') {
      return { status: 200, url, headers: { 'content-type': 'text/html' }, text: '<!doctype html><link rel="alternate" type="application/rss+xml" href="/feed.xml">' };
    }
    if (url === 'https://blog.example.com/feed.xml') return { status: 200, url, headers: {}, text: fx('rss2.xml') };
    return { status: 404, url, headers: {}, text: '' };
  };
  const out = await rssConnector.prepareConfig({ url: 'blog.example.com/' }, fake);
  assert.equal(out.label, 'Example Blog & Notes');
  assert.equal(out.config.url, 'https://blog.example.com/feed.xml');
  assert.deepEqual(calls, ['https://blog.example.com/', 'https://blog.example.com/feed.xml']);
  await assert.rejects(rssConnector.prepareConfig({ url: 'javascript:alert(1)' }, fake), /valid/);
  const html: SafeFetch = async (url) => ({ status: 200, url, headers: { 'content-type': 'text/html' }, text: '<html><body>no feed</body></html>' });
  await assert.rejects(rssConnector.prepareConfig({ url: 'https://plain.example.com/' }, html), /not a feed/);
  const broken: SafeFetch = async (url) => ({ status: 500, url, headers: {}, text: '' });
  await assert.rejects(rssConnector.prepareConfig({ url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx' }, broken), /HTTP 500/);
});

// ---------------- Bluesky ----------------

test('normalizeActor accepts handles, DIDs and profile URLs', () => {
  assert.equal(normalizeActor('@Alice.bsky.social'), 'alice.bsky.social');
  assert.equal(normalizeActor('https://bsky.app/profile/alice.bsky.social'), 'alice.bsky.social');
  assert.equal(normalizeActor('https://bsky.app/profile/alice.bsky.social/post/3k'), 'alice.bsky.social');
  assert.equal(normalizeActor('did:plc:abc123'), 'did:plc:abc123');
  assert.equal(normalizeActor('https://evil.example/profile/alice.bsky.social'), null);
  assert.equal(normalizeActor('not a handle'), null);
});

test('mapAuthorFeed maps posts, reposts, replies and embeds', () => {
  const { items, cursor } = mapAuthorFeed(JSON.parse(fx('bluesky-author-feed.json')));
  assert.equal(cursor, '2024-09-30T08:00:00.000Z');
  assert.equal(items.length, 3);
  const [a, b, c] = items;
  assert.equal(a.url, 'https://bsky.app/profile/alice.bsky.social/post/3kaaa111');
  assert.equal(a.externalId, 'at://did:plc:alice123/app.bsky.feed.post/3kaaa111');
  assert.equal(a.kind, 'post');
  assert.equal(a.lang, 'en');
  assert.equal(a.author.name, 'Alice');
  assert.equal(a.author.handle, 'alice.bsky.social');
  assert.equal(a.author.avatar, 'https://cdn.bsky.app/img/avatar/alice.jpg');
  assert.deepEqual(a.links, ['https://example.com/article-on-feeds']);
  assert.equal(a.media[0].type, 'link');
  assert.equal(a.media[0].alt, 'Article on feeds');
  assert.deepEqual(a.metrics, { likes: 10, reposts: 3, replies: 2 });
  assert.equal(a.publishedAt, '2024-10-01T12:00:00.000Z');

  assert.equal(b.kind, 'repost');
  assert.equal(b.author.name, 'bob.example.com');
  assert.deepEqual(b.media[0], { type: 'image', url: 'https://cdn.bsky.app/img/feed_fullsize/1.jpg', alt: 'A mountain', thumb: 'https://cdn.bsky.app/img/feed_thumbnail/1.jpg' });
  assert.equal(b.lang, 'de');

  assert.equal(c.kind, 'reply');
  assert.equal(c.media[0].type, 'video');
  assert.equal(c.media[0].url, 'https://video.bsky.app/watch/abc/playlist.m3u8');
  assert.equal(c.quoted?.text, 'Original quoted words');
  assert.equal(c.quoted?.author.name, 'Carol');
  assert.equal(c.quoted?.url, 'https://bsky.app/profile/carol.bsky.social/post/3kddd444');
});

test('bluesky prepareConfig resolves profile via the public AppView', async () => {
  const seen: string[] = [];
  const fake: SafeFetch = async (url) => {
    seen.push(url);
    return { status: 200, url, headers: {}, text: JSON.stringify({ did: 'did:plc:alice123', handle: 'alice.bsky.social', displayName: 'Alice' }) };
  };
  const out = await feedConnectors['bluesky-public'].prepareConfig({ handle: '@alice.bsky.social' }, fake);
  assert.equal(out.label, 'Alice (@alice.bsky.social)');
  assert.deepEqual(out.config, { handle: 'alice.bsky.social', did: 'did:plc:alice123' });
  assert.ok(seen[0].startsWith('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=alice.bsky.social'));
});

// ---------------- X API ----------------

test('makePkce produces a valid S256 pair and buildAuthUrl has the right params', () => {
  const p = makePkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = createHash('sha256').update(p.verifier).digest('base64url');
  assert.equal(p.challenge, expected);
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5174/api/x/callback', state: 'st', codeChallenge: p.challenge }));
  assert.equal(u.origin + u.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'tweet.read users.read bookmark.read offline.access');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('mapBookmarksResponse maps tweets, media, quotes and note tweets', () => {
  const { items, errors, nextToken } = mapBookmarksResponse(JSON.parse(fx('x-bookmarks-response.json')));
  assert.equal(nextToken, 'tok2');
  assert.equal(errors.length, 1);
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.platform, 'x');
  assert.equal(a.externalId, '1840000000000000001');
  assert.equal(a.url, 'https://x.com/writer/status/1840000000000000001');
  assert.equal(a.text, 'Worth reading & sharing https://example.com/longread');
  assert.deepEqual(a.links, ['https://example.com/longread']);
  assert.deepEqual(a.media, [{ type: 'image', url: 'https://pbs.twimg.com/media/photo1.jpg', alt: 'chart' }]);
  assert.equal(a.quoted?.text, 'The quoted tweet');
  assert.equal(a.quoted?.author.handle, 'quoteq');
  assert.deepEqual(a.metrics, { likes: 20, reposts: 4, replies: 1 });
  assert.equal(a.author.avatar, 'https://pbs.twimg.com/profile_images/1/a.jpg');
  assert.equal(b.kind, 'reply');
  assert.match(b.text, /full long note tweet/);
  assert.equal(b.lang, null);
  assert.equal(b.media[0].type, 'video');
  assert.equal(b.media[0].thumb, 'https://pbs.twimg.com/ext_tw_video_thumb/2.jpg');
});

test('x-bookmarks is unavailable without X_CLIENT_ID and blocked without tokens', async () => {
  const saved = process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_ID;
  try {
    assert.equal(xBookmarksConnector.info.available, false);
    assert.ok(xBookmarksConnector.info.blockedReason);
    process.env.X_CLIENT_ID = 'test-client';
    assert.equal(xBookmarksConnector.info.available, true);
    const store = new Map<string, string>();
    const out = await xBookmarksConnector.sync({
      sourceId: 's', config: {}, cursor: null, now: () => NOW,
      fetch: async () => { throw new Error('should not fetch'); },
      secrets: { get: (k) => store.get(k) ?? null, set: (k, v) => { if (v == null) store.delete(k); else store.set(k, v); } },
    });
    assert.equal(out.items.length, 0);
    assert.match(out.blocked ?? '', /Not connected/);
  } finally {
    if (saved === undefined) delete process.env.X_CLIENT_ID;
    else process.env.X_CLIENT_ID = saved;
  }
});

// ---------------- Importers ----------------

test('x-archive tweets.js', () => {
  const out = detectAndParse('tweets.js', fx('tweets.js'));
  assert.equal(out.platform, 'x');
  assert.equal(out.label, 'X archive: your posts');
  assert.equal(out.items.length, 3);
  assert.equal(out.errors.length, 1);
  const [a, rt, reply] = out.items;
  assert.equal(a.externalId, '1050118621198921728');
  assert.equal(a.url, 'https://x.com/i/web/status/1050118621198921728');
  assert.equal(a.text, 'Reading this today https://example.com/today & more');
  assert.deepEqual(a.links, ['https://example.com/today']);
  assert.deepEqual(a.media, [{ type: 'image', url: 'https://pbs.twimg.com/media/abc.jpg' }]);
  assert.equal(a.publishedAt, '2018-10-10T20:19:24.000Z');
  assert.equal(a.author.name, 'You');
  assert.equal(a.provenance.via, 'import');
  assert.equal(a.provenance.fileName, 'tweets.js');
  assert.deepEqual(a.metrics, { likes: 3, reposts: 1 });
  assert.equal(rt.kind, 'repost');
  assert.equal(reply.kind, 'reply');
});

test('x-archive like.js uses snowflake time and unknown author', () => {
  const out = detectAndParse('like.js', fx('like.js'));
  assert.equal(out.label, 'X archive: likes');
  assert.equal(out.items.length, 2);
  const [a, b] = out.items;
  assert.equal(a.author.name, 'Unknown author (X like)');
  assert.equal(a.url, 'https://x.com/i/web/status/1840000000000000001');
  assert.deepEqual(a.links, ['https://example.com/liked']);
  const t = Date.parse(a.publishedAt);
  assert.ok(t > Date.parse('2024-09-01') && t < Date.parse('2024-11-01'), a.publishedAt);
  assert.equal(b.text, '');
});

test('x-archive bookmark.js creates placeholder items', () => {
  const out = detectAndParse('bookmark.js', fx('bookmark.js'));
  assert.equal(out.label, 'X archive: bookmarks');
  const [a] = out.items;
  assert.equal(a.externalId, '1840000000000000001');
  assert.equal(a.title, 'Bookmarked post (text not in archive)');
  assert.equal(a.text, '');
  assert.equal(a.kind, 'post');
  assert.equal(a.url, 'https://x.com/i/web/status/1840000000000000001');
});

test('x-archive rejects unsupported YTD files and never evaluates code', () => {
  assert.throws(() => detectAndParse('account.js', 'window.YTD.account.part0 = []'), /not supported/);
  assert.throws(() => detectAndParse('tweets.js', 'window.YTD.tweets.part0 = (function(){ throw 1 })()'), /not valid JSON/);
});

test('twitter-web-exporter JSON', () => {
  const out = detectAndParse('twitter-Bookmarks-1727777777.json', fx('twitter-web-exporter.json'));
  assert.equal(out.label, 'X export: bookmarks');
  assert.equal(out.items.length, 2);
  assert.equal(out.errors.length, 1);
  const [a, b] = out.items;
  assert.equal(a.externalId, '1840000000000000001');
  assert.equal(a.publishedAt, '2024-10-01T10:00:00.000Z');
  assert.equal(a.text, 'Worth reading https://example.com/longread');
  assert.deepEqual(a.links, ['https://example.com/longread']);
  assert.equal(a.author.handle, 'writer');
  assert.equal(a.author.name, 'The Writer');
  assert.equal(a.media[0].url, 'https://pbs.twimg.com/media/photo1?format=jpg&name=orig');
  assert.equal(a.media[0].alt, 'chart');
  assert.equal(a.quoted?.url, 'https://x.com/i/web/status/1830000000000000000');
  assert.equal(a.url, 'https://x.com/writer/status/1840000000000000001');
  assert.equal(b.kind, 'reply');
  assert.equal(a.provenance.connector, 'x-export-json');
});

test('twitter-web-exporter CSV and the CSV parser', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  const out = detectAndParse('twitter-Likes.csv', fx('twitter-web-exporter.csv'));
  assert.equal(out.items.length, 1);
  const [a] = out.items;
  assert.equal(a.text, 'Line one\nline two, with "quotes"');
  assert.equal(a.publishedAt, '2024-09-01T10:00:00.000Z');
  assert.equal(a.media[0].url, 'https://pbs.twimg.com/media/z?name=orig');
  assert.equal(a.author.handle, 'csvuser');
  assert.equal(out.label, 'X export: likes');
});

test('Netscape bookmarks.html', () => {
  const out = detectAndParse('bookmarks.html', fx('bookmarks.html'));
  assert.equal(out.items.length, 2);
  assert.equal(out.errors.length, 1);
  const [a, v] = out.items;
  assert.equal(a.url, 'https://example.com/essay');
  assert.equal(a.title, 'An & Essay');
  assert.equal(a.kind, 'article');
  assert.match(a.text, /Great essay/);
  assert.match(a.text, /#essay #longform/);
  assert.match(a.text, /Folder: Reading/);
  assert.equal(a.publishedAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(v.platform, 'youtube');
  assert.doesNotMatch(v.text, /Folder/);
});

test('generic JSON import', () => {
  const out = detectAndParse('saved.json', fx('generic.json'));
  assert.equal(out.items.length, 2);
  assert.equal(out.errors.length, 1);
  const [a, b] = out.items;
  assert.equal(a.title, 'Headline A');
  assert.equal(a.text, 'Body bold');
  assert.equal(a.author.name, 'Reporter');
  assert.equal(a.kind, 'article');
  assert.equal(a.publishedAt, '2024-05-01T00:00:00.000Z');
  assert.equal(b.platform, 'bluesky');
  assert.equal(b.author.handle, 'alice.bsky.social');
  assert.equal(b.publishedAt, '2024-05-01T00:00:00.000Z');
  assert.equal(out.platform, 'import');
});

test('detectAndParse throws a clear error for unknown files', () => {
  assert.throws(() => detectAndParse('notes.txt', 'just some text'), /Unrecognised file format/);
  assert.throws(() => detectAndParse('empty.json', '   '), /empty/);
  assert.throws(() => detectAndParse('x.json', '[1,2,3]'), /No usable items/);
});

test('registry exposes connectors and honest infos', () => {
  assert.deepEqual(Object.keys(feedConnectors).sort(), ['bluesky-public', 'rss', 'x-bookmarks']);
  assert.equal(importParsers.length, 3);
  const infos = connectorInfos();
  const ids = infos.map((i) => i.id);
  for (const id of ['rss', 'bluesky-public', 'x-bookmarks', 'x-archive', 'x-export-json', 'generic-json', 'mastodon-timeline', 'reddit-api', 'threads', 'instagram', 'linkedin']) {
    assert.ok(ids.includes(id), id);
  }
  for (const i of infos.filter((x) => !x.available)) assert.ok(i.blockedReason, i.id);
});
