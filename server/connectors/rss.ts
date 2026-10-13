// RSS 2.0 / Atom / RDF (RSS 1.0) feed connector.
// Feed content is untrusted: everything is reduced to plain text and safe http(s) URLs.

import { XMLParser } from 'fast-xml-parser';
import type { Author, ItemKind, Media, Platform } from '../../core/types.ts';
import { decodeEntities, extractUrls, hash, htmlToText, safeHttpUrl } from '../../core/normalize.ts';
import type { FeedConnector, ItemDraft, SafeFetch } from './types.ts';
import { asArray, guessPlatform, isObj, pushMedia, toIso, truncateText, uniq } from './util.ts';

export const RSS_CONNECTOR_ID = 'rss';
export const RSS_CONNECTOR_VERSION = 1;
const MAX_ENTRIES = 200;

export interface ParsedFeed {
  title: string;
  link: string | null;
  platform: Platform;
  format: 'rss' | 'atom' | 'rdf';
  items: ItemDraft[];
}

const ARRAY_TAGS = new Set([
  'item', 'entry', 'link', 'enclosure', 'category', 'media:content', 'media:thumbnail', 'media:group', 'author',
]);

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: false,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
}

/** Text content of a parsed node (string, {#text}, or array of those). */
function txt(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.length ? txt(node[0]) : '';
  if (isObj(node)) {
    const t = node['#text'];
    if (t != null) return txt(t);
  }
  return '';
}

function attr(node: unknown, name: string): string {
  if (!isObj(node)) return '';
  const v = node['@_' + name];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** A title may contain escaped HTML; reduce to a single plain-text line. */
function plainTitle(node: unknown): string {
  const raw = txt(node);
  if (!raw) return '';
  const t = /[<&]/.test(raw) ? htmlToText(decodeEntities(raw)).text : raw;
  return t.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function resolveUrl(href: string, base: string): string | null {
  if (!href) return null;
  try {
    return safeHttpUrl(new URL(href.trim(), base).toString());
  } catch {
    return null;
  }
}

function atomAlternate(links: unknown, base: string): string | null {
  const list = asArray(links);
  let fallback: string | null = null;
  for (const l of list) {
    if (typeof l === 'string') {
      fallback ??= resolveUrl(l, base);
      continue;
    }
    const rel = attr(l, 'rel') || 'alternate';
    const href = resolveUrl(attr(l, 'href') || txt(l), base);
    if (!href) continue;
    if (rel === 'alternate' && (!attr(l, 'type') || /html/i.test(attr(l, 'type')))) return href;
    if (rel === 'alternate') fallback ??= href;
    else if (!fallback && rel !== 'self' && rel !== 'enclosure' && rel !== 'replies' && rel !== 'edit') fallback = href;
  }
  return fallback;
}

function mediaTypeFrom(mime: string, medium: string, url: string): Media['type'] {
  const m = (medium || mime).toLowerCase();
  if (m.startsWith('image')) return 'image';
  if (m.startsWith('video')) return 'video';
  if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url)) return 'image';
  if (/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url)) return 'video';
  return 'link';
}

function kindFor(platform: Platform): ItemKind {
  if (platform === 'youtube') return 'video';
  if (platform === 'bluesky' || platform === 'mastodon' || platform === 'reddit') return 'post';
  return 'article';
}

function langOf(v: string): string | null {
  const m = /^([a-z]{2,3})\b/i.exec(v.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Mastodon/Bluesky HTML contains hashtag and mention links; they are navigation, not content links. */
function isNavLink(link: string, platform: Platform, feedHost: string): boolean {
  if (platform !== 'mastodon' && platform !== 'bluesky') return false;
  try {
    const u = new URL(link);
    if (u.hostname !== feedHost && platform === 'bluesky') return false;
    return /^\/(tags|tag|hashtag|search)\b/.test(u.pathname) || /^\/@[\w.-]+(@[\w.-]+)?\/?$/.test(u.pathname) || /^\/profile\/[^/]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

function collectMedia(entry: Record<string, unknown>, base: string, media: Media[]): void {
  for (const enc of asArray(entry.enclosure)) {
    const url = resolveUrl(attr(enc, 'url'), base);
    if (url) pushMedia(media, { type: mediaTypeFrom(attr(enc, 'type'), '', url), url });
  }
  // Atom <link rel="enclosure">
  for (const l of asArray(entry.link)) {
    if (attr(l, 'rel') !== 'enclosure') continue;
    const url = resolveUrl(attr(l, 'href'), base);
    if (url) pushMedia(media, { type: mediaTypeFrom(attr(l, 'type'), '', url), url });
  }
  const groups = [entry, ...asArray<Record<string, unknown>>(entry['media:group']).filter(isObj)];
  let groupThumb: string | null = null;
  for (const g of groups) {
    for (const t of asArray(g['media:thumbnail'])) groupThumb ??= resolveUrl(attr(t, 'url'), base);
  }
  for (const g of groups) {
    for (const c of asArray(g['media:content'])) {
      const url = resolveUrl(attr(c, 'url'), base);
      if (!url || /shockwave|x-flash/i.test(attr(c, 'type'))) continue;
      const type = mediaTypeFrom(attr(c, 'type'), attr(c, 'medium'), url);
      const alt = plainTitle((c as Record<string, unknown>)['media:description'] ?? (c as Record<string, unknown>)['media:title']) || undefined;
      pushMedia(media, { type, url, alt, thumb: type !== 'image' ? groupThumb ?? undefined : undefined });
    }
  }
  if (groupThumb && !media.some((m) => m.url === groupThumb || m.thumb === groupThumb)) {
    pushMedia(media, { type: 'image', url: groupThumb });
  }
}

/**
 * Pure feed parser. Throws Error when the document is not RSS, Atom or RDF.
 * `feedUrl` is used to resolve relative links and to guess the platform.
 */
export function parseFeed(xml: string, feedUrl: string, now: Date = new Date()): ParsedFeed {
  // Drop any DOCTYPE (no custom entities from feeds) and a leading BOM.
  const cleaned = xml.replace(/^﻿/, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
  let doc: Record<string, unknown>;
  try {
    doc = makeParser().parse(cleaned) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Could not parse feed XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rss = doc.rss;
  const atom = doc.feed;
  const rdf = doc['rdf:RDF'] ?? doc.RDF;
  let format: ParsedFeed['format'];
  let channel: Record<string, unknown>;
  let entries: Record<string, unknown>[];
  if (isObj(rss) && isObj(rss.channel)) {
    format = 'rss';
    channel = rss.channel;
    entries = asArray<Record<string, unknown>>(channel.item).filter(isObj);
  } else if (isObj(atom)) {
    format = 'atom';
    channel = atom;
    entries = asArray<Record<string, unknown>>(atom.entry).filter(isObj);
  } else if (isObj(rdf)) {
    format = 'rdf';
    channel = isObj(rdf.channel) ? rdf.channel : {};
    entries = asArray<Record<string, unknown>>(rdf.item).filter(isObj);
  } else {
    throw new Error('Not an RSS, Atom or RDF feed');
  }

  const base = safeHttpUrl(feedUrl) ?? 'https://invalid.invalid/';
  const platform = guessPlatform(base);
  const feedHost = new URL(base).hostname;
  const feedTitle = plainTitle(channel.title) || feedHost.replace(/^www\./, '');
  const feedLink = format === 'atom' ? atomAlternate(channel.link, base) : resolveUrl(txt(channel.link) || attr(asArray(channel.link)[0], 'href'), base);
  const feedLang = langOf(txt(channel.language) || txt(channel['dc:language']) || attr(channel, 'xml:lang'));
  const kind = kindFor(platform);
  const nowIso = now.toISOString();

  const items: ItemDraft[] = [];
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    const group = asArray<Record<string, unknown>>(e['media:group']).find(isObj);
    const title = plainTitle(e.title) || (group ? plainTitle(group['media:title']) : '');
    const link = format === 'atom' ? atomAlternate(e.link, base) : resolveUrl(txt(e.link) || attr(asArray(e.link)[0], 'href'), base);
    const guidNode = e.guid;
    const guid = txt(guidNode) || txt(e.id) || attr(e, 'rdf:about');
    const guidIsLink = isObj(guidNode) ? attr(guidNode, 'isPermaLink') !== 'false' : false;
    const url = link ?? (guidIsLink ? resolveUrl(guid, base) : null) ?? feedLink ?? base;

    const html =
      txt(e['content:encoded']) || txt(e.content) || txt(e.description) || txt(e.summary) ||
      (group ? txt(group['media:description']) : '');
    const contentType = isObj(e.content) ? attr(e.content, 'type') : '';
    const isPlain = format === 'atom' && contentType === 'text' && !txt(e['content:encoded']);
    const conv = isPlain ? { text: html, links: [] as string[], images: [] as string[] } : htmlToText(html);
    let text = conv.text;
    if (group && !txt(e.content) && !txt(e.description)) text = txt(group['media:description']);
    text = truncateText(text.trim());

    const links = uniq([...conv.links, ...extractUrls(text)].filter((l) => l !== url && !isNavLink(l, platform, feedHost)));
    const media: Media[] = [];
    collectMedia(e, base, media);
    if (platform === 'youtube' && /youtube\.com\/(watch|shorts)|youtu\.be\//.test(url)) {
      // Represent the video itself (thumbnail as poster) instead of a bare thumbnail image.
      const thumbIdx = media.findIndex((m) => m.type === 'image');
      const thumb = thumbIdx >= 0 ? media.splice(thumbIdx, 1)[0].url : undefined;
      media.unshift({ type: 'video', url, ...(thumb ? { thumb } : {}) });
    }
    for (const img of conv.images) pushMedia(media, { type: 'image', url: img });

    const authorNode = asArray(e.author)[0];
    const authorName =
      plainTitle(e['dc:creator']) ||
      (isObj(authorNode) ? plainTitle(authorNode.name) : plainTitle(authorNode)) ||
      feedTitle;
    const authorUri = isObj(authorNode) ? resolveUrl(txt(authorNode.uri), base) : null;
    const author: Author = { name: authorName.slice(0, 200) };
    const authorUrl = authorUri ?? feedLink;
    if (authorUrl) author.url = authorUrl;
    if (platform === 'reddit' && /^\/u\//.test(authorName)) author.handle = authorName.slice(3);

    const publishedAt =
      toIso(txt(e.pubDate)) ?? toIso(txt(e.published)) ?? toIso(txt(e['dc:date'])) ?? toIso(txt(e.updated)) ?? nowIso;
    // The id must not depend on the fallback date, or undated entries would multiply on every sync.
    // Non-URL guids ("123") are only unique within one feed, so namespace them by feed.
    const rawId = guid || link || hash(`${title}\n${text.slice(0, 500)}`);
    const externalId = (/^https?:\/\//i.test(rawId) ? rawId : `${hash(base)}:${rawId}`).slice(0, 500);
    const lang = langOf(attr(e, 'xml:lang')) ?? feedLang;

    const draft: ItemDraft = {
      platform,
      externalId,
      url,
      author,
      text,
      links,
      media,
      quoted: null,
      lang,
      kind: platform === 'youtube' && !/watch|shorts|youtu\.be/.test(url) ? 'article' : kind,
      publishedAt,
      provenance: { connector: RSS_CONNECTOR_ID, connectorVersion: RSS_CONNECTOR_VERSION, via: 'feed', feedUrl: base },
      metrics: null,
    };
    // Mastodon/Bluesky feed "titles" just repeat the post text.
    if (title && platform !== 'mastodon' && platform !== 'bluesky') draft.title = title;
    items.push(draft);
  }
  return { title: feedTitle, link: feedLink, platform, format, items };
}

/** Finds <link rel="alternate" type="application/rss+xml|atom+xml"> in an HTML page. */
export function discoverFeedLinks(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const get = (name: string) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return r ? decodeEntities(r[1] ?? r[2] ?? r[3] ?? '') : '';
    };
    if (!/\balternate\b/i.test(get('rel'))) continue;
    if (!/application\/(rss|atom|rdf)\+xml/i.test(get('type'))) continue;
    const href = resolveUrl(get('href'), pageUrl);
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html)/i.test(text.slice(0, 500));
}

async function fetchFeed(url: string, fetch: SafeFetch): Promise<{ feed: ParsedFeed; url: string }> {
  const res = await fetch(url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1' },
  });
  if (res.status === 404 || res.status === 410) throw new Error(`Feed not found (HTTP ${res.status})`);
  if (res.status === 429) throw new Error('The site is rate limiting requests (HTTP 429); try again later');
  if (res.status >= 400) throw new Error(`Feed request failed (HTTP ${res.status})`);
  try {
    return { feed: parseFeed(res.text, res.url), url: res.url };
  } catch (e) {
    if (!looksLikeHtml(res.text, res.headers['content-type'] ?? '')) throw e;
  }
  const found = discoverFeedLinks(res.text, res.url);
  if (!found.length) throw new Error('That page is not a feed and does not advertise one (no RSS/Atom <link rel="alternate">)');
  // Follow exactly one discovered link.
  const res2 = await fetch(found[0], { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
  if (res2.status >= 400) throw new Error(`Discovered feed request failed (HTTP ${res2.status})`);
  return { feed: parseFeed(res2.text, res2.url), url: res2.url };
}

export const rssConnector: FeedConnector = {
  info: {
    id: RSS_CONNECTOR_ID,
    version: RSS_CONNECTOR_VERSION,
    name: 'RSS / Atom feed',
    platform: 'rss',
    kind: 'feed',
    available: true,
    blockedReason: null,
    needs: ['Feed URL or a web page that links to its feed'],
    description:
      'Any RSS 2.0, Atom or RDF feed. Also works for public Bluesky profile feeds (bsky.app/profile/<handle>/rss), Mastodon accounts (<instance>/@user.rss), subreddits (reddit.com/r/<name>/.rss) and YouTube channels (youtube.com/feeds/videos.xml?channel_id=…).',
  },
  async prepareConfig(input, fetch) {
    const raw = typeof input.url === 'string' ? input.url.trim() : '';
    const withScheme = raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) ? `https://${raw}` : raw;
    const url = safeHttpUrl(withScheme);
    if (!url) throw new Error('Enter a valid http(s) feed URL');
    const { feed, url: finalUrl } = await fetchFeed(url, fetch);
    return { config: { url: finalUrl, platform: feed.platform }, label: feed.title };
  },
  async sync(ctx) {
    const url = safeHttpUrl(ctx.config.url);
    if (!url) return { items: [], errors: ['Source has no valid feed URL'] };
    const res = await ctx.fetch(url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1' },
    });
    if (res.status === 429) return { items: [], errors: ['The site is rate limiting requests (HTTP 429); will retry on the next sync'] };
    if (res.status >= 400) return { items: [], errors: [`Feed request failed (HTTP ${res.status})`] };
    // Keep the configured URL for platform guessing and provenance even if it redirected.
    const feed = parseFeed(res.text, url, ctx.now());
    return { items: feed.items, errors: [] };
  },
};
