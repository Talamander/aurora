// File importers. Files are untrusted data: they are parsed as JSON / CSV /
// text only, never evaluated. Every URL goes through safeHttpUrl.

import type { Author, ConnectorInfo, ItemKind, Media, Platform } from '../../core/types.ts';
import { decodeEntities, extractUrls, hash, htmlToText, hostOf, safeHttpUrl } from '../../core/normalize.ts';
import type { ImportOutput, ImportParser, ItemDraft } from './types.ts';
import { ErrorList, asArray, errMsg, guessPlatform, isObj, num, pushMedia, snowflakeToIso, str, toIso, truncateText, uniq } from './util.ts';

export const MAX_IMPORT_ITEMS = 50_000;
const IMPORT_VERSION = 1;

type Obj = Record<string, unknown>;

function provenance(connector: string, fileName: string): ItemDraft['provenance'] {
  return { connector, connectorVersion: IMPORT_VERSION, via: 'import', fileName: fileName.slice(0, 200) };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function xStatusUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

function isTco(url: string): boolean {
  return /^https?:\/\/t\.co\//i.test(url);
}

function info(id: string, name: string, platform: Platform, description: string, needs: string[]): ConnectorInfo {
  return { id, version: IMPORT_VERSION, name, platform, kind: 'import', available: true, blockedReason: null, needs, description };
}

// ---------------------------------------------------------------------------
// a. Official X / Twitter archive (data/tweets.js, data/like.js, data/bookmark.js)
// ---------------------------------------------------------------------------

const YTD_RE = /^\s*window\.YTD\.([A-Za-z0-9_]+)\.part\d+\s*=\s*/;

function parseYtd(text: string): { name: string; rows: unknown[] } {
  const s = stripBom(text);
  const m = YTD_RE.exec(s);
  if (!m) throw new Error('Not an X archive data file (missing "window.YTD.<name>.partN =" prefix)');
  const json = s.slice(m[0].length).trim().replace(/;\s*$/, '');
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch (e) {
    throw new Error(`X archive file is not valid JSON after the prefix: ${errMsg(e)}`);
  }
  if (!Array.isArray(rows)) throw new Error('X archive file does not contain an array');
  return { name: m[1], rows };
}

function mapArchiveTweet(t: Obj, fileName: string): ItemDraft {
  const id = str(t.id_str) ?? str(t.id);
  if (!id || !/^\d+$/.test(id)) throw new Error('tweet without a numeric id');
  let text = str(t.full_text) ?? str(t.text) ?? '';
  const entities = isObj(t.entities) ? t.entities : {};
  const ext = isObj(t.extended_entities) ? t.extended_entities : {};
  const links: string[] = [];
  for (const u of asArray<Obj>(entities.urls)) {
    if (!isObj(u)) continue;
    const short = str(u.url);
    const expanded = safeHttpUrl(u.expanded_url);
    if (short && expanded) text = text.split(short).join(expanded);
    if (expanded && !links.includes(expanded)) links.push(expanded);
  }
  const media: Media[] = [];
  const mediaList = asArray<Obj>(ext.media).length ? asArray<Obj>(ext.media) : asArray<Obj>(entities.media);
  for (const m of mediaList) {
    if (!isObj(m)) continue;
    const short = str(m.url);
    if (short) text = text.split(short).join('');
    const img = str(m.media_url_https) ?? str(m.media_url);
    const type = str(m.type);
    if (type === 'video' || type === 'animated_gif') {
      const vi = isObj(m.video_info) ? m.video_info : {};
      const variants = asArray<Obj>(vi.variants)
        .filter((v) => isObj(v) && str(v.content_type) === 'video/mp4' && safeHttpUrl(v.url))
        .sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0));
      const best = variants[0] ? str(variants[0].url) : undefined;
      pushMedia(media, { type: 'video', url: best ?? img ?? '', thumb: img, alt: str(m.ext_alt_text) });
    } else if (img) {
      pushMedia(media, { type: 'image', url: img, alt: str(m.ext_alt_text) });
    }
  }
  text = decodeEntities(text).trim();
  let kind: ItemKind = 'post';
  if (/^RT @\w+:/.test(text)) kind = 'repost';
  else if (str(t.in_reply_to_status_id_str) || str(t.in_reply_to_status_id)) kind = 'reply';
  const parent = kind === 'reply' ? str(t.in_reply_to_status_id_str) ?? str(t.in_reply_to_status_id) : undefined;
  return {
    platform: 'x',
    externalId: id,
    url: xStatusUrl(id),
    author: { name: 'You' },
    text: truncateText(text),
    links: uniq(links.filter((l) => !/\/status\/\d+\/(photo|video)\//.test(l))),
    media,
    quoted: null,
    lang: str(t.lang) && t.lang !== 'und' && t.lang !== 'zxx' ? str(t.lang)! : null,
    kind,
    replyTo: parent && /^\d+$/.test(parent) ? parent : null,
    publishedAt: toIso(str(t.created_at)) ?? snowflakeToIso(id) ?? new Date().toISOString(),
    provenance: provenance('x-archive', fileName),
    metrics: { likes: num(t.favorite_count), reposts: num(t.retweet_count) },
  };
}

function mapArchiveLike(l: Obj, fileName: string): ItemDraft {
  const id = str(l.tweetId);
  if (!id || !/^\d+$/.test(id)) throw new Error('like without a numeric tweetId');
  const text = decodeEntities(str(l.fullText) ?? '').trim();
  const expanded = safeHttpUrl(l.expandedUrl);
  return {
    platform: 'x',
    externalId: id,
    url: xStatusUrl(id),
    author: { name: 'Unknown author (X like)', ...(expanded ? { url: expanded } : {}) },
    text: truncateText(text),
    links: extractUrls(text).filter((u) => !isTco(u)),
    media: [],
    quoted: null,
    lang: null,
    kind: 'post',
    publishedAt: snowflakeToIso(id) ?? new Date().toISOString(),
    provenance: provenance('x-archive', fileName),
    metrics: null,
  };
}

function mapArchiveBookmark(b: Obj, fileName: string): ItemDraft {
  const id = str(b.tweetId);
  if (!id || !/^\d+$/.test(id)) throw new Error('bookmark without a numeric tweetId');
  return {
    platform: 'x',
    externalId: id,
    url: xStatusUrl(id),
    author: { name: 'Unknown author (X bookmark)' },
    title: 'Bookmarked post (text not in archive)',
    text: '',
    links: [],
    media: [],
    quoted: null,
    lang: null,
    kind: 'post',
    publishedAt: snowflakeToIso(id) ?? toIso(str(b.bookmarkedAt)) ?? new Date().toISOString(),
    provenance: provenance('x-archive', fileName),
    metrics: null,
  };
}

export const xArchiveParser: ImportParser = {
  info: info(
    'x-archive',
    'X archive (tweets.js, like.js, bookmark.js)',
    'x',
    'Files from the official "Download an archive of your data" zip (the data/ folder). Likes and bookmarks in the archive have no author; bookmarks have no text.',
    ['tweets.js, like.js or bookmark.js from your X archive'],
  ),
  detect(_fileName, head) {
    return YTD_RE.test(stripBom(head));
  },
  parse(fileName, text) {
    const { name, rows } = parseYtd(text);
    const errors = new ErrorList();
    const items: ItemDraft[] = [];
    let mapper: (row: unknown) => ItemDraft;
    let label: string;
    if (name === 'tweets' || name === 'tweet') {
      label = 'X archive: your posts';
      mapper = (row) => {
        const t = isObj(row) && isObj(row.tweet) ? row.tweet : row;
        if (!isObj(t)) throw new Error('row is not an object');
        return mapArchiveTweet(t, fileName);
      };
    } else if (name === 'like') {
      label = 'X archive: likes';
      mapper = (row) => {
        const l = isObj(row) && isObj(row.like) ? row.like : null;
        if (!l) throw new Error('row has no "like" object');
        return mapArchiveLike(l, fileName);
      };
    } else if (name === 'bookmark' || name === 'bookmarks') {
      label = 'X archive: bookmarks';
      mapper = (row) => {
        const b = isObj(row) && isObj(row.bookmark) ? row.bookmark : null;
        if (!b) throw new Error('row has no "bookmark" object');
        return mapArchiveBookmark(b, fileName);
      };
    } else {
      throw new Error(`X archive file "${name}" is not supported. Import tweets.js, like.js or bookmark.js from the archive's data/ folder.`);
    }
    rows.forEach((row, i) => {
      if (items.length >= MAX_IMPORT_ITEMS) return;
      try {
        items.push(mapper(row));
      } catch (e) {
        errors.add(`Row ${i + 1}: ${errMsg(e)}`);
      }
    });
    if (rows.length > MAX_IMPORT_ITEMS) errors.add(`File has ${rows.length} rows; only the first ${MAX_IMPORT_ITEMS} were imported`);
    return { items, errors: errors.list(), label, platform: 'x' };
  },
};

// ---------------------------------------------------------------------------
// b. prinsss/twitter-web-exporter JSON / CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = stripBom(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function firstLine(head: string): string {
  return stripBom(head).split(/\r?\n/, 1)[0] ?? '';
}

function isExporterCsvHeader(line: string): boolean {
  const cols = line.toLowerCase().split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  return cols.includes('id') && cols.includes('full_text') && (cols.includes('created_at') || cols.includes('screen_name'));
}

/** Exporter media cell: array of objects, or a JSON string of that (CSV), or whitespace-separated URLs. */
function exporterMedia(raw: unknown): Media[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        list = JSON.parse(t);
      } catch {
        list = t.split(/\s+/);
      }
    } else list = t.split(/[\s,]+/);
  }
  const out: Media[] = [];
  for (const m of asArray(list)) {
    if (typeof m === 'string') {
      const u = safeHttpUrl(m);
      if (u && !isTco(u)) pushMedia(out, { type: /\.(mp4|m3u8)/i.test(u) ? 'video' : 'image', url: u });
      continue;
    }
    if (!isObj(m)) continue;
    const type = str(m.type) ?? 'photo';
    const original = str(m.original) ?? str(m.media_url_https) ?? str(m.url);
    const thumb = str(m.thumbnail) ?? str(m.media_url_https);
    const alt = str(m.ext_alt_text) ?? str(m.alt_text) ?? str(m.alt);
    if (type === 'video' || type === 'animated_gif') pushMedia(out, { type: 'video', url: original && !isTco(original) ? original : thumb ?? '', thumb, alt: alt || undefined });
    else pushMedia(out, { type: 'image', url: original && !isTco(original) ? original : thumb ?? '', alt: alt || undefined });
  }
  return out;
}

function exporterRow(r: Obj, fileName: string): ItemDraft {
  // Accept raw GraphQL objects (rest_id/legacy) as well as exporter rows.
  const legacy = isObj(r.legacy) ? r.legacy : isObj(r.metadata) && isObj((r.metadata as Obj).legacy) ? ((r.metadata as Obj).legacy as Obj) : null;
  const id = str(r.id) ?? str(r.rest_id) ?? str(r.id_str) ?? (legacy ? str(legacy.id_str) : undefined);
  if (!id || !/^\d+$/.test(id)) throw new Error('missing numeric tweet id');
  let text = str(r.full_text) ?? str(r.text) ?? str(r.content) ?? (legacy ? str(legacy.full_text) : undefined) ?? '';

  const media = exporterMedia(r.media ?? r.medias);
  // Remove t.co links that point at attached media; expand others when metadata has entities.
  for (const m of asArray<Obj>(r.media)) {
    if (isObj(m) && str(m.url) && isTco(str(m.url)!)) text = text.split(str(m.url)!).join('');
  }
  const links: string[] = [];
  if (legacy && isObj(legacy.entities)) {
    for (const u of asArray<Obj>((legacy.entities as Obj).urls)) {
      if (!isObj(u)) continue;
      const short = str(u.url);
      const expanded = safeHttpUrl(u.expanded_url);
      if (short && expanded) text = text.split(short).join(expanded);
    }
    for (const m of asArray<Obj>((legacy.entities as Obj).media)) {
      if (isObj(m) && str(m.url)) text = text.split(str(m.url)!).join('');
    }
  }
  text = decodeEntities(text).trim();
  for (const u of extractUrls(text)) if (!links.includes(u)) links.push(u);

  const screenName = (str(r.screen_name) ?? str(r.username) ?? str(r.handle) ?? '').replace(/^@/, '');
  const name = str(r.name) ?? str(r.user_name) ?? str(r.author);
  const author: Author = { name: (name?.trim() || (screenName ? `@${screenName}` : 'Unknown author')).slice(0, 200) };
  if (screenName) {
    author.handle = screenName;
    author.url = `https://x.com/${encodeURIComponent(screenName)}`;
  }
  const avatar = safeHttpUrl(r.profile_image_url ?? r.avatar);
  if (avatar) author.avatar = avatar;

  let kind: ItemKind = 'post';
  const rt = str(r.retweeted_status);
  if ((rt && rt !== '0' && rt.trim()) || /^RT @\w+:/.test(text)) kind = 'repost';
  else {
    const reply = str(r.in_reply_to);
    if (reply && reply.trim() && reply !== '0') kind = 'reply';
  }
  const replyId = kind === 'reply' ? str(r.in_reply_to)?.trim() : undefined;
  const quotedId = str(r.quoted_status);
  const quoted =
    quotedId && /^\d+$/.test(quotedId.trim())
      ? { author: { name: 'Quoted post' }, text: '(quoted post not included in export)', url: xStatusUrl(quotedId.trim()) }
      : null;

  const url = safeHttpUrl(r.url) && /\/status\/\d+/.test(String(r.url)) ? safeHttpUrl(r.url)! : screenName ? `https://x.com/${encodeURIComponent(screenName)}/status/${id}` : xStatusUrl(id);
  const lang = str(r.lang) ?? (legacy ? str(legacy.lang) : undefined);
  return {
    platform: 'x',
    externalId: id,
    url,
    author,
    text: truncateText(text),
    links: links.filter((l) => !/\/status\/\d+\/(photo|video)\//.test(l)),
    media,
    quoted,
    lang: lang && lang !== 'und' && lang !== 'zxx' ? lang : null,
    kind,
    replyTo: replyId && /^\d+$/.test(replyId) ? replyId : null,
    publishedAt: toIso(str(r.created_at)) ?? (legacy ? toIso(str(legacy.created_at)) : null) ?? snowflakeToIso(id) ?? new Date().toISOString(),
    provenance: provenance('x-export-json', fileName),
    metrics: { likes: num(r.favorite_count), reposts: num(r.retweet_count), replies: num(r.reply_count) },
  };
}

function exporterLabel(fileName: string): string {
  const n = baseName(fileName).toLowerCase();
  if (n.includes('bookmark')) return 'X export: bookmarks';
  if (n.includes('like')) return 'X export: likes';
  return `X export: ${baseName(fileName).slice(0, 80)}`;
}

function looksLikeExporterJson(head: string): boolean {
  const h = stripBom(head).trimStart();
  if (!h.startsWith('[')) return false;
  return /"full_text"\s*:/.test(h) && /"(screen_name|rest_id|id)"\s*:/.test(h);
}

export const xExportParser: ImportParser = {
  info: info(
    'x-export-json',
    'X export (twitter-web-exporter)',
    'x',
    'JSON or CSV saved by the twitter-web-exporter userscript (e.g. your bookmarks or likes). The userscript reads what you scroll past in the X web app; this importer only reads the file you saved.',
    ['JSON or CSV export file'],
  ),
  detect(_fileName, head) {
    return looksLikeExporterJson(head) || isExporterCsvHeader(firstLine(head));
  },
  parse(fileName, text) {
    const errors = new ErrorList();
    const items: ItemDraft[] = [];
    const body = stripBom(text);
    let rows: Obj[] = [];
    if (body.trimStart().startsWith('[') || body.trimStart().startsWith('{')) {
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch (e) {
        throw new Error(`File is not valid JSON: ${errMsg(e)}`);
      }
      const arr = Array.isArray(data) ? data : isObj(data) ? asArray(data.data ?? data.items ?? data.tweets) : [];
      rows = arr as Obj[];
    } else {
      const table = parseCsv(body);
      const header = (table.shift() ?? []).map((h) => h.trim().toLowerCase());
      if (!header.includes('id') || !header.includes('full_text')) throw new Error('CSV header must include id and full_text columns');
      rows = table.map((cells) => {
        const o: Obj = {};
        header.forEach((h, i) => {
          o[h] = cells[i] ?? '';
        });
        return o;
      });
    }
    rows.forEach((row, i) => {
      if (items.length >= MAX_IMPORT_ITEMS) return;
      try {
        if (!isObj(row)) throw new Error('row is not an object');
        items.push(exporterRow(row, fileName));
      } catch (e) {
        errors.add(`Row ${i + 1}: ${errMsg(e)}`);
      }
    });
    if (rows.length > MAX_IMPORT_ITEMS) errors.add(`File has ${rows.length} rows; only the first ${MAX_IMPORT_ITEMS} were imported`);
    return { items, errors: errors.list(), label: exporterLabel(fileName), platform: 'x' };
  },
};

// ---------------------------------------------------------------------------
// c. Generic JSON and Netscape bookmarks HTML
// ---------------------------------------------------------------------------

function pickStr(o: Obj, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(o[k]);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function platformKind(p: Platform, hasTitle: boolean): ItemKind {
  if (p === 'youtube') return 'video';
  if (p === 'x' || p === 'bluesky' || p === 'mastodon') return 'post';
  if (p === 'reddit') return 'post';
  return hasTitle ? 'article' : 'post';
}

function genericRow(o: Obj, fileName: string, now: string): ItemDraft {
  const url = safeHttpUrl(pickStr(o, ['url', 'link', 'href', 'permalink', 'uri']));
  const rawText = pickStr(o, ['text', 'content', 'body', 'full_text', 'description', 'summary', 'note', 'excerpt']) ?? '';
  const title = pickStr(o, ['title', 'name', 'headline', 'subject']);
  if (!url) throw new Error('no http(s) url/link field');
  const conv = /<[a-z][\s\S]*>/i.test(rawText) ? htmlToText(rawText) : { text: decodeEntities(rawText), links: [], images: [] };
  const text = truncateText(conv.text.trim());
  const links = uniq([...conv.links, ...extractUrls(text)].filter((l) => l !== url));

  let author: Author;
  if (isObj(o.author)) {
    const a = o.author;
    const handle = pickStr(a, ['handle', 'username', 'screen_name']);
    author = { name: (pickStr(a, ['name', 'displayName', 'display_name']) ?? handle ?? 'Unknown author').slice(0, 200) };
    if (handle) author.handle = handle.replace(/^@/, '');
    const au = safeHttpUrl(a.url);
    if (au) author.url = au;
    const av = safeHttpUrl(a.avatar ?? a.avatar_url);
    if (av) author.avatar = av;
  } else {
    const handle = pickStr(o, ['handle', 'username', 'screen_name']);
    const name = pickStr(o, ['author', 'author_name', 'authorName', 'by', 'creator', 'site', 'source']);
    author = { name: (name ?? (handle ? `@${handle.replace(/^@/, '')}` : url ? hostOf(url) : 'Unknown author')).slice(0, 200) };
    if (handle) author.handle = handle.replace(/^@/, '');
    const au = safeHttpUrl(o.author_url ?? o.authorUrl);
    if (au) author.url = au;
  }

  const media: Media[] = [];
  for (const m of asArray(o.media ?? o.images)) {
    if (typeof m === 'string') pushMedia(media, { type: 'image', url: m });
    else if (isObj(m)) {
      const t = str(m.type);
      pushMedia(media, {
        type: t === 'video' ? 'video' : t === 'link' ? 'link' : 'image',
        url: pickStr(m, ['url', 'src', 'original']) ?? '',
        thumb: pickStr(m, ['thumb', 'thumbnail']),
        alt: pickStr(m, ['alt', 'alt_text']),
      });
    }
  }
  const image = safeHttpUrl(o.image ?? o.thumbnail);
  if (image) pushMedia(media, { type: 'image', url: image });
  for (const img of conv.images) pushMedia(media, { type: 'image', url: img });

  const platform = url ? guessPlatform(url) : 'import';
  const finalPlatform: Platform = platform === 'rss' ? 'import' : platform;
  const dateRaw = o.date ?? o.published ?? o.publishedAt ?? o.published_at ?? o.created_at ?? o.createdAt ?? o.time ?? o.timestamp ?? o.saved_at ?? o.added;
  const explicitId = pickStr(o, ['id', 'guid', 'uuid']);
  let externalId = explicitId ?? url ?? 'h:' + hash(`${title ?? ''}\n${text}`);
  if (finalPlatform === 'x' && url) {
    const m = /\/status(?:es)?\/(\d+)/.exec(url);
    if (m) externalId = m[1];
  }
  const tags = asArray(o.tags).filter((t): t is string => typeof t === 'string');
  const draft: ItemDraft = {
    platform: finalPlatform,
    externalId: externalId.slice(0, 500),
    url,
    author,
    text: text || (tags.length ? tags.map((t) => '#' + t).join(' ') : ''),
    links,
    media,
    quoted: null,
    lang: pickStr(o, ['lang', 'language'])?.toLowerCase().split(/[-_]/)[0] ?? null,
    kind: platformKind(finalPlatform, !!title),
    publishedAt: toIso(typeof dateRaw === 'number' ? dateRaw : str(dateRaw)) ?? now,
    provenance: provenance('generic-json', fileName),
    metrics: null,
  };
  if (title) draft.title = title.slice(0, 500);
  return draft;
}

/** Netscape bookmark file: <DT><A HREF="..." ADD_DATE="...">Title</A> [<DD>description] */
function parseNetscapeBookmarks(text: string, fileName: string, now: string): { items: ItemDraft[]; errors: ErrorList } {
  const items: ItemDraft[] = [];
  const errors = new ErrorList();
  const folders: string[] = [];
  const re = /<H3\b[^>]*>([\s\S]*?)<\/H3>|<\/DL>|<A\b([^>]*)>([\s\S]*?)<\/A>(?:\s*<DD>([^<]*))?/gi;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      folders.push(htmlToText(m[1]).text);
      continue;
    }
    if (m[0].toUpperCase() === '</DL>') {
      folders.pop();
      continue;
    }
    n++;
    if (items.length >= MAX_IMPORT_ITEMS) break;
    const attrs = m[2] ?? '';
    const href = /\bHREF\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bHREF\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    const url = safeHttpUrl(decodeEntities(href));
    if (!url) {
      errors.add(`Bookmark ${n}: skipped non-http(s) link`);
      continue;
    }
    const title = htmlToText(m[3] ?? '').text.replace(/\s+/g, ' ').trim() || url;
    const desc = m[4] ? decodeEntities(m[4]).trim() : '';
    const addDate = /\bADD_DATE\s*=\s*"(\d+)"/i.exec(attrs)?.[1];
    const tagsAttr = /\bTAGS\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const folder = folders.filter(Boolean).slice(-2).join(' / ');
    const textParts = [desc];
    if (tagsAttr) textParts.push(tagsAttr.split(',').map((t) => '#' + t.trim()).filter((t) => t.length > 1).join(' '));
    if (folder) textParts.push(`Folder: ${folder}`);
    const platform = guessPlatform(url);
    items.push({
      platform: platform === 'rss' ? 'import' : platform,
      externalId: url.slice(0, 500),
      url,
      author: { name: hostOf(url) || 'Bookmark' },
      title: title.slice(0, 500),
      text: truncateText(textParts.filter(Boolean).join('\n')),
      links: [],
      media: [],
      quoted: null,
      lang: null,
      kind: 'article',
      publishedAt: (addDate ? toIso(Number(addDate) > 1e14 ? Math.floor(Number(addDate) / 1000) : Number(addDate)) : null) ?? now,
      provenance: provenance('generic-json', fileName),
      metrics: null,
    });
  }
  return { items, errors };
}

function isNetscape(head: string): boolean {
  return /<!DOCTYPE NETSCAPE-Bookmark-file/i.test(head) || (/<DL>/i.test(head) && /<DT>\s*<A\s+HREF=/i.test(head));
}

export const genericParser: ImportParser = {
  info: info(
    'generic-json',
    'Generic JSON or browser bookmarks',
    'import',
    'A JSON array (or {"items": [...]}) with url/link, title, text/content, author and date fields, or a bookmarks.html export from any browser or read-later app.',
    ['JSON file or bookmarks.html'],
  ),
  detect(fileName, head) {
    const h = stripBom(head).trimStart();
    if (isNetscape(h)) return true;
    if (/\.html?$/i.test(fileName) && /<A\s+HREF=/i.test(h)) return true;
    return h.startsWith('[') || h.startsWith('{');
  },
  parse(fileName, text) {
    const now = new Date().toISOString();
    const body = stripBom(text);
    if (isNetscape(body.slice(0, 4096)) || (/\.html?$/i.test(fileName) && /<A\s+HREF=/i.test(body))) {
      const { items, errors } = parseNetscapeBookmarks(body, fileName, now);
      if (!items.length && !errors.messages.length) throw new Error('No bookmarks found in this HTML file');
      return { items, errors: errors.list(), label: `Bookmarks: ${baseName(fileName).slice(0, 80)}`, platform: 'import' };
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new Error(`File is not valid JSON: ${errMsg(e)}`);
    }
    let rows: unknown[];
    if (Array.isArray(data)) rows = data;
    else if (isObj(data)) {
      const key = ['items', 'data', 'posts', 'entries', 'bookmarks', 'links', 'articles', 'list'].find((k) => Array.isArray(data[k] as unknown) || isObj(data[k]));
      const v = key ? (data as Obj)[key] : undefined;
      rows = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
    } else rows = [];
    if (!rows.length) throw new Error('JSON has no array of items (expected an array or {"items": [...]})');
    const errors = new ErrorList();
    const items: ItemDraft[] = [];
    rows.forEach((row, i) => {
      if (items.length >= MAX_IMPORT_ITEMS) return;
      try {
        if (!isObj(row)) throw new Error('row is not an object');
        items.push(genericRow(row, fileName, now));
      } catch (e) {
        errors.add(`Row ${i + 1}: ${errMsg(e)}`);
      }
    });
    if (rows.length > MAX_IMPORT_ITEMS) errors.add(`File has ${rows.length} rows; only the first ${MAX_IMPORT_ITEMS} were imported`);
    if (!items.length) throw new Error(`No usable items found (${errors.messages[0] ?? 'rows need a url or link field'})`);
    const platforms = new Set(items.map((x) => x.platform));
    const platform: Platform = platforms.size === 1 ? [...platforms][0] : 'import';
    return { items, errors: errors.list(), label: `Import: ${baseName(fileName).slice(0, 80)}`, platform };
  },
};

/** Order matters: specific formats before the generic fallback. */
export const importParsers: ImportParser[] = [xArchiveParser, xExportParser, genericParser];

/** Picks the first parser whose detect() matches and runs it. Throws a user-facing Error if none match. */
export function detectAndParse(fileName: string, text: string): ImportOutput {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty');
  const head = text.slice(0, 8192);
  const parser = importParsers.find((p) => {
    try {
      return p.detect(fileName, head);
    } catch {
      return false;
    }
  });
  if (!parser) {
    throw new Error(
      `Unrecognised file format for "${baseName(fileName).slice(0, 100)}". Supported: X archive tweets.js / like.js / bookmark.js, twitter-web-exporter JSON or CSV, a JSON array of items, a bookmarks.html export, or an OPML feed list.`,
    );
  }
  return parser.parse(fileName, text);
}
