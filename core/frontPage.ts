// Front page: today's best posts set like a newspaper's front page. This file picks and ranks the
// stories; the web app typesets them. Pure functions, no DOM, no AI: every signal is already in the
// library (recency, unread, what you saved from each source, pictures, articles, dedupe).

import { excerpt, personKey } from './ambient.ts';
import type { Evaluation } from './filter.ts';
import type { Item } from './types.ts';

export type StoryKind = 'article' | 'photo' | 'post';

export interface Story {
  item: Item;
  kind: StoryKind;
  /** The headline: an article's title, else the opening of the post. Plain text. */
  head: string;
  /** The standfirst under the headline. Plain text, may be empty. */
  dek: string;
  /** The picture (already proxied by the web app), if any. */
  image?: string;
  alt?: string;
  score: number;
}

export interface FrontPerson {
  key: string;
  name: string;
  avatar?: string;
  /** How many of their posts you saved or read, over the whole library. */
  kept: number;
  story: Story;
}

export interface FrontPage {
  lead: Story | null;
  secondary: Story[];
  briefs: Story[];
  photos: Story[];
  people: FrontPerson[];
  /** Stories considered, and the sources they came from. */
  considered: number;
  sources: number;
  /** The newest post's time, for the date line when the library is old. */
  newest: string | null;
}

export interface FrontOptions {
  now?: number;
  /** Only posts this recent are news. Falls back to the newest posts when too few qualify. */
  windowHours?: number;
}

const HOUR = 3_600_000;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
// Only a proxied path or an https URL may be shown as a picture.
const safeImage = (u: string | undefined) => (u && (/^https:\/\//i.test(u) || u.startsWith('/api/img?')) ? u : undefined);

/** What a post becomes on the page, or null when there is too little to set. */
export function toStory(it: Item, score = 0): Story | null {
  const pic = it.media.find((m) => m.type === 'image' && safeImage(m.thumb ?? m.url));
  const vid = it.media.find((m) => m.type === 'video' && safeImage(m.thumb));
  const image = pic ? safeImage(pic.thumb ?? pic.url) : vid ? safeImage(vid.thumb) : undefined;
  const alt = (pic ?? vid)?.alt;
  const text = clean(it.text || '');
  const title = it.title ? clean(it.title) : '';
  if (title && (it.kind === 'article' || text.length > 200)) {
    return { item: it, kind: 'article', head: excerpt(title, 140), dek: excerpt(text.startsWith(title) ? text.slice(title.length) : text, 260), image, alt, score };
  }
  const body = text || title;
  if (!body && !image) return null;
  if (!image && body.length < 24) return null;
  // A post's headline is its first sentence when that is short enough to set big.
  const first = /^(.{20,120}?[.!?])(\s|$)/.exec(body)?.[1];
  const head = first ?? excerpt(body, 110);
  const rest = first ? clean(body.slice(first.length)) : body.length > 110 ? body : '';
  return { item: it, kind: image ? 'photo' : 'post', head, dek: excerpt(rest, 240), image, alt, score };
}

/** How much you keep from each source: saved posts over all posts, smoothed. */
export function sourceAffinity(items: Item[]): Map<string, number> {
  const seen = new Map<string, [number, number]>();
  for (const it of items) {
    const c = seen.get(it.sourceId) ?? [0, 0];
    c[0]++;
    if (it.state.saved) c[1]++;
    seen.set(it.sourceId, c);
  }
  const out = new Map<string, number>();
  for (const [id, [n, saved]] of seen) out.set(id, (saved + 0.5) / (n + 10));
  return out;
}

export function storyScore(it: Item, affinity: number, now: number): number {
  const ageH = Math.max(0, (now - Date.parse(it.publishedAt)) / HOUR);
  const fresh = Math.pow(0.5, ageH / 18); // half as newsworthy every 18 hours
  let s = 1 + fresh * 2;
  if (!it.state.read) s += 0.8;
  if (it.kind === 'article' && it.title) s += 0.9;
  if (it.media.some((m) => m.type === 'image')) s += 0.6;
  if ((it.text || '').length > 280) s += 0.3;
  s += Math.min(1.5, affinity * 12);
  const m = it.metrics;
  if (m) s += Math.min(0.6, Math.log10(1 + (m.likes ?? 0) + 2 * (m.reposts ?? 0)) / 6);
  return s;
}

/**
 * Builds the front page from a filtered feed (only visible evaluations are used, and only the
 * primary copy of a duplicate). `library` is every post in the profile, for the saved signals.
 */
export function buildFrontPage(evals: Evaluation[], library: Item[], opts: FrontOptions = {}): FrontPage {
  const now = opts.now ?? Date.now();
  const windowMs = (opts.windowHours ?? 36) * HOUR;
  const pool = evals.filter((e) => e.visible && !e.duplicateOf && !e.item.state.archived).map((e) => e.item);
  let candidates = pool.filter((it) => now - Date.parse(it.publishedAt) <= windowMs);
  if (candidates.length < 12) candidates = [...pool].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 160);

  const affinity = sourceAffinity(library);
  const stories: Story[] = [];
  for (const it of candidates) {
    const st = toStory(it, storyScore(it, affinity.get(it.sourceId) ?? 0, now));
    if (st) stories.push(st);
  }
  stories.sort((a, b) => b.score - a.score || b.item.publishedAt.localeCompare(a.item.publishedAt));

  const used = new Set<string>();
  const take = (st: Story) => (used.add(st.item.id), st);
  // The lead wants a picture and something to read; failing that, the best story of all.
  const leadPick = stories.find((s) => s.image && (s.kind === 'article' || s.dek.length > 60)) ?? stories.find((s) => s.image) ?? stories[0];
  const lead = leadPick ? take(leadPick) : null;

  // Secondary stories: substantial, one per source (not the lead's) while sources last, then any.
  const bySource = new Set(lead ? [lead.item.sourceId] : []);
  const secondary: Story[] = [];
  const substantial = (s: Story) => s.kind === 'article' || s.dek.length > 40 || !!s.image;
  for (const s of stories) {
    if (secondary.length >= 3) break;
    if (used.has(s.item.id) || bySource.has(s.item.sourceId) || !substantial(s)) continue;
    secondary.push(take(s));
    bySource.add(s.item.sourceId);
  }
  for (const s of stories) {
    if (secondary.length >= 3) break;
    if (!used.has(s.item.id) && substantial(s)) secondary.push(take(s));
  }

  const photos: Story[] = [];
  for (const s of stories) {
    if (photos.length >= 6) break;
    if (!used.has(s.item.id) && s.image && s.kind === 'photo') photos.push(take(s));
  }

  // People you keep coming back to, each with their best story not already on the page.
  const kept = new Map<string, number>();
  for (const it of library) if (it.state.saved || it.state.read) kept.set(personKey(it), (kept.get(personKey(it)) ?? 0) + (it.state.saved ? 3 : 1));
  const people: FrontPerson[] = [];
  const met = new Set<string>();
  const ranked = stories.filter((s) => !used.has(s.item.id) && (kept.get(personKey(s.item)) ?? 0) > 0)
    .sort((a, b) => (kept.get(personKey(b.item)) ?? 0) - (kept.get(personKey(a.item)) ?? 0) || b.score - a.score);
  for (const s of ranked) {
    if (people.length >= 4) break;
    const key = personKey(s.item);
    if (!key || met.has(key)) continue;
    met.add(key);
    people.push({ key, name: s.item.author.name || s.item.author.handle || 'Someone', avatar: safeImage(s.item.author.avatar), kept: kept.get(key) ?? 0, story: take(s) });
  }

  const briefs: Story[] = [];
  for (const s of stories) {
    if (briefs.length >= 7) break;
    if (!used.has(s.item.id) && s.kind !== 'photo') briefs.push(take(s));
  }

  const newest = candidates.reduce<string | null>((m, it) => (!m || it.publishedAt > m ? it.publishedAt : m), null);
  return { lead, secondary, briefs, photos, people, considered: stories.length, sources: new Set(stories.map((s) => s.item.sourceId)).size, newest };
}
