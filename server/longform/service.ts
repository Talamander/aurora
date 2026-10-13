// Longform service: which URL to read for an item, extraction with a feed-text fallback, and a
// slow background worker that prepares saved posts and longform-source posts for offline-ish
// reading. All fetches go through safeFetch; the worker is rate limited and stops retrying
// a page after two failures.

import { countWords, readMinutes, type Article, type ArticleBlock } from '../../core/longform.ts';
import type { Item } from '../../core/types.ts';
import type { SafeFetch } from '../connectors/types.ts';
import type { Store } from '../db.ts';
import { ExtractError, extractArticle } from './extract.ts';
import { articleIndex, getArticle, saveArticle, saveArticleError } from './store.ts';

export const READ_LATER = 'Read later';

// Hosts whose pages are social posts or players, not articles.
const NOT_ARTICLE_HOSTS = /(^|\.)(x\.com|twitter\.com|bsky\.app|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|threads\.net|reddit\.com|redd\.it|imgur\.com|giphy\.com|t\.co|vimeo\.com|spotify\.com|open\.spotify\.com|music\.apple\.com|apps\.apple\.com|play\.google\.com)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mp3|m4a|wav|zip|pdf)(\?|#|$)/i;

function articleLike(url: string): boolean {
  try {
    const u = new URL(url);
    if (NOT_ARTICLE_HOSTS.test(u.hostname)) return false;
    if (MEDIA_EXT.test(u.pathname)) return false;
    return u.pathname.length > 1 || !!u.search;
  } catch {
    return false;
  }
}

/** The page the reader should open for a post: the post itself for articles, else its main link. */
export function articleUrlFor(item: Item): string | null {
  if (item.kind === 'video') return null;
  if (item.kind === 'article' && articleLike(item.url)) return item.url;
  const linkCard = item.media.find((m) => m.type === 'link')?.url;
  for (const l of [linkCard, ...item.links]) if (l && articleLike(l)) return l;
  return null;
}

/** Whether a post can open in the reader at all (an article page, or enough text of its own). */
export function readable(item: Item): boolean {
  return !!articleUrlFor(item) || countWords(item.text) >= 150;
}

/** An article made from the post's own text, when the page cannot be fetched or read. */
export function articleFromItem(item: Item): Article | null {
  const words = countWords(item.text);
  if (words < 60) return null;
  const blocks: ArticleBlock[] = item.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ t: 'p' as const, spans: [{ text: p }] }));
  const img = item.media.find((m) => m.type === 'image' && m.url.startsWith('https://'));
  return {
    itemId: item.id,
    url: item.url,
    title: item.title || item.text.split('\n')[0].slice(0, 120),
    byline: item.author.name || null,
    siteName: null,
    publishedAt: item.publishedAt,
    leadImage: img?.url ?? null,
    excerpt: item.text.slice(0, 300),
    blocks,
    words,
    minutes: readMinutes(words),
    fetchedAt: new Date().toISOString(),
  };
}

const inflight = new Map<string, Promise<Article | null>>();

/**
 * Extracts and caches the article for an item. When the page fails but the post carries enough
 * text (a full-text feed, a long post), that text becomes the article so the reader still works.
 */
export function extractForItem(store: Store, item: Item, fetcher: SafeFetch): Promise<Article | null> {
  const running = inflight.get(item.id);
  if (running) return running;
  const p = (async () => {
    const url = articleUrlFor(item);
    const fallback = () => {
      const a = articleFromItem(item);
      if (a) saveArticle(store, a);
      return a;
    };
    if (!url) {
      const a = fallback();
      if (!a) saveArticleError(store, item.id, item.url, 'This post has no article to read');
      return a;
    }
    try {
      const a = await extractArticle(url, item.id, fetcher);
      // Feed text can be longer than what a teaser page shows (some newsletters gate the web).
      const own = countWords(item.text);
      if (own > a.words * 1.5 && own > 300) return fallback();
      if (!a.publishedAt && item.kind === 'article') a.publishedAt = item.publishedAt;
      if (!a.byline && item.kind === 'article') a.byline = item.author.name || null;
      saveArticle(store, a);
      return a;
    } catch (e) {
      const msg = e instanceof ExtractError ? e.message : `Could not fetch the page: ${(e as Error).message}`;
      const a = fallback();
      if (!a) saveArticleError(store, item.id, url, msg);
      return a;
    }
  })().finally(() => inflight.delete(item.id));
  inflight.set(item.id, p);
  return p;
}

export function isLongformSource(store: Store, sourceId: string): boolean {
  const s = store.getSource(sourceId);
  return !!s && s.config.longform === true;
}

/** Saved posts, the read-later queue and recent posts from longform sources, not yet prepared. */
function backgroundCandidates(store: Store, limit: number): Item[] {
  const index = articleIndex(store);
  const longform = new Set(store.listSources().filter((s) => s.config.longform === true && s.enabled).map((s) => s.id));
  const recent = Date.now() - 10 * 86_400_000;
  const out: Item[] = [];
  for (const it of store.listItems()) {
    if (out.length >= limit) break;
    if (it.isDemo || it.state.archived) continue;
    const meta = index[it.id];
    if (meta && (meta.status === 'ok' || meta.attempts >= 2)) continue;
    const queued = it.state.saved || it.state.collections.includes(READ_LATER);
    const fromLongform = longform.has(it.sourceId) && it.kind === 'article' && !it.state.read && Date.parse(it.publishedAt) > recent;
    if (!queued && !fromLongform) continue;
    if (!articleUrlFor(it) && countWords(it.text) < 60) continue;
    out.push(it);
  }
  return out;
}

export function createLongformWorker(deps: { store: Store; fetch: SafeFetch; changed: (reason: string) => void; log?: (m: string) => void }) {
  let running = false;
  async function pass(): Promise<number> {
    if (running) return 0;
    if (deps.store.getSetting<boolean>('longform.background') === false) return 0;
    running = true;
    let done = 0;
    try {
      const todo = backgroundCandidates(deps.store, 16);
      const lanes = [0, 1].map(async () => {
        while (todo.length) {
          const it = todo.shift()!;
          if (getArticle(deps.store, it.id).status === 'ok') continue;
          await extractForItem(deps.store, it, deps.fetch).catch(() => null);
          done++;
          // Be gentle with sites: a short pause between pages per lane.
          await new Promise((r) => setTimeout(r, 1500));
        }
      });
      await Promise.all(lanes);
      if (done) deps.changed('articles');
    } catch (e) {
      deps.log?.(`longform: ${(e as Error).message}`);
    } finally {
      running = false;
    }
    return done;
  }
  return { pass, kick: (ms = 2000) => void setTimeout(() => void pass(), ms).unref() };
}
