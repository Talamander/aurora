// Bring your follows: one small FICTIONAL fixture per export format, the ZIP reader, and the
// server's lanes (feed, connector reuse, one AI build per platform, fail-fast) with stand-ins.
// Every account, channel id, subreddit and address below is invented for these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTargets, isFollowsEntry, mergeTargets, parseFollowsFile, parseList, sourceFollowKeys } from '../core/follows.ts';
import { isZip, listZip } from '../core/zip.ts';
import { buildCostRange, createFollows, type FollowJob } from '../server/follows.ts';
import { createProfiles } from '../server/profiles.ts';
import { Store } from '../server/db.ts';

// ---------------------------------------------------------------- fictional fixtures

const FICTIONAL = {
  youtubeCsv:
    'Channel Id,Channel Url,Channel Title\n' +
    'UCfictionalchannel000001,http://www.youtube.com/channel/UCfictionalchannel000001,Fictional Maker Studio\n' +
    'UCfictionalchannel000002,http://www.youtube.com/channel/UCfictionalchannel000002,"Pretend Cooking, Daily"\n' +
    'not-a-channel,http://www.youtube.com/channel/nope,Broken Row\n',
  // Takeout in another language: the header is translated, the channel ids are not.
  youtubeCsvGerman: 'Kanal-ID,Kanal-URL,Kanaltitel\nUCfictionalchannel000003,http://www.youtube.com/channel/UCfictionalchannel000003,Erfundener Kanal\n',
  mastodonCsv: 'Account address,Show boosts,Notify on new posts,Languages\nfictional_writer@example.social,true,false,\n@pretend_poet@example.club,true,false,\nnot an address,true,false,\n',
  redditCsv: 'subreddit\nFictionalBaking\nu_fictional_me\npretend_gardening\n',
  substackCsv: 'email,publication_url,active_subscription\nfan@example.com,https://fictionalnotes.substack.com,true\nfan@example.com,https://pretendessays.substack.com/,false\n',
  instagramJson: JSON.stringify({
    relationships_following: [
      { title: '', media_list_data: [], string_list_data: [{ href: 'https://www.instagram.com/fictional.painter', value: 'fictional.painter', timestamp: 1700000000 }] },
      // The 2024 shape: the username moved to title, the link uses /_u/.
      { title: 'pretend_baker', string_list_data: [{ href: 'https://www.instagram.com/_u/pretend_baker', timestamp: 1700000001 }] },
      { title: '', string_list_data: [{ href: 'javascript:alert(1)' }] },
    ],
  }),
  instagramArray: JSON.stringify([{ title: '', string_list_data: [{ href: 'https://www.instagram.com/fictional.potter', value: 'fictional.potter' }] }]),
  instagramHtml:
    '<html><body><div><a target="_blank" href="https://www.instagram.com/fictional.potter">fictional.potter</a></div>' +
    '<div><a href="https://www.instagram.com/_u/pretend.knitter/">pretend.knitter</a></div><script>alert("never run")</script></body></html>',
  xFollowing: 'window.YTD.following.part0 = [{"following":{"accountId":"1000000001","userLink":"https://twitter.com/intent/user?user_id=1000000001"}},{"following":{"accountId":"oops"}}]',
  tiktokJson: JSON.stringify({ 'Your Activity': { Following: { Following: [{ Date: '2024-01-01 10:00:00', UserName: 'fictional_dancer' }, { Date: '2024-01-02', UserName: 'bad name!' }] }, Follower: { FansList: [{ UserName: 'someone_who_follows_me' }] } } }),
  tiktokTxt: 'Date: 2024-01-01 10:00:00\nUsername: fictional_skater\n\nDate: 2024-01-03 09:00:00\nUsername: pretend_chef\n',
  opml:
    '<?xml version="1.0"?><opml version="2.0"><head><title>Fictional reader export</title></head><body>' +
    '<outline text="Fictional Blog" xmlUrl="https://fictional-blog.example/feed.xml"/>' +
    '<outline text="Pretend Channel" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCfictionalchannel000004"/>' +
    '<outline text="Bad" xmlUrl="javascript:alert(1)"/></body></opml>',
  pasted: 'https://www.youtube.com/@FictionalMaker\nhttps://www.instagram.com/fictional.painter\n@fictional_writer@example.social\nr/FictionalBaking\nhttps://bsky.app/profile/fictional.bsky.social\nnot a link at all',
};

test('YouTube Takeout CSV: channel ids in any language, bad rows skipped with a reason', () => {
  const p = parseFollowsFile('Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv', FICTIONAL.youtubeCsv)!;
  assert.equal(p.kind, 'YouTube subscriptions (Google Takeout)');
  assert.deepEqual(p.targets.map((t) => t.handle), ['UCfictionalchannel000001', 'UCfictionalchannel000002']);
  assert.equal(p.targets[1].name, 'Pretend Cooking, Daily');
  assert.equal(p.skipped, 1);
  assert.match(p.errors[0], /without a channel id/);
  const de = parseFollowsFile('Abos.csv', FICTIONAL.youtubeCsvGerman)!;
  assert.equal(de.targets[0].name, 'Erfundener Kanal');
});

test('Mastodon following_accounts.csv', () => {
  const p = parseFollowsFile('following_accounts.csv', FICTIONAL.mastodonCsv)!;
  assert.deepEqual(p.targets.map((t) => t.handle), ['fictional_writer@example.social', 'pretend_poet@example.club']);
  assert.equal(p.targets[0].url, 'https://example.social/@fictional_writer');
  assert.equal(p.skipped, 1);
});

test('Reddit subscribed_subreddits.csv skips your own u_ profile', () => {
  const p = parseFollowsFile('subscribed_subreddits.csv', FICTIONAL.redditCsv)!;
  assert.deepEqual(p.targets.map((t) => t.key), ['reddit:fictionalbaking', 'reddit:pretend_gardening']);
  assert.equal(p.skipped, 1);
});

test('Substack: publication links in an export, email addresses are not mistaken for Mastodon', () => {
  const p = parseFollowsFile('substack_subscriptions.csv', FICTIONAL.substackCsv)!;
  assert.equal(p.kind, 'Substack subscriptions');
  assert.deepEqual(p.targets.map((t) => t.handle).sort(), ['fictionalnotes', 'pretendessays']);
});

test('Instagram following: both JSON shapes and the HTML variant (links only, never rendered)', () => {
  const j = parseFollowsFile('connections/followers_and_following/following.json', FICTIONAL.instagramJson)!;
  assert.deepEqual(j.targets.map((t) => t.handle), ['fictional.painter', 'pretend_baker']);
  assert.equal(j.skipped, 1);
  const a = parseFollowsFile('following.json', FICTIONAL.instagramArray)!;
  assert.equal(a.targets[0].handle, 'fictional.potter');
  const h = parseFollowsFile('following.html', FICTIONAL.instagramHtml)!;
  assert.deepEqual(h.targets.map((t) => t.handle), ['fictional.potter', 'pretend.knitter']);
  assert.ok(!JSON.stringify(h).includes('never run'));
});

test('a followers list is refused with a clear reason', () => {
  const p = parseFollowsFile('followers_1.json', FICTIONAL.instagramArray)!;
  assert.equal(p.targets.length, 0);
  assert.match(p.errors[0], /people who follow you/);
});

test('X following.js: ids only, shown honestly and not importable', () => {
  const p = parseFollowsFile('data/following.js', FICTIONAL.xFollowing)!;
  assert.equal(p.targets.length, 1);
  assert.equal(p.targets[0].key, 'x:id:1000000001');
  assert.equal(p.targets[0].importable, false);
  assert.match(p.targets[0].note!, /account numbers, not handles/);
  assert.equal(p.skipped, 1);
});

test('TikTok: user_data.json Following list (not Followers) and the text export', () => {
  const j = parseFollowsFile('user_data_tiktok.json', FICTIONAL.tiktokJson)!;
  assert.deepEqual(j.targets.map((t) => t.handle), ['fictional_dancer']);
  assert.equal(j.skipped, 1);
  const t = parseFollowsFile('Activity/Following.txt', FICTIONAL.tiktokTxt)!;
  assert.deepEqual(t.targets.map((x) => x.handle), ['fictional_skater', 'pretend_chef']);
});

test('OPML: feeds, YouTube channel feeds recognised, unsafe links skipped', () => {
  const p = parseFollowsFile('reader.opml', FICTIONAL.opml)!;
  assert.deepEqual(p.targets.map((t) => t.key), ['feed:https://fictional-blog.example/feed.xml', 'youtube:ucfictionalchannel000004']);
  assert.equal(p.skipped, 1);
});

test('pasted links and handles', () => {
  const p = parseList(FICTIONAL.pasted);
  assert.deepEqual(p.targets.map((t) => t.key), ['youtube:@fictionalmaker', 'instagram:fictional.painter', 'mastodon:fictional_writer@example.social', 'reddit:fictionalbaking', 'bluesky:fictional.bsky.social']);
  assert.equal(p.skipped, 1);
  // Unknown files are not guessed at.
  assert.equal(parseFollowsFile('notes.txt', 'just some words\nnothing to follow here'), null);
});

test('merge, server re-check and already-followed keys', () => {
  const merged = mergeTargets([parseList('https://www.instagram.com/fictional.painter').targets, parseFollowsFile('following.json', FICTIONAL.instagramArray)!.targets, [{ ...parseList('https://www.instagram.com/fictional.painter').targets[0], name: 'Fictional Painter' }]]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'Fictional Painter');
  const clean = cleanTargets([{ platform: 'instagram', handle: '<script>' }, { platform: 'evil', handle: 'x' }, { platform: 'reddit', handle: 'FictionalBaking', name: '\u202eevil' }, 'nope']);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].name, 'evil');
  assert.ok(sourceFollowKeys({ connector: 'rss', platform: 'mastodon', config: { url: 'https://example.social/@fictional_writer.rss' } }).includes('mastodon:fictional_writer@example.social'));
  assert.ok(sourceFollowKeys({ connector: 'rss', platform: 'youtube', config: { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCfictionalchannel000001' } }).includes('youtube:ucfictionalchannel000001'));
  assert.ok(sourceFollowKeys({ connector: 'actor', platform: 'tiktok', config: { actorId: 'tiktok-profile', input: { username: 'fictional_dancer' } } }).includes('tiktok:fictional_dancer'));
  assert.ok(sourceFollowKeys({ connector: 'bluesky-public', platform: 'bluesky', config: { handle: 'fictional.bsky.social' } }).includes('bluesky:fictional.bsky.social'));
});

// ---------------------------------------------------------------- ZIP

async function makeZip(files: Record<string, string>, lie = false): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const cd: Uint8Array<ArrayBuffer>[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const n = enc.encode(name);
    const size = lie ? 10 : raw.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, 8, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, n.length, true);
    parts.push(new Uint8Array(lh.buffer), n, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, 8, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, n.length, true);
    ch.setUint32(42, off, true);
    cd.push(new Uint8Array(ch.buffer), n);
    off += 30 + n.length + comp.length;
  }
  const count = Object.keys(files).length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, count, true);
  e.setUint16(10, count, true);
  e.setUint32(12, cd.reduce((a, b) => a + b.length, 0), true);
  e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, new Uint8Array(e.buffer)] as BlobPart[]);
}

test('ZIP: only following files are read, and an entry that lies about its size cannot fill memory', async () => {
  const z = await makeZip({ 'Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv': FICTIONAL.youtubeCsv, 'Takeout/YouTube and YouTube Music/history/watch-history.html': '<html>private</html>', '__MACOSX/following.json': 'x' });
  assert.ok(await isZip(z));
  assert.equal(await isZip(new Blob(['plain text, definitely not a zip file'])), false);
  const entries = await listZip(z, isFollowsEntry, 1_000_000);
  assert.deepEqual(entries.map((e) => e.name), ['Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv']);
  assert.equal(parseFollowsFile(entries[0].name, await entries[0].read())!.targets.length, 2);
  const bomb = await makeZip({ 'following.json': 'a'.repeat(200_000) }, true);
  const [b] = await listZip(bomb, isFollowsEntry, 1000);
  await assert.rejects(b.read(), /too large/);
});

// ---------------------------------------------------------------- server lanes

function setup(opts: { syncFail?: (s: { connector: string; config: Record<string, unknown> }) => boolean; build?: (store: Store, threadId: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-follows-'));
  const store = new Store(dir);
  const profiles = createProfiles(store);
  const builds: string[] = [];
  const manifests = [
    { id: 'tiktok-profile', name: 'TikTok profile', platform: 'tiktok', tier: 'http', input: { type: 'object', required: ['username'], properties: { username: { type: 'string' } } } },
    { id: 'instagram-profile', name: 'Instagram profile', platform: 'instagram', tier: 'http', input: { type: 'object', required: ['username'], properties: { username: { type: 'string' } } } },
  ] as any[];
  const follows = createFollows({
    store,
    profiles,
    actors: () => ({ list: () => manifests }),
    addFeed: async (connector, config) => ({ source: store.createSource({ connector, label: 'x', platform: 'bluesky', config }), result: { added: 3 } }),
    syncSource: async (id) => {
      const s = store.listSources().find((x) => x.id === id)!;
      return opts.syncFail?.(s) ? { error: 'Fictional failure' } : { added: 2 };
    },
    startJob: (job) => {
      builds.push(job.request);
      const th = store.createThread({ kind: 'build', title: 'build' });
      store.updateThread(th.id, { status: 'running' });
      setTimeout(() => opts.build?.(store, th.id), 30);
      return { threadId: th.id };
    },
    aiReady: () => true,
    fetch: (async () => ({ status: 500, text: '' })) as any,
    broadcast: () => {},
    gapMs: () => 0,
    pollMs: 10,
  });
  const done = async () => {
    for (let i = 0; i < 300 && !follows.current()?.finishedAt; i++) await new Promise((r) => setTimeout(r, 10));
    return follows.current() as FollowJob;
  };
  return { store, follows, builds, done, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function provenSource(store: Store, actorId: string, platform: string, username: string) {
  const s = store.createSource({ connector: 'actor', label: username, platform, config: { actorId, input: { username } }, status: 'ok' });
  store.updateSource(s.id, { lastSyncAt: new Date().toISOString() });
  return s;
}

test('plan: open feeds instant, existing marked, X ids unsupported, honest cost fallback', () => {
  const { store, follows, cleanup } = setup();
  try {
    store.createSource({ connector: 'rss', label: 'r', platform: 'reddit', config: { url: 'https://www.reddit.com/r/FictionalBaking/.rss' } });
    provenSource(store, 'tiktok-profile', 'tiktok', 'already_here');
    const targets = [...parseFollowsFile('subscribed_subreddits.csv', FICTIONAL.redditCsv)!.targets, ...parseFollowsFile('data/following.js', FICTIONAL.xFollowing)!.targets, ...parseList('https://www.tiktok.com/@fictional_dancer\nhttps://www.instagram.com/fictional.painter\nhttps://www.tiktok.com/@already_here').targets];
    const p = follows.plan(targets);
    const lane = Object.fromEntries(p.items.map((i) => [i.key, i.lane]));
    assert.equal(lane['reddit:fictionalbaking'], 'exists');
    assert.equal(lane['reddit:pretend_gardening'], 'feed');
    assert.equal(lane['x:id:1000000001'], 'unsupported');
    assert.equal(lane['tiktok:fictional_dancer'], 'actor');
    assert.equal(lane['tiktok:already_here'], 'exists');
    assert.equal(lane['instagram:fictional.painter'], 'build');
    assert.equal(p.cost.builds, 1);
    assert.deepEqual(buildCostRange(store), { min: 0.09, max: 0.74, median: 0.3, samples: 0 });
  } finally {
    cleanup();
  }
});

test('run: feeds and connector reuse add sources without any AI build', async () => {
  const { store, follows, builds, done, cleanup } = setup();
  try {
    provenSource(store, 'tiktok-profile', 'tiktok', 'already_here');
    follows.start({ targets: [...parseFollowsFile('following_accounts.csv', FICTIONAL.mastodonCsv)!.targets, ...parseFollowsFile('Following.txt', FICTIONAL.tiktokTxt)!.targets] });
    const job = await done();
    assert.deepEqual(job.items.map((x) => x.status), ['done', 'done', 'done', 'done']);
    assert.equal(builds.length, 0);
    const tiktok = store.listSources().filter((s) => s.connector === 'actor' && (s.config as any).via === 'follows-import');
    assert.deepEqual(tiktok.map((s) => (s.config.input as any).username).sort(), ['fictional_skater', 'pretend_chef']);
    assert.ok(store.findSourceByConfig('rss', 'url', 'https://example.social/@fictional_writer.rss'));
  } finally {
    cleanup();
  }
});

test('run: one AI build per platform, then every other account reuses that connector', async () => {
  const { store, follows, builds, done, cleanup } = setup({
    build: (store, threadId) => {
      provenSource(store, 'instagram-profile', 'instagram', 'fictional.painter');
      store.updateThread(threadId, { status: 'done' });
    },
  });
  try {
    follows.start({ targets: parseList('https://www.instagram.com/fictional.painter\nhttps://www.instagram.com/pretend_baker\nhttps://www.instagram.com/fictional.potter').targets });
    const job = await done();
    assert.equal(builds.length, 1);
    assert.match(builds[0], /only required input field/);
    assert.deepEqual(job.items.map((x) => x.status), ['done', 'done', 'done']);
    assert.equal(job.builds.instagram?.status, 'done');
    assert.equal(store.listSources().filter((s) => s.config.actorId === 'instagram-profile').length, 3);
  } finally {
    cleanup();
  }
});

test('run: a connector that fails for the first three accounts pauses the rest', async () => {
  const { store, follows, done, cleanup } = setup({ syncFail: (s) => s.connector === 'actor' && (s.config as any).via === 'follows-import' });
  try {
    provenSource(store, 'tiktok-profile', 'tiktok', 'already_here');
    const handles = ['fictional_a', 'fictional_b', 'fictional_c', 'fictional_d', 'fictional_e'];
    follows.start({ targets: parseList(handles.map((h) => `https://www.tiktok.com/@${h}`).join('\n')).targets });
    const job = await done();
    assert.deepEqual(job.items.map((x) => x.status), ['failed', 'failed', 'failed', 'blocked', 'blocked']);
    assert.match(job.items[3].error!, /Paused/);
    // Sources that never worked are removed again.
    assert.equal(store.listSources().filter((s) => (s.config as any).via === 'follows-import').length, 0);
  } finally {
    cleanup();
  }
});
