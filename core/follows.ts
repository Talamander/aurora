// "Bring your follows": read the following lists inside the data exports people already have
// (Google Takeout, Instagram, TikTok, X, Mastodon, Reddit, Substack, OPML, or a pasted list of
// links) and turn them into follow targets. Runs in the browser, so a large export never leaves
// the computer; only the extracted accounts are sent to the server.
//
// Everything here is untrusted input. Values are length-capped and checked against tight
// patterns, links must be http(s), nothing is rendered as HTML, and bad rows are skipped with a
// reason instead of failing the whole file.

export type FollowPlatform = 'youtube' | 'instagram' | 'tiktok' | 'x' | 'threads' | 'mastodon' | 'bluesky' | 'reddit' | 'substack' | 'feed';

export interface FollowTarget {
  /** Stable identity used for de-duplication and "already following": `platform:id`, lower case. */
  key: string;
  platform: FollowPlatform;
  /**
   * The account in the form the platform's connector takes: a username without @, a YouTube
   * `UC…` channel id or `@handle`, `user@host` for Mastodon, a subreddit name, a Substack
   * subdomain or https URL, or a feed URL.
   */
  handle: string;
  /** Display name when the export has one. */
  name?: string;
  /** Public profile URL, http(s) only. */
  url?: string;
  /** Avatar URL, https only. */
  avatar?: string;
  /** False when the export does not carry enough to follow the account (X archives list ids). */
  importable: boolean;
  /** Why it is not importable, or another honest note. */
  note?: string;
}

export interface ParsedFollows {
  file: string;
  /** What the file was recognised as, e.g. "Instagram following list". */
  kind: string;
  targets: FollowTarget[];
  skipped: number;
  errors: string[];
}

export const MAX_FOLLOW_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_TARGETS = 5000;

export const PLATFORM_LABEL: Record<FollowPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  threads: 'Threads',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  reddit: 'Reddit',
  substack: 'Substack',
  feed: 'Feeds',
};

// ------------------------------------------------------------------ small guards

const USER_RE: Record<string, RegExp> = {
  instagram: /^[a-z0-9._]{1,30}$/i,
  tiktok: /^[a-z0-9._]{1,24}$/i,
  x: /^[a-z0-9_]{1,15}$/i,
  threads: /^[a-z0-9._]{1,30}$/i,
};
const YT_ID_RE = /^UC[\w-]{22}$/;
const YT_HANDLE_RE = /^@[\w.-]{3,30}$/;
const SUBREDDIT_RE = /^[a-z0-9][a-z0-9_]{1,20}$/i;
const SUBSTACK_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const BSKY_RE = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z0-9-]+$/i;
const MASTO_RE = /^[a-z0-9_]{1,30}@(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function httpUrl(raw: unknown, httpsOnly = false): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 2000) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) return undefined;
    if (u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function make(platform: FollowPlatform, handle: string, extra: Partial<FollowTarget> = {}): FollowTarget {
  const id = platform === 'youtube' && !YT_ID_RE.test(handle) ? handle.toLowerCase() : platform === 'youtube' ? handle : handle.toLowerCase();
  return {
    key: `${platform}:${platform === 'youtube' ? id.toLowerCase() : id}`,
    platform,
    handle,
    importable: true,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')),
  } as FollowTarget;
}

/** A clean target for one account on a platform, or null when the value is not a valid account. */
export function target(platform: FollowPlatform, raw: string, extra: { name?: string; url?: string; avatar?: string } = {}): FollowTarget | null {
  let h = clip(raw, 300).replace(/^@(?=[^@]+$)/, '');
  const name = extra.name ? clip(extra.name, 120) : undefined;
  const avatar = httpUrl(extra.avatar, true);
  switch (platform) {
    case 'instagram':
    case 'tiktok':
    case 'x':
    case 'threads': {
      if (!USER_RE[platform].test(h)) return null;
      const base = { instagram: 'https://www.instagram.com/', tiktok: 'https://www.tiktok.com/@', x: 'https://x.com/', threads: 'https://www.threads.net/@' }[platform];
      return make(platform, h, { name, avatar, url: base + h });
    }
    case 'youtube': {
      if (YT_ID_RE.test(h)) return make('youtube', h, { name, avatar, url: `https://www.youtube.com/channel/${h}` });
      const at = h.startsWith('@') ? h : `@${h}`;
      if (!YT_HANDLE_RE.test(at)) return null;
      return make('youtube', at, { name, avatar, url: `https://www.youtube.com/${at}` });
    }
    case 'mastodon': {
      h = h.replace(/^@/, '');
      if (!MASTO_RE.test(h)) return null;
      const [user, host] = h.split('@');
      return make('mastodon', `${user}@${host.toLowerCase()}`, { name, avatar, url: `https://${host.toLowerCase()}/@${user}` });
    }
    case 'bluesky': {
      if (!BSKY_RE.test(h) && !/^did:plc:[a-z2-7]{24}$/.test(h)) return null;
      return make('bluesky', h.toLowerCase(), { name, avatar, url: `https://bsky.app/profile/${h.toLowerCase()}` });
    }
    case 'reddit': {
      h = h.replace(/^\/?r\//i, '');
      if (!SUBREDDIT_RE.test(h)) return null;
      return make('reddit', h, { name: name ?? `r/${h}`, url: `https://www.reddit.com/r/${h}/` });
    }
    case 'substack': {
      const u = httpUrl(h.includes('://') ? h : '');
      if (u) {
        const host = new URL(u).hostname.toLowerCase();
        const sub = /^([a-z0-9-]+)\.substack\.com$/.exec(host)?.[1];
        if (sub && sub !== 'www') return make('substack', sub, { name, avatar, url: `https://${sub}.substack.com/` });
        return make('substack', `https://${host}/`, { name, avatar, url: `https://${host}/` });
      }
      if (!SUBSTACK_RE.test(h) || h === 'www') return null;
      return make('substack', h.toLowerCase(), { name, avatar, url: `https://${h.toLowerCase()}.substack.com/` });
    }
    case 'feed': {
      const u = httpUrl(h);
      if (!u) return null;
      return make('feed', u, { name, url: u });
    }
  }
}

/** Recognise a profile link or handle typed or pasted by the user. */
export function classifyLink(raw: string): FollowTarget | null {
  const s = clip(raw, 500).replace(/^[<(]|[>),.;]$/g, '');
  if (!s) return null;
  if (/^@?[a-z0-9_]{1,30}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return target('mastodon', s);
  if (/^r\/[a-z0-9_]{2,21}$/i.test(s)) return target('reddit', s);
  const u = httpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s) ? `https://${s}` : '');
  if (!u) return null;
  const url = new URL(u);
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const seg = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (seg[0] === 'channel' && seg[1]) return target('youtube', seg[1]);
    if (seg[0]?.startsWith('@')) return target('youtube', seg[0]);
    if ((seg[0] === 'c' || seg[0] === 'user') && seg[1]) return target('feed', u);
    if (seg[0] === 'feeds' && url.searchParams.get('channel_id')) return target('youtube', url.searchParams.get('channel_id')!);
    return null;
  }
  if (host === 'instagram.com') return seg[0] && !['p', 'reel', 'reels', 'explore', 'stories', '_u'].includes(seg[0]) ? target('instagram', seg[0]) : seg[0] === '_u' && seg[1] ? target('instagram', seg[1]) : null;
  if (host === 'tiktok.com') return seg[0]?.startsWith('@') ? target('tiktok', seg[0]) : null;
  if (host === 'x.com' || host === 'twitter.com') return seg[0] && !['i', 'intent', 'home', 'search', 'hashtag'].includes(seg[0]) ? target('x', seg[0]) : null;
  if (host === 'threads.net' || host === 'threads.com') return seg[0]?.startsWith('@') ? target('threads', seg[0]) : null;
  if (host === 'bsky.app') return seg[0] === 'profile' && seg[1] && seg.length === 2 ? target('bluesky', seg[1]) : null;
  if (host === 'reddit.com' || host === 'old.reddit.com') return seg[0] === 'r' && seg[1] ? target('reddit', seg[1]) : null;
  if (host.endsWith('.substack.com')) return target('substack', `https://${host}/`);
  // Mastodon-style profile URLs: https://host/@user
  if (seg.length === 1 && /^@[a-z0-9_]{1,30}$/i.test(seg[0]) && !seg[0].includes('.')) return target('mastodon', `${seg[0].slice(1)}@${host}`);
  return target('feed', u);
}

// ------------------------------------------------------------------ CSV

/** Small RFC 4180 reader: quotes, doubled quotes, CRLF, a byte-order mark. */
export function parseCsv(text: string, maxRows = 20000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      if (rows.length >= maxRows) return rows;
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// ------------------------------------------------------------------ the parsers

type Out = { kind: string; targets: FollowTarget[]; skipped: number; errors: string[] };
const out = (kind: string): Out => ({ kind, targets: [], skipped: 0, errors: [] });
function push(o: Out, t: FollowTarget | null, why: string) {
  if (t) o.targets.push(t);
  else {
    o.skipped++;
    if (o.errors.length < 30) o.errors.push(why);
  }
}

/** Google Takeout, YouTube and YouTube Music, subscriptions/subscriptions.csv (any language). */
function youtubeCsv(rows: string[][]): Out | null {
  if (rows.length < 1) return null;
  const sample = rows.slice(0, 6);
  const idCol = [0, 1, 2].find((c) => sample.some((r) => YT_ID_RE.test((r[c] ?? '').trim())));
  if (idCol === undefined) return null;
  const urlCol = [0, 1, 2].find((c) => c !== idCol && sample.some((r) => /youtube\.com\/channel\//.test(r[c] ?? '')));
  const nameCol = [0, 1, 2].find((c) => c !== idCol && c !== urlCol);
  const o = out('YouTube subscriptions (Google Takeout)');
  for (const r of rows) {
    const id = (r[idCol] ?? '').trim();
    if (!YT_ID_RE.test(id)) {
      // The header row has no channel id; anything else without one is reported.
      if (r !== rows[0]) push(o, null, `Skipped a row without a channel id (${clip(r.join(','), 60)})`);
      continue;
    }
    push(o, target('youtube', id, { name: nameCol !== undefined ? r[nameCol] : undefined }), '');
  }
  return o;
}

/** Mastodon, Preferences, Import and export, Follows: following_accounts.csv. */
function mastodonCsv(rows: string[][], file: string): Out | null {
  const first = (rows[0]?.[0] ?? '').trim().toLowerCase();
  // name@host also looks like an email address, so a headerless list counts only by its file name.
  const looks = first === 'account address' || (/following_accounts|follows/i.test(file) && rows.slice(0, 5).some((r) => MASTO_RE.test((r[0] ?? '').trim().replace(/^@/, ''))));
  if (!looks) return null;
  const o = out('Mastodon follows');
  for (const r of rows) {
    const v = (r[0] ?? '').trim();
    if (!v || v.toLowerCase() === 'account address') continue;
    push(o, target('mastodon', v), `Skipped “${clip(v, 60)}”: not an account address like name@server`);
  }
  return o;
}

/** Reddit data export: subscribed_subreddits.csv (a "subreddit" column). */
function redditCsv(rows: string[][], file: string): Out | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = head.indexOf('subreddit');
  if (col < 0 && !/subscribed_subreddits/i.test(file)) return null;
  const c = col < 0 ? 0 : col;
  const o = out('Reddit subscriptions');
  for (const r of rows.slice(col < 0 ? 0 : 1)) {
    const v = (r[c] ?? '').trim();
    if (!v) continue;
    if (/^u_/i.test(v)) {
      o.skipped++;
      continue; // a user's own profile "subreddit"
    }
    push(o, target('reddit', v), `Skipped “${clip(v, 60)}”: not a subreddit name`);
  }
  return o;
}

/** Any file that lists Substack publications by link or subdomain (the Substack export, a CSV). */
function substackAny(text: string): Out | null {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9-]{0,62})\.substack\.com/gi)) if (m[1].toLowerCase() !== 'www' && m[1].toLowerCase() !== 'substackcdn') hosts.add(m[1].toLowerCase());
  if (!hosts.size) return null;
  const o = out('Substack subscriptions');
  for (const h of hosts) push(o, target('substack', h), '');
  return o;
}

/** Instagram "following" in JSON: the 2023+ { relationships_following: [...] } shape and the plain array. */
function instagramJson(data: any, file: string): Out | null {
  let list: any[] | null = null;
  if (Array.isArray(data?.relationships_following)) list = data.relationships_following;
  else if (Array.isArray(data) && data.length && data.every((x) => x && Array.isArray(x.string_list_data)) && /following/i.test(file) && !/follower/i.test(file)) list = data;
  if (!list) return null;
  const o = out('Instagram following list');
  for (const e of list.slice(0, MAX_TARGETS)) {
    const s = Array.isArray(e?.string_list_data) ? e.string_list_data[0] : null;
    const fromHref = (() => {
      const u = httpUrl(s?.href);
      if (!u) return '';
      const seg = new URL(u).pathname.split('/').filter(Boolean);
      return seg[0] === '_u' ? (seg[1] ?? '') : (seg[0] ?? '');
    })();
    const user = clip(s?.value || e?.title || fromHref, 60);
    push(o, target('instagram', user), `Skipped an entry without a valid username (${clip(user, 40) || 'empty'})`);
  }
  return o;
}

/** Instagram "following" as HTML: only the profile links are read, never rendered. */
function instagramHtml(text: string, file: string): Out | null {
  if (!/following/i.test(file) || /follower/i.test(file)) return null;
  const users = new Set<string>();
  for (const m of text.matchAll(/href="https?:\/\/(?:www\.)?instagram\.com\/(?:_u\/)?([A-Za-z0-9._]{1,30})\/?"/g)) users.add(m[1]);
  if (!users.size) return null;
  const o = out('Instagram following list');
  for (const u of users) push(o, target('instagram', u), `Skipped “${clip(u, 40)}”`);
  return o;
}

/** X archive data/following.js: account ids only. Shown honestly; they cannot be followed by id. */
function xFollowing(text: string): Out | null {
  const m = /^\s*window\.YTD\.following\.part\d+\s*=\s*/.exec(text);
  if (!m) return null;
  let data: any;
  try {
    data = JSON.parse(text.slice(m[0].length));
  } catch {
    return { ...out('X following list'), errors: ['following.js is not valid: the list after "=" is not JSON'], skipped: 1 };
  }
  const o = out('X following list');
  for (const e of (Array.isArray(data) ? data : []).slice(0, MAX_TARGETS)) {
    const id = String(e?.following?.accountId ?? '');
    if (!/^\d{1,20}$/.test(id)) {
      push(o, null, 'Skipped an entry without an account id');
      continue;
    }
    o.targets.push({
      key: `x:id:${id}`,
      platform: 'x',
      handle: id,
      url: `https://x.com/i/user/${id}`,
      importable: false,
      note: 'The X archive lists account numbers, not handles. Paste the profile link to follow this one.',
    });
  }
  return o;
}

/** TikTok "Download your data", JSON: the Following list wherever this export version keeps it. */
function tiktokJson(data: any): Out | null {
  const found: any[] = [];
  const seen = new Set<any>();
  const walk = (v: any, depth: number, key: string) => {
    if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      if (/^following( ?list)?$/i.test(key) && v.some((x) => x && typeof x === 'object' && ('UserName' in x || 'Username' in x || 'userName' in x))) found.push(...v);
      return;
    }
    for (const [k, child] of Object.entries(v)) if (!/follower/i.test(k)) walk(child, depth + 1, k);
  };
  walk(data, 0, '');
  if (!found.length) return null;
  const o = out('TikTok following list');
  for (const e of found.slice(0, MAX_TARGETS)) {
    const u = clip(e?.UserName ?? e?.Username ?? e?.userName, 60);
    push(o, target('tiktok', u), `Skipped “${clip(u, 40) || 'an entry'}”: not a TikTok username`);
  }
  return o;
}

/** TikTok's text export (Following.txt): "Username: name" lines. */
function tiktokTxt(text: string, file: string): Out | null {
  if (!/following/i.test(file) || /follower/i.test(file)) return null;
  const names = [...text.matchAll(/^\s*User ?name:\s*(\S+)\s*$/gim)].map((m) => m[1]);
  if (!names.length) return null;
  const o = out('TikTok following list');
  for (const n of names.slice(0, MAX_TARGETS)) push(o, target('tiktok', n), `Skipped “${clip(n, 40)}”: not a TikTok username`);
  return o;
}

/** OPML from another reader: each outline with an xmlUrl becomes a feed. */
function opml(text: string): Out | null {
  if (!/<opml[\s>]/i.test(text)) return null;
  const o = out('OPML feed list');
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    const v = m ? (m[2] ?? m[3] ?? '') : '';
    return v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  };
  for (const [tag] of text.matchAll(/<outline\b[^>]*>/gi)) {
    const raw = attr(tag, 'xmlUrl');
    if (!raw) continue;
    const t = classifyFeedUrl(raw, attr(tag, 'title') || attr(tag, 'text'));
    push(o, t, `Skipped a feed that is not an http(s) link (${clip(raw, 60)})`);
  }
  return o;
}

/** A feed URL, recognised as a platform when it is one (so "already following" works across forms). */
function classifyFeedUrl(raw: string, name?: string): FollowTarget | null {
  const u = httpUrl(raw);
  if (!u) return null;
  const url = new URL(u);
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' && url.searchParams.get('channel_id')) return target('youtube', url.searchParams.get('channel_id')!, { name });
  return target('feed', u, { name });
}

/** A pasted or plain-text list: one link, handle or user@server per line (or comma-separated). */
export function parseList(text: string, file = 'Pasted list'): ParsedFollows {
  const o = out('List of links');
  const parts = text.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_TARGETS);
  for (const p of parts) push(o, classifyLink(p), `Not a profile link or handle: “${clip(p, 60)}”`);
  return finish(file, o);
}

function finish(file: string, o: Out): ParsedFollows {
  const seen = new Set<string>();
  const targets: FollowTarget[] = [];
  for (const t of o.targets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    targets.push(t);
    if (targets.length >= MAX_TARGETS) break;
  }
  return { file: clip(file, 200), kind: o.kind, targets, skipped: o.skipped, errors: o.errors };
}

/** Which export files are worth reading inside a ZIP. */
export function isFollowsEntry(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)__macosx\//.test(p)) return false;
  return (
    /subscriptions[^/]*\.csv$/.test(p) ||
    /(^|\/)following[^/]*\.(json|html?)$/.test(p) ||
    /(^|\/)following\.js$/.test(p) ||
    /(^|\/)user_data[^/]*\.json$/.test(p) ||
    /(^|\/)following\.txt$/.test(p) ||
    /following_accounts[^/]*\.csv$/.test(p) ||
    /subscribed_subreddits[^/]*\.csv$/.test(p) ||
    /\.opml$/.test(p) ||
    /substack[^/]*\.(csv|json)$/.test(p)
  );
}

/**
 * Recognise and read one export file. Returns null when the file is not a following list Aurora
 * knows (the caller says so); a "followers" list is rejected with a clear reason.
 */
export function parseFollowsFile(file: string, text: string): ParsedFollows | null {
  const base = file.split(/[\\/]/).pop() ?? file;
  if (/follower/i.test(base) && !/following/i.test(base)) {
    return { file: base, kind: 'Followers list', targets: [], skipped: 0, errors: ['This is the list of people who follow you. Aurora wants the people you follow: look for a file named "following" in the same export.'] };
  }
  const t = text.trimStart();
  if (/^window\.YTD\./.test(t)) {
    const x = xFollowing(t);
    return x ? finish(base, x) : { file: base, kind: 'X archive file', targets: [], skipped: 0, errors: ['This X archive file is not the following list. Use data/following.js.'] };
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      return { file: base, kind: 'JSON', targets: [], skipped: 0, errors: ['The file is not valid JSON.'] };
    }
    const o = instagramJson(data, base) ?? tiktokJson(data) ?? substackAny(t);
    return o ? finish(base, o) : null;
  }
  if (/<opml[\s>]/i.test(t.slice(0, 2000))) return finish(base, opml(t)!);
  if (/^<(!doctype|html)/i.test(t) || /\.html?$/i.test(base)) {
    const o = instagramHtml(t, base);
    return o ? finish(base, o) : null;
  }
  if (/\.csv$/i.test(base) || /,/.test(t.split(/\r?\n/, 1)[0] ?? '')) {
    const rows = parseCsv(t);
    const o = youtubeCsv(rows) ?? mastodonCsv(rows, base) ?? redditCsv(rows, base) ?? substackAny(t);
    if (o) return finish(base, o);
  }
  const tk = tiktokTxt(t, base);
  if (tk) return finish(base, tk);
  // A plain list of links, one per line.
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length && lines.length <= MAX_TARGETS && lines.filter((l) => classifyLink(l)).length >= Math.max(1, lines.length * 0.6)) return parseList(t, base);
  return null;
}

/** Merge several parsed files; the first occurrence of an account wins, but a richer one fills gaps. */
export function mergeTargets(lists: FollowTarget[][]): FollowTarget[] {
  const by = new Map<string, FollowTarget>();
  for (const l of lists)
    for (const t of l) {
      const prev = by.get(t.key);
      if (!prev) by.set(t.key, t);
      else by.set(t.key, { ...t, ...prev, name: prev.name ?? t.name, avatar: prev.avatar ?? t.avatar });
      if (by.size >= MAX_TARGETS) return [...by.values()];
    }
  return [...by.values()];
}

/** Server-side re-check of targets sent by the browser: rebuild each from platform + handle. */
export function cleanTargets(raw: unknown): FollowTarget[] {
  if (!Array.isArray(raw)) return [];
  const outList: FollowTarget[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, MAX_TARGETS)) {
    if (!r || typeof r !== 'object') continue;
    const p = String((r as any).platform) as FollowPlatform;
    if (!(p in PLATFORM_LABEL)) continue;
    const t = target(p, String((r as any).handle ?? ''), { name: (r as any).name, avatar: (r as any).avatar });
    if (!t || seen.has(t.key)) continue;
    seen.add(t.key);
    outList.push(t);
  }
  return outList;
}

/**
 * Every follow key a source stands for, so an import can mark what is already followed:
 * a Mastodon RSS feed, a subreddit feed, a YouTube channel feed, an actor's account input.
 */
export function sourceFollowKeys(s: { connector: string; platform: string; config: Record<string, unknown> }): string[] {
  const keys: string[] = [];
  const add = (t: FollowTarget | null) => t && keys.push(t.key);
  if (s.connector === 'rss' && typeof s.config.url === 'string') {
    const u = s.config.url;
    add(target('feed', u));
    try {
      const url = new URL(u);
      const host = url.hostname.replace(/^www\./, '');
      const seg = url.pathname.split('/').filter(Boolean);
      if (host === 'reddit.com' && seg[0] === 'r' && seg[1]) add(target('reddit', seg[1]));
      else if (host === 'youtube.com' && url.searchParams.get('channel_id')) add(target('youtube', url.searchParams.get('channel_id')!));
      else if (host.endsWith('.substack.com')) add(target('substack', `https://${host}/`));
      else if (seg.length === 1 && /^@[a-z0-9_]{1,30}\.rss$/i.test(seg[0])) add(target('mastodon', `${seg[0].slice(1, -4)}@${host}`));
      else if (host === 'bsky.app' && seg[0] === 'profile' && seg[1]) add(target('bluesky', seg[1]));
      else if (/\/feed\/?$/.test(url.pathname) && seg.length === 1) add(target('substack', `https://${host}/`));
    } catch {
      /* not a URL */
    }
  } else if (s.connector === 'bluesky-public' && typeof s.config.handle === 'string') {
    add(target('bluesky', s.config.handle));
  } else if (s.connector === 'actor') {
    const input = (s.config.input ?? {}) as Record<string, unknown>;
    const p = s.platform as FollowPlatform;
    for (const v of Object.values(input)) {
      if (typeof v !== 'string' || !v) continue;
      const fromLink = /^https?:\/\//i.test(v) ? classifyLink(v) : null;
      if (fromLink) add(fromLink);
      else if (p in PLATFORM_LABEL) add(target(p, v));
    }
  }
  return keys;
}
