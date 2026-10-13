// Feeds out: any saved view, page feed block or the whole library as RSS 2.0 or JSON Feed 1.1,
// so other readers and tools can follow what Aurora has filtered.
//
// Routes live under /api/feeds/ because the main server only dispatches /api/* to the route
// table. They are GET only and read-only. The server binds to 127.0.0.1, so by default only
// this machine can read them. For remote readers behind a reverse proxy, set a feed token:
// every feed request must then carry ?token=<token>. A request that arrives through a proxy
// (X-Forwarded-For, Forwarded or X-Real-IP present) is refused while no token is set.
//
// Post text is third-party content. It is escaped for XML, control characters are removed,
// and only http(s) links are emitted.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { applyFilters, normalizeSpec, type FilterContext } from '../core/filter.ts';
import { safeHttpUrl } from '../core/normalize.ts';
import { ALL_PROFILE, makeLens, ownerOf, type Lens } from '../core/profiles.ts';
import type { FilterSpec, Item, Profile } from '../core/types.ts';
import type { Store } from './db.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

export interface FeedDeps {
  store: Store;
  HttpError: new (status: number, message: string) => Error;
  /** Profiles, so each one gets its own feed scope (its sources and its AI rules). */
  profiles?: { list: () => Profile[]; get: (key: string) => Profile | null };
  /** Circles mapped to profiles, so friends' shares land in the same profile feeds as in the app. */
  friendRouting?: () => Record<string, string[]>;
}

const TOKEN_SECRET = 'feeds.token';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------- shared query helpers (also used by server/mcp.ts)

/** Run a filter spec over the library the same way the UI does. Returns visible items, best first per spec.sort. */
export function runSpec(store: Store, spec: Partial<FilterSpec> | null | undefined, limit = DEFAULT_LIMIT, items?: Item[], lens?: Lens): Item[] {
  const all = (items ?? store.listItems()).filter((i) => !lens || lens.item(i));
  const ctx = {
    topics: store.listTopics(),
    sourceLabels: Object.fromEntries(store.listSources().map((s) => [s.id, s.label])),
    // Plain-English rule labels, for filter engines that understand them. Ignored otherwise.
    ai: { rules: store.listAiRules().filter((r) => !lens || lens.owns('aiRules', r.id)), labels: store.listLabels() },
  } as FilterContext;
  const result = applyFilters(all, normalizeSpec(spec), ctx);
  return result.visible.slice(0, Math.max(0, limit)).map((e) => e.item);
}

/** Title for a post: its own title, else the first line of text, else the author. */
export function postTitle(item: Item, max = 100): string {
  const raw = (item.title || item.text.split('\n').find((l) => l.trim()) || `Post by ${item.author.name || item.author.handle || 'unknown'}`).trim();
  const clean = raw.replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

// ---------------------------------------------------------------- escaping

// Characters XML 1.0 does not allow at all (C0 controls except tab, LF, CR; lone surrogates; U+FFFE/F).
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function xmlText(s: unknown): string {
  return String(s ?? '')
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
const jsonSafe = (s: unknown) => String(s ?? '').replace(XML_INVALID, '');

// ---------------------------------------------------------------- token

/** Whether a feed token exists. While the owner lock is on, only then may a feed skip the session. */
export function feedTokenSet(store: Pick<Store, 'getSecret'>): boolean {
  return Boolean(store.getSecret(TOKEN_SECRET));
}

function tokenOk(store: Store, req: IncomingMessage, url: URL): { ok: true } | { ok: false; status: number; message: string } {
  const token = store.getSecret(TOKEN_SECRET);
  const proxied = Boolean(req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']);
  if (!token) {
    if (proxied) return { ok: false, status: 403, message: 'This feed was requested through a proxy. Set a feed token in Aurora first (POST /api/feeds/token).' };
    return { ok: true };
  }
  const given = url.searchParams.get('token') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, message: 'Feed token missing or wrong. Add ?token=<your feed token> to the feed URL.' };
  return { ok: true };
}

// ---------------------------------------------------------------- rendering

interface FeedMeta {
  title: string;
  description: string;
  /** Absolute URL of this feed, without the token. */
  selfUrl: string;
  homeUrl: string;
}

function itemLink(item: Item): string | null {
  return safeHttpUrl(item.url) ?? item.links.map(safeHttpUrl).find(Boolean) ?? null;
}

function bodyText(item: Item): string {
  const parts = [item.text.trim()];
  if (item.quoted?.text) parts.push(`> ${item.quoted.author?.name ?? ''}: ${item.quoted.text}`.trim());
  const links = item.links.map(safeHttpUrl).filter((l): l is string => Boolean(l) && l !== item.url);
  if (links.length) parts.push(links.slice(0, 10).join('\n'));
  return parts.filter(Boolean).join('\n\n');
}

function authorLabel(item: Item): string {
  const { name, handle } = item.author;
  if (name && handle && !name.includes(handle)) return `${name} (@${handle.replace(/^@/, '')})`;
  return name || handle || 'unknown';
}

function rfc822(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

export function renderRss(meta: FeedMeta, items: Item[]): string {
  const entries = items.map((item) => {
    const link = itemLink(item);
    const html = bodyText(item)
      .split(/\n{2,}/)
      .map((p) => `<p>${xmlText(p).replace(/\n/g, '<br/>')}</p>`)
      .join('');
    const images = item.media
      .filter((m) => m.type === 'image' && safeHttpUrl(m.url))
      .slice(0, 4)
      .map((m) => `<p><img src="${xmlText(safeHttpUrl(m.url))}" alt="${xmlText(m.alt ?? '')}"/></p>`)
      .join('');
    // The description is HTML carried as XML text, so it is escaped twice: once as HTML, once as XML.
    const description = xmlText(html + images);
    return [
      '    <item>',
      `      <title>${xmlText(postTitle(item, 140))}</title>`,
      link ? `      <link>${xmlText(link)}</link>` : '',
      `      <guid isPermaLink="false">${xmlText(item.id)}</guid>`,
      `      <pubDate>${rfc822(item.publishedAt)}</pubDate>`,
      `      <dc:creator>${xmlText(authorLabel(item))}</dc:creator>`,
      `      <category>${xmlText(item.platform)}</category>`,
      `      <description>${description}</description>`,
      '    </item>',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${xmlText(meta.title)}</title>`,
    `    <link>${xmlText(meta.homeUrl)}</link>`,
    `    <description>${xmlText(meta.description)}</description>`,
    `    <atom:link href="${xmlText(meta.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    '    <generator>Aurora</generator>',
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

export function renderJsonFeed(meta: FeedMeta, items: Item[]): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: jsonSafe(meta.title),
      description: jsonSafe(meta.description),
      home_page_url: meta.homeUrl,
      feed_url: meta.selfUrl,
      items: items.map((item) => {
        const link = itemLink(item);
        const image = item.media.find((m) => m.type === 'image' && safeHttpUrl(m.url));
        const authorUrl = safeHttpUrl(item.author.url);
        return {
          id: item.id,
          ...(link ? { url: link } : {}),
          title: jsonSafe(postTitle(item, 140)),
          content_text: jsonSafe(bodyText(item)),
          date_published: item.publishedAt,
          authors: [{ name: jsonSafe(authorLabel(item)), ...(authorUrl ? { url: authorUrl } : {}) }],
          tags: [item.platform],
          ...(image ? { image: safeHttpUrl(image.url) } : {}),
          _social_reader: { platform: item.platform, kind: item.kind, source_id: item.sourceId, saved: item.state.saved, read: item.state.read },
        };
      }),
    },
    null,
    1,
  );
}

// ---------------------------------------------------------------- routes

function baseUrl(store: Store, req: IncomingMessage): string {
  const configured = safeHttpUrl(store.getSetting<string>('feeds.baseUrl'));
  if (configured) return configured.replace(/\/+$/, '');
  // The main server already refuses unknown Host headers, so this is a local name.
  return `http://${req.headers.host ?? '127.0.0.1'}`;
}

function parseName(name: string): { id: string; format: 'xml' | 'json' } | null {
  const m = /^(.+)\.(xml|rss|json)$/.exec(name);
  if (!m) return null;
  return { id: m[1], format: m[2] === 'json' ? 'json' : 'xml' };
}

export function registerFeedRoutes(route: RouteFn, deps: FeedDeps) {
  const { store, HttpError } = deps;

  const respond = (req: IncomingMessage, res: ServerResponse, url: URL, format: 'xml' | 'json', title: string, description: string, items: Item[]) => {
    const auth = tokenOk(store, req, url);
    if (!auth.ok) throw new HttpError(auth.status, auth.message);
    const base = baseUrl(store, req);
    const meta: FeedMeta = { title, description, selfUrl: base + url.pathname, homeUrl: base + '/' };
    const body = format === 'json' ? renderJsonFeed(meta, items) : renderRss(meta, items);
    res.writeHead(200, {
      'content-type': format === 'json' ? 'application/feed+json; charset=utf-8' : 'application/rss+xml; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  };

  // A view or page feed follows the profile that owns it; ?profile= picks one for the rest.
  const lensFor = (id: string | null | undefined) => {
    const list = deps.profiles?.list() ?? [];
    return list.length ? makeLens(list, id, deps.friendRouting?.()) : undefined;
  };
  const profileParam = (url: URL) => {
    const key = url.searchParams.get('profile');
    if (!key || key === ALL_PROFILE) return ALL_PROFILE;
    const p = deps.profiles?.get(key);
    if (!p) throw new HttpError(404, 'No such profile');
    return p.id;
  };

  const limitOf = (url: URL, fallback = DEFAULT_LIMIT) => {
    const n = Number(url.searchParams.get('limit') ?? fallback);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : fallback;
  };

  // Token management. The token itself is shown only when it is created.
  route('GET', '/api/feeds', (req, _s, _p, _b, url) => {
    const base = baseUrl(store, req);
    const pid = profileParam(url);
    const lens = lensFor(pid);
    const everything = pid === ALL_PROFILE
      ? { name: 'Everything', rss: `${base}/api/feeds/all.xml`, json: `${base}/api/feeds/all.json` }
      : { name: `Everything in ${lens?.profile?.name ?? pid}`, rss: `${base}/api/feeds/profile/${encodeURIComponent(pid)}.xml`, json: `${base}/api/feeds/profile/${encodeURIComponent(pid)}.json` };
    return {
      tokenSet: Boolean(store.getSecret(TOKEN_SECRET)),
      baseUrl: store.getSetting<string>('feeds.baseUrl') ?? null,
      profile: pid,
      feeds: [
        everything,
        ...store.listViews().filter((v) => !lens || lens.owns('views', v.id)).map((v) => ({ name: v.name, rss: `${base}/api/feeds/view/${encodeURIComponent(v.id)}.xml`, json: `${base}/api/feeds/view/${encodeURIComponent(v.id)}.json` })),
        ...store.listPages().filter((p) => !lens || lens.owns('pages', p.id)).flatMap((p) =>
          p.blocks.flatMap((b, i) =>
            b.type === 'feed' || b.type === 'gallery' || b.type === 'people'
              ? [{ name: `${p.name}: ${b.title ?? `block ${i + 1}`}`, rss: `${base}/api/feeds/page/${encodeURIComponent(p.id)}/${i}.xml`, json: `${base}/api/feeds/page/${encodeURIComponent(p.id)}/${i}.json` }]
              : [],
          ),
        ),
      ],
    };
  });
  route('POST', '/api/feeds/token', (_q, _s, _p, body) => {
    if (body?.action === 'clear') {
      store.setSecret(TOKEN_SECRET, null);
      return { tokenSet: false };
    }
    const token = randomBytes(24).toString('base64url');
    store.setSecret(TOKEN_SECRET, token);
    return { tokenSet: true, token };
  });
  route('PUT', '/api/feeds/settings', (_q, _s, _p, body) => {
    if ('baseUrl' in (body ?? {})) {
      if (body.baseUrl === null || body.baseUrl === '') store.setSetting('feeds.baseUrl', null);
      else {
        const u = safeHttpUrl(body.baseUrl);
        if (!u) throw new HttpError(400, 'baseUrl must be an http(s) URL');
        store.setSetting('feeds.baseUrl', u.replace(/\/+$/, ''));
      }
    }
    return { baseUrl: store.getSetting<string>('feeds.baseUrl') ?? null };
  });

  route('GET', '/api/feeds/:name', (req, res, p, _b, url) => {
    const parsed = parseName(p.name);
    if (!parsed || parsed.id !== 'all') throw new HttpError(404, 'No such feed. Try /api/feeds/all.xml or /api/feeds/all.json');
    const pid = profileParam(url);
    respond(req, res, url, parsed.format, 'Aurora: everything', 'Every post in the library, newest first, with duplicates and archived posts left out.', runSpec(store, {}, limitOf(url), undefined, lensFor(pid)));
  });

  route('GET', '/api/feeds/profile/:name', (req, res, p, _b, url) => {
    const parsed = parseName(p.name);
    if (!parsed) throw new HttpError(404, 'Feed URLs end in .xml (RSS) or .json (JSON Feed)');
    const profile = deps.profiles?.get(parsed.id);
    if (!profile) throw new HttpError(404, 'No such profile');
    respond(req, res, url, parsed.format, `Aurora: ${profile.name}`, `Every post in the profile "${profile.name}", with its own rules.`, runSpec(store, {}, limitOf(url), undefined, lensFor(profile.id)));
  });

  route('GET', '/api/feeds/view/:name', (req, res, p, _b, url) => {
    const parsed = parseName(p.name);
    if (!parsed) throw new HttpError(404, 'Feed URLs end in .xml (RSS) or .json (JSON Feed)');
    const view = store.listViews().find((v) => v.id === parsed.id);
    if (!view) throw new HttpError(404, 'No such view');
    respond(req, res, url, parsed.format, `Aurora: ${view.name}`, `The saved view "${view.name}".`, runSpec(store, view.spec, limitOf(url), undefined, lensFor(ownerOf(deps.profiles?.list(), 'views', view.id))));
  });

  route('GET', '/api/feeds/page/:pageId/:name', (req, res, p, _b, url) => {
    const parsed = parseName(p.name);
    if (!parsed || !/^\d{1,3}$/.test(parsed.id)) throw new HttpError(404, 'Feed URLs look like /api/feeds/page/<pageId>/<blockIndex>.xml');
    const page = store.getPage(p.pageId);
    const block = page?.blocks[Number(parsed.id)];
    if (!page || !block || (block.type !== 'feed' && block.type !== 'gallery' && block.type !== 'people') || !block.spec) throw new HttpError(404, 'No such feed block');
    const blockLimit = 'limit' in block && typeof block.limit === 'number' ? block.limit : DEFAULT_LIMIT;
    const name = `${page.name}${block.title ? `: ${block.title}` : ''}`;
    respond(req, res, url, parsed.format, `Aurora: ${name}`, `A feed block on the page "${page.name}".`, runSpec(store, block.spec, limitOf(url, Math.min(blockLimit, MAX_LIMIT)), undefined, lensFor(ownerOf(deps.profiles?.list(), 'pages', page.id))));
  });
}
