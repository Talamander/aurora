// Threads: one author's chain of posts, read as one piece.
//
// Two ways a post joins a thread, both conservative, and never across authors:
//  1. Explicit: the source said the post replies to another post (`replyTo`), that parent is in the
//     library, and it has the same author on the same platform. Bluesky and the X API give this.
//  2. Numbered: sources with no reply data (feeds, imports) still show threads as "1/", "2/7" or a
//     🧵. Posts join when they come from the same source and author, number on from the post
//     before (1, 2, 3...), and arrive within 15 minutes of it. A lone "4/5" never starts anything.
//
// Grouping is pure and one pass over the library; the feed collapses each thread to one card and
// the reader shows it as one article. Nothing here changes what is stored.

import { countWords, readMinutes, type Article, type ArticleBlock, type Span } from './longform.ts';
import type { Item } from './types.ts';

export interface ThreadGroups {
  /** item id -> root item id, for every post in a thread of two or more (the root included). */
  threadOf: Map<string, string>;
  /** root item id -> member ids, oldest first. */
  members: Map<string, string[]>;
}

/** The longest gap between two numbered posts of one thread. */
export const THREAD_GAP_MS = 15 * 60_000;
const MAX_DEPTH = 500;

const authorKey = (it: Item) => (it.author.handle || it.author.name || '').trim().toLowerCase();

// "2/7 ..." at the start, "... 2/7" or "(2/7)" at the end. Up to three digits, so dates like
// 2026/10 never match, and "n/m" needs n <= m.
const LEAD = /^\s*\(?(\d{1,3})\s*\/\s*(\d{1,3})?\)?(?=[\s.:)\]]|$)/;
const TAIL = /(?:^|\s)\(?(\d{1,3})\s*\/\s*(\d{1,3})?\)?\s*$/;
const SPOOL = '\u{1F9F5}';

interface Marker {
  /** The post's number in the thread, or null for a bare 🧵 opener. */
  n: number | null;
  of: number | null;
}

/** Reads a thread number off a post's text: "1/", "2/7", "(3/7)", or a 🧵 opener. */
export function threadMarker(it: Pick<Item, 'text' | 'kind'>): Marker | null {
  const text = it.text;
  if (!text) return it.kind === 'thread' ? { n: null, of: null } : null;
  const lead = text.length > 0 && text.charCodeAt(0) < 128 ? LEAD.exec(text.slice(0, 12)) : null;
  const tail = !lead && text.includes('/') ? TAIL.exec(text.slice(-14)) : null;
  const m = lead ?? tail;
  if (m) {
    const n = Number(m[1]);
    const of = m[2] ? Number(m[2]) : null;
    if (n >= 1 && (of === null || (of >= 2 && n <= of))) return { n, of };
  }
  if (text.includes(SPOOL) || it.kind === 'thread') return { n: null, of: null };
  return null;
}

const cache = new WeakMap<readonly Item[], ThreadGroups>();

/** Groups a library's posts into threads. Cached per items array. */
export function groupThreads(items: readonly Item[]): ThreadGroups {
  const hit = cache.get(items);
  if (hit) return hit;
  const threadOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const time = new Map<string, number>();

  // Explicit replies first: link each self-reply to its parent, then walk to the root.
  const byId = new Map<string, Item>();
  const replies: Item[] = [];
  // Numbered candidates, by source and author.
  const numbered = new Map<string, { it: Item; m: Marker; t: number }[]>();
  for (const it of items) {
    if (it.kind === 'repost') continue;
    if (it.replyTo) replies.push(it);
    const text = it.text;
    if (text && (text.includes('/') || text.includes(SPOOL)) || it.kind === 'thread') {
      const m = threadMarker(it);
      if (m) {
        const key = `${it.sourceId}\u0000${it.platform}\u0000${authorKey(it)}`;
        const t = Date.parse(it.publishedAt);
        if (!Number.isFinite(t)) continue;
        const arr = numbered.get(key);
        if (arr) arr.push({ it, m, t });
        else numbered.set(key, [{ it, m, t }]);
      }
    }
  }
  if (replies.length) for (const it of items) byId.set(it.id, it);

  const parentOf = (it: Item): Item | null => {
    if (!it.replyTo) return null;
    const p = byId.get(`${it.platform}:${it.replyTo}`);
    if (!p || p.id === it.id || p.kind === 'repost' || authorKey(p) !== authorKey(it) || !authorKey(it)) return null;
    return p;
  };
  for (const it of replies) {
    if (!parentOf(it)) continue;
    let root = it;
    const seen = new Set<string>([it.id]);
    for (let d = 0; d < MAX_DEPTH; d++) {
      const known = threadOf.get(root.id);
      if (known) {
        root = byId.get(known) ?? root;
        break;
      }
      const p = parentOf(root);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      root = p;
    }
    for (const id of seen) threadOf.set(id, root.id);
    threadOf.set(root.id, root.id);
  }

  // Numbered chains, for posts not already in an explicit thread.
  for (const list of numbered.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.t - b.t);
    let chain: { it: Item; m: Marker; t: number }[] = [];
    const flush = () => {
      if (chain.length >= 2) {
        const root = chain[0].it.id;
        for (const c of chain) threadOf.set(c.it.id, root);
      }
      chain = [];
    };
    for (const c of list) {
      if (threadOf.has(c.it.id)) {
        flush();
        continue;
      }
      const prev = chain[chain.length - 1];
      const follows =
        prev &&
        c.t - prev.t <= THREAD_GAP_MS &&
        c.m.n !== null &&
        (prev.m.n === null ? c.m.n === 1 || c.m.n === 2 : c.m.n === prev.m.n + 1) &&
        (c.m.of === null || chain[0].m.of === null || c.m.of === chain[0].m.of);
      if (follows) {
        chain.push(c);
        continue;
      }
      flush();
      // Only a first post opens a thread: a 🧵 or a "1/".
      if (c.m.n === null || c.m.n === 1) chain = [c];
    }
    flush();
  }

  if (threadOf.size) {
    for (const it of items) {
      const root = threadOf.get(it.id);
      if (!root) continue;
      time.set(it.id, Date.parse(it.publishedAt) || 0);
      const arr = members.get(root);
      if (arr) arr.push(it.id);
      else members.set(root, [it.id]);
    }
    for (const [root, ids] of members) {
      if (ids.length < 2) {
        members.delete(root);
        for (const id of ids) threadOf.delete(id);
        continue;
      }
      ids.sort((a, b) => (time.get(a)! - time.get(b)!) || (a === root ? -1 : b === root ? 1 : 0));
      // The root is always first, even when clocks disagree.
      if (ids[0] !== root) {
        ids.splice(ids.indexOf(root), 1);
        ids.unshift(root);
      }
    }
  }
  const out = { threadOf, members };
  cache.set(items, out);
  return out;
}

/** The member ids of the thread a post is in, oldest first, or null when it stands alone. */
export function threadFor(g: ThreadGroups, id: string): string[] | null {
  const root = g.threadOf.get(id);
  return root ? g.members.get(root) ?? null : null;
}

/**
 * Collapses each thread in a feed list to one entry, at the place of its first visible post. The
 * entry is the thread's first post when that one is in the list, so the card reads from the start.
 */
export function collapseThreads<T extends { item: Item }>(list: readonly T[], g: ThreadGroups): T[] {
  if (!g.threadOf.size) return list as T[];
  const rootEntry = new Map<string, T>();
  let any = false;
  for (const e of list) {
    const root = g.threadOf.get(e.item.id);
    if (!root) continue;
    any = true;
    if (root === e.item.id) rootEntry.set(root, e);
  }
  if (!any) return list as T[];
  const placed = new Set<string>();
  const out: T[] = [];
  for (const e of list) {
    const root = g.threadOf.get(e.item.id);
    if (!root) {
      out.push(e);
      continue;
    }
    if (placed.has(root)) continue;
    placed.add(root);
    out.push(rootEntry.get(root) ?? e);
  }
  return out;
}

/** Strips the "2/7" numbering from a post, which reads as noise once the posts are joined. */
export function stripMarker(text: string): string {
  return text.replace(LEAD, '').replace(TAIL, '').trim();
}

const https = (u: string | undefined) => !!u && u.startsWith('https://');
const PLATFORM_NAMES: Record<string, string> = { x: 'X', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', facebook: 'Facebook', reddit: 'Reddit' };

/**
 * One article from a thread's posts, oldest first: each post's paragraphs, its pictures and any
 * quoted post, followed by a small link to that post on its site. Text stays text.
 */
export function articleFromThread(posts: Item[]): Article | null {
  if (posts.length < 2) return null;
  const root = posts[0];
  const blocks: ArticleBlock[] = [];
  let words = 0;
  const site = PLATFORM_NAMES[root.platform] ?? null;
  posts.forEach((it, i) => {
    const text = stripMarker(it.text);
    words += countWords(text);
    for (const p of text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)) blocks.push({ t: 'p', spans: [{ text: p }] });
    for (const m of it.media) {
      if (m.type === 'image' && https(m.url)) blocks.push({ t: 'img', src: m.url, alt: m.alt });
      else if (m.type === 'video' && https(m.thumb)) blocks.push({ t: 'img', src: m.thumb!, alt: m.alt, caption: 'Video: open the post to play it' });
    }
    if (it.quoted?.text) {
      const spans: Span[] = [{ text: it.quoted.text }, { text: ` (${it.quoted.author.name})`, i: true }];
      blocks.push({ t: 'quote', spans });
    }
    if (/^https?:\/\//i.test(it.url)) blocks.push({ t: 'p', spans: [{ text: `${i + 1} of ${posts.length}`, href: it.url, i: true }] });
  });
  const first = stripMarker(root.title || root.text).split('\n').find((l) => l.trim()) ?? '';
  const title = first.length > 110 ? `${first.slice(0, 107).replace(/\s+\S*$/, '')}…` : first || `Thread by ${root.author.name}`;
  return {
    itemId: root.id,
    url: root.url,
    title,
    byline: root.author.name || null,
    siteName: site ? `Thread on ${site}` : 'Thread',
    publishedAt: root.publishedAt,
    // The pictures sit inline with their posts, so there is no separate lead picture.
    leadImage: null,
    excerpt: stripMarker(root.text).slice(0, 300),
    blocks,
    words,
    minutes: readMinutes(words),
    fetchedAt: posts.map((p) => p.ingestedAt).sort().at(-1) ?? new Date().toISOString(),
  };
}
