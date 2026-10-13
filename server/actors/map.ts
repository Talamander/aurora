// Maps an actor's RawPost to the ItemDraft the ingest pipeline expects.
// Actor output is untrusted: text is reduced to plain text and URLs to safe http(s).

import type { Item, ItemKind, Media } from '../../core/types.ts';
import { extractUrls, htmlToText, safeHttpUrl } from '../../core/normalize.ts';
import type { ItemDraft } from '../connectors/types.ts';
import { num, pushMedia, toIso, truncateText, uniq } from '../connectors/util.ts';
import type { ActorManifest, RawPost } from './types.ts';

const KINDS = new Set<ItemKind>(['post', 'reply', 'repost', 'thread', 'article', 'video']);

const clip = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function guessKind(raw: RawPost, url: string): ItemKind {
  if (raw.kind && KINDS.has(raw.kind)) return raw.kind;
  if (/youtube\.com\/(watch|shorts)|youtu\.be\/|vimeo\.com\/\d|tiktok\.com\/.+\/video\//i.test(url)) return 'video';
  if (raw.title && (raw.html?.length ?? raw.text?.length ?? 0) > 1500) return 'article';
  return 'post';
}

export function rawToDraft(raw: RawPost, manifest: Pick<ActorManifest, 'id' | 'version' | 'platform'>): ItemDraft {
  const url = safeHttpUrl(raw.url);
  if (!url) throw new Error('RawPost needs an http(s) url');
  const externalId = String(raw.id ?? '').trim().slice(0, 300);
  if (!externalId) throw new Error('RawPost needs an id');

  let text = typeof raw.text === 'string' ? raw.text : '';
  const links: string[] = [];
  const media: Media[] = [];
  // html wins when it carries more than text (actors often put a summary in text and the full
  // article body in html).
  if (typeof raw.html === 'string' && raw.html.trim()) {
    const h = htmlToText(raw.html);
    if (!text || h.text.length > text.trim().length * 1.5) {
      text = h.text;
      links.push(...h.links);
      for (const img of h.images.slice(0, 8)) pushMedia(media, { type: 'image', url: img });
    }
  }
  text = truncateText(text.replace(/\r\n?/g, '\n').trim());
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    const u = safeHttpUrl(l);
    if (u) links.push(u);
  }
  links.push(...extractUrls(text));
  for (const m of Array.isArray(raw.media) ? raw.media.slice(0, 20) : []) {
    if (!m || typeof m !== 'object') continue;
    pushMedia(media, { type: m.type === 'video' ? 'video' : 'image', url: m.url, thumb: m.thumb, alt: clip(m.alt, 1000) });
  }

  const a = raw.author ?? {};
  const author: Item['author'] = { name: clip(a.name, 200) ?? clip(a.handle, 200) ?? manifest.platform };
  const handle = clip(a.handle, 200);
  if (handle) author.handle = handle;
  const authorUrl = safeHttpUrl(a.url);
  if (authorUrl) author.url = authorUrl;
  const avatar = safeHttpUrl(a.avatar);
  if (avatar) author.avatar = avatar;

  const draft: ItemDraft = {
    platform: manifest.platform as Item['platform'],
    externalId,
    url,
    author,
    text,
    links: uniq(links).filter((l) => l !== url).slice(0, 50),
    media,
    kind: guessKind(raw, url),
    publishedAt: toIso(raw.publishedAt) ?? new Date().toISOString(),
    provenance: { connector: `actor:${manifest.id}`, connectorVersion: manifest.version, via: 'api' },
  };
  const title = clip(raw.title, 500);
  if (title) draft.title = title.replace(/\s+/g, ' ');
  if (raw.lang && typeof raw.lang === 'string') draft.lang = raw.lang.slice(0, 16);
  if (raw.quoted && typeof raw.quoted === 'object') {
    const q = raw.quoted;
    const qUrl = safeHttpUrl(q.url);
    draft.quoted = {
      author: { name: clip(q.author?.name, 200) ?? clip(q.author?.handle, 200) ?? '', ...(clip(q.author?.handle, 200) ? { handle: clip(q.author?.handle, 200) } : {}) },
      text: truncateText(String(q.text ?? ''), 5000),
      ...(qUrl ? { url: qUrl } : {}),
    };
  }
  if (raw.metrics && typeof raw.metrics === 'object') {
    const m: NonNullable<Item['metrics']> = {};
    const likes = num(raw.metrics.likes);
    const reposts = num(raw.metrics.reposts);
    const replies = num(raw.metrics.replies);
    if (likes != null) m.likes = likes;
    if (reposts != null) m.reposts = reposts;
    if (replies != null) m.replies = replies;
    if (Object.keys(m).length) draft.metrics = m;
  }
  return draft;
}
