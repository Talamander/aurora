// Ambient: the feed as a slow, full-screen display. This file decides what each post becomes on
// screen and in what order the posts come; the web app draws them. Pure functions, no DOM.

import type { Item } from './types.ts';

export type SlideKind = 'photo' | 'video' | 'article' | 'text';

export interface Slide {
  item: Item;
  kind: SlideKind;
  /** The picture to fill the screen with (already proxied by the web app), if any. */
  image?: string;
  /** Alt text for the picture, from the source. */
  alt?: string;
  /** What to set in type: a short post, or an article's excerpt. Plain text. */
  text: string;
  title?: string;
}

export interface AmbientFilter {
  photosOnly?: boolean;
  /** A person's key (see personKey). */
  person?: string | null;
}

/** One person across sources: handle when there is one, else the display name, lower-cased. */
export function personKey(it: Pick<Item, 'author'>): string {
  return (it.author.handle || it.author.name || '').trim().toLowerCase();
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Up to `max` characters, cut at a word and marked with an ellipsis when cut. */
export function excerpt(s: string, max: number): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

/** What a post becomes on screen, or null when there is nothing worth showing. */
export function toSlide(it: Item): Slide | null {
  const pic = it.media.find((m) => m.type === 'image' && (m.thumb || m.url));
  const vid = it.media.find((m) => m.type === 'video' && m.thumb);
  const text = clean(it.text || '');
  const title = it.title ? clean(it.title) : undefined;
  if (it.kind === 'article' && title) {
    return { item: it, kind: 'article', title, text: excerpt(text, 320), image: pic ? pic.thumb ?? pic.url : vid?.thumb };
  }
  if (pic) return { item: it, kind: 'photo', image: pic.thumb ?? pic.url, alt: pic.alt, text: excerpt(title ?? text, 220), title };
  if (vid) return { item: it, kind: 'video', image: vid.thumb, alt: vid.alt, text: excerpt(title ?? text, 220), title };
  const body = text || title || '';
  if (body.length < 12) return null;
  return { item: it, kind: 'text', text: excerpt(body, 420), title: text ? title : undefined };
}

// Items are replaced, never changed in place, so a post's slide can be kept between calls. Ambient
// builds slides and the person list from the same 100k posts on open; this halves that work.
const slides = new WeakMap<Item, Slide | null>();
function slideOf(it: Item): Slide | null {
  let s = slides.get(it);
  if (s === undefined) slides.set(it, (s = toSlide(it)));
  return s;
}

/** A small seeded generator, so a shuffle can be repeated (and tested). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Turns posts into slides: drops what cannot be shown, applies the filter, keeps one copy per
 * post, newest first, or shuffled. A shuffle never puts two posts by the same person side by side
 * when it can avoid it, so one prolific account does not take over the screen.
 */
export function buildSlides(items: Item[], filter: AmbientFilter = {}, shuffle?: { seed: number }): Slide[] {
  const seen = new Set<string>();
  const out: Slide[] = [];
  for (const it of items) {
    if (seen.has(it.id) || it.state.archived) continue;
    seen.add(it.id);
    if (filter.person && personKey(it) !== filter.person) continue;
    const s = slideOf(it);
    if (!s) continue;
    if (filter.photosOnly && s.kind !== 'photo' && s.kind !== 'video') continue;
    out.push(s);
  }
  // ISO timestamps sort as plain strings; localeCompare is far slower on 100k of them.
  out.sort((a, b) => (a.item.publishedAt < b.item.publishedAt ? 1 : a.item.publishedAt > b.item.publishedAt ? -1 : 0));
  if (!shuffle) return out;
  const r = rng(shuffle.seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Spread people out: swap a repeat with the next slide by someone else.
  for (let i = 1; i < out.length; i++) {
    if (personKey(out[i].item) !== personKey(out[i - 1].item)) continue;
    const k = out.findIndex((s, n) => n > i && personKey(s.item) !== personKey(out[i - 1].item));
    if (k > 0) [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

/** People in the slides, most frequent first, for the person filter. */
export function peopleIn(items: Item[], limit = 40): { key: string; name: string; count: number }[] {
  const m = new Map<string, { key: string; name: string; count: number }>();
  for (const it of items) {
    if (it.state.archived || !slideOf(it)) continue;
    const key = personKey(it);
    if (!key) continue;
    const p = m.get(key) ?? { key, name: it.author.name || it.author.handle || key, count: 0 };
    p.count++;
    m.set(key, p);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Three hues for the sky behind a slide with no picture, stable per person. */
export function skyFor(seed: string): [number, number, number] {
  const h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 17);
  return [h, (h + 48) % 360, (h + 200) % 360];
}

/** Text size step for a text slide: shorter posts are set bigger. */
export function sizeStep(text: string): 'xl' | 'l' | 'm' | 's' {
  const n = text.length;
  if (n <= 90) return 'xl';
  if (n <= 180) return 'l';
  if (n <= 300) return 'm';
  return 's';
}
