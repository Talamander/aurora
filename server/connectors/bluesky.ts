// Bluesky public author feed via the unauthenticated AppView (public.api.bsky.app).
// Read-only; no credentials involved.

import type { Author, ItemKind, Media } from '../../core/types.ts';
import { extractUrls, safeHttpUrl } from '../../core/normalize.ts';
import type { FeedConnector, ItemDraft, SafeFetch } from './types.ts';
import { asArray, isObj, num, pushMedia, str, toIso, truncateText, uniq } from './util.ts';

export const BLUESKY_CONNECTOR_ID = 'bluesky-public';
export const BLUESKY_CONNECTOR_VERSION = 1;
const APPVIEW = 'https://public.api.bsky.app/xrpc';
const PAGE_LIMIT = 50;
const MAX_PAGES = 2;

type Obj = Record<string, unknown>;

const HANDLE_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;
const DID_RE = /^did:(plc|web):[a-zA-Z0-9._:%-]{1,2048}$/;

/** Accepts "@alice.bsky.social", "alice.bsky.social", a DID, or a bsky.app profile/post URL. */
export function normalizeActor(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!/^(www\.)?bsky\.app$/i.test(u.hostname)) return null;
      const m = /^\/profile\/([^/]+)/.exec(u.pathname);
      if (!m) return null;
      s = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  s = s.replace(/^@/, '');
  if (DID_RE.test(s)) return s;
  s = s.toLowerCase();
  return HANDLE_RE.test(s) ? s : null;
}

function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? '';
}

function postUrl(uri: string, author: Obj | undefined): string {
  const handle = str(author?.handle);
  const did = str(author?.did) ?? (/^at:\/\/([^/]+)/.exec(uri)?.[1] ?? '');
  const who = handle && handle !== 'handle.invalid' ? handle : did;
  return `https://bsky.app/profile/${encodeURIComponent(who)}/post/${encodeURIComponent(rkeyOf(uri))}`;
}

function mapAuthor(a: unknown): Author {
  const o = isObj(a) ? a : {};
  const handle = str(o.handle);
  const did = str(o.did);
  const author: Author = { name: (str(o.displayName)?.trim() || handle || did || 'Unknown').slice(0, 200) };
  if (handle && handle !== 'handle.invalid') author.handle = handle;
  const who = author.handle ?? did;
  if (who) author.url = `https://bsky.app/profile/${encodeURIComponent(who)}`;
  const avatar = safeHttpUrl(o.avatar);
  if (avatar) author.avatar = avatar;
  return author;
}

interface EmbedResult {
  media: Media[];
  links: string[];
  quoted: ItemDraft['quoted'];
}

function mapEmbedView(embed: unknown, out: EmbedResult): void {
  if (!isObj(embed)) return;
  const type = str(embed.$type) ?? '';
  if (type.startsWith('app.bsky.embed.images')) {
    for (const img of asArray<Obj>(embed.images)) {
      if (!isObj(img)) continue;
      pushMedia(out.media, {
        type: 'image',
        url: str(img.fullsize) ?? str(img.thumb) ?? '',
        thumb: str(img.thumb),
        alt: str(img.alt)?.trim() || undefined,
      });
    }
  } else if (type.startsWith('app.bsky.embed.external')) {
    const ext = isObj(embed.external) ? embed.external : {};
    const uri = safeHttpUrl(ext.uri);
    if (uri) {
      pushMedia(out.media, { type: 'link', url: uri, alt: str(ext.title)?.trim() || undefined, thumb: str(ext.thumb) });
      if (!out.links.includes(uri)) out.links.push(uri);
    }
  } else if (type.startsWith('app.bsky.embed.video')) {
    const playlist = safeHttpUrl(embed.playlist);
    const thumb = safeHttpUrl(embed.thumbnail);
    if (playlist || thumb) {
      pushMedia(out.media, { type: 'video', url: playlist ?? thumb ?? '', thumb: thumb ?? undefined, alt: str(embed.alt)?.trim() || undefined });
    }
  } else if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    mapEmbedView(embed.media, out);
    const rec = isObj(embed.record) ? embed.record : {};
    mapEmbedView({ $type: 'app.bsky.embed.record#view', record: rec.record }, out);
  } else if (type.startsWith('app.bsky.embed.record')) {
    const rec = isObj(embed.record) ? embed.record : null;
    if (!rec) return;
    const rtype = str(rec.$type) ?? '';
    if (rtype.endsWith('#viewRecord') || (rtype === '' && isObj(rec.value))) {
      const value = isObj(rec.value) ? rec.value : {};
      const uri = str(rec.uri) ?? '';
      out.quoted = {
        author: mapAuthor(rec.author),
        text: truncateText(str(value.text) ?? '', 5000),
        url: uri ? postUrl(uri, isObj(rec.author) ? rec.author : undefined) : undefined,
      };
    } else if (rtype.endsWith('#viewNotFound') || rtype.endsWith('#viewBlocked') || rtype.endsWith('#viewDetached')) {
      out.quoted = { author: { name: 'Unavailable post' }, text: '(quoted post is unavailable)' };
    }
    // Feed generator / list / starter-pack embeds are ignored.
  }
}

/** Pure mapper for an app.bsky.feed.getAuthorFeed response. */
export function mapAuthorFeed(json: unknown): { items: ItemDraft[]; errors: string[]; cursor: string | null } {
  const items: ItemDraft[] = [];
  const errors: string[] = [];
  const root = isObj(json) ? json : {};
  for (const entry of asArray<Obj>(root.feed)) {
    try {
      if (!isObj(entry) || !isObj(entry.post)) continue;
      const post = entry.post;
      const uri = str(post.uri);
      if (!uri || !uri.startsWith('at://')) continue;
      const record = isObj(post.record) ? post.record : {};
      const author = mapAuthor(post.author);
      const url = postUrl(uri, isObj(post.author) ? post.author : undefined);
      const text = truncateText(str(record.text) ?? '');

      const embedOut: EmbedResult = { media: [], links: [], quoted: null };
      mapEmbedView(post.embed, embedOut);

      const facetLinks: string[] = [];
      for (const facet of asArray<Obj>(record.facets)) {
        if (!isObj(facet)) continue;
        for (const feat of asArray<Obj>(facet.features)) {
          if (isObj(feat) && str(feat.$type) === 'app.bsky.richtext.facet#link') {
            const u = safeHttpUrl(feat.uri);
            if (u) facetLinks.push(u);
          }
        }
      }
      const links = uniq([...facetLinks, ...extractUrls(text), ...embedOut.links]);

      const reason = isObj(entry.reason) ? entry.reason : null;
      let kind: ItemKind = 'post';
      if (reason && str(reason.$type) === 'app.bsky.feed.defs#reasonRepost') kind = 'repost';
      else if (isObj(record.reply)) kind = 'reply';
      // A reply's parent, so a chain of self-replies can be read as one thread.
      const parentUri = kind === 'reply' && isObj(record.reply) && isObj(record.reply.parent) ? str(record.reply.parent.uri) : undefined;

      const langs = asArray<string>(record.langs).filter((l) => typeof l === 'string');
      const lang = langs.length ? langs[0].toLowerCase().split('-')[0] : null;

      items.push({
        platform: 'bluesky',
        externalId: uri,
        url,
        author,
        text,
        links,
        media: embedOut.media,
        quoted: embedOut.quoted,
        lang,
        kind,
        replyTo: parentUri?.startsWith('at://') ? parentUri : null,
        publishedAt: toIso(str(record.createdAt)) ?? toIso(str(post.indexedAt)) ?? new Date().toISOString(),
        provenance: { connector: BLUESKY_CONNECTOR_ID, connectorVersion: BLUESKY_CONNECTOR_VERSION, via: 'api' },
        metrics: {
          likes: num(post.likeCount),
          reposts: num(post.repostCount),
          replies: num(post.replyCount),
        },
      });
    } catch (e) {
      if (errors.length < 50) errors.push(`Skipped a post: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { items, errors, cursor: str(root.cursor) ?? null };
}

async function xrpc(fetch: SafeFetch, method: string, params: Record<string, string>): Promise<Obj> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${APPVIEW}/${method}?${qs}`, { headers: { accept: 'application/json' } });
  let body: unknown = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    // fall through
  }
  if (res.status >= 400) {
    const msg = isObj(body) ? str(body.message) ?? str(body.error) : undefined;
    if (res.status === 400 && msg && /not found|could not find|unable to resolve/i.test(msg)) throw new Error(`Bluesky account not found (${msg})`);
    if (res.status === 429) throw new Error('Bluesky rate limit reached; try again later');
    throw new Error(`Bluesky request failed (HTTP ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''})`);
  }
  if (!isObj(body)) throw new Error('Bluesky returned an unexpected response');
  return body;
}

export const blueskyConnector: FeedConnector = {
  info: {
    id: BLUESKY_CONNECTOR_ID,
    version: BLUESKY_CONNECTOR_VERSION,
    name: 'Bluesky profile (public)',
    platform: 'bluesky',
    kind: 'api',
    available: true,
    blockedReason: null,
    needs: ['Bluesky handle or profile URL'],
    description: 'Public posts from any Bluesky account via the public AppView API. No login needed; replies are excluded.',
  },
  async prepareConfig(input, fetch) {
    const actor = normalizeActor(typeof input.handle === 'string' ? input.handle : typeof input.url === 'string' ? input.url : '');
    if (!actor) throw new Error('Enter a Bluesky handle (e.g. alice.bsky.social), DID, or bsky.app profile URL');
    const profile = await xrpc(fetch, 'app.bsky.actor.getProfile', { actor });
    const did = str(profile.did);
    const handle = str(profile.handle);
    if (!did) throw new Error('Bluesky profile has no DID');
    const display = str(profile.displayName)?.trim();
    const label = display ? `${display} (@${handle ?? did})` : `@${handle ?? did}`;
    return { config: { handle: handle ?? actor, did }, label };
  },
  async sync(ctx) {
    const actor = str(ctx.config.did) ?? str(ctx.config.handle);
    if (!actor) return { items: [], errors: ['Source has no Bluesky handle'] };
    const items: ItemDraft[] = [];
    const errors: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { actor, limit: String(PAGE_LIMIT), filter: 'posts_no_replies' };
      if (cursor) params.cursor = cursor;
      let json: Obj;
      try {
        json = await xrpc(ctx.fetch, 'app.bsky.feed.getAuthorFeed', params);
      } catch (e) {
        if (page === 0) throw e;
        errors.push(e instanceof Error ? e.message : String(e));
        break;
      }
      const mapped = mapAuthorFeed(json);
      items.push(...mapped.items);
      errors.push(...mapped.errors);
      cursor = mapped.cursor;
      if (!cursor || mapped.items.length === 0) break;
    }
    return { items, errors };
  },
};
