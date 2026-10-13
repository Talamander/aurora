// "Your week": a weekly recap computed from local reading data only. Pure, so the server, the
// web app and tests share it. Weeks run Monday 00:00 to the next Monday 00:00 in local time.

import { applyFilters, normalizeSpec } from './filter.ts';
import { itemHaystack, matchTopics } from './classify.ts';
import type { Item, Library } from './types.ts';

export interface ReadingRow {
  itemId: string;
  progress: number;
  updatedAt: string;
}

export interface WeekHighlight {
  id: string;
  itemId: string;
  quote: string;
  createdAt: string;
}

export interface WeekInput {
  lib: Library;
  /** Reading positions from the longform reader. */
  reading: ReadingRow[];
  /** Word counts of extracted articles, by item id. */
  words: Record<string, number>;
  highlights: WeekHighlight[];
  start: Date;
  end: Date;
}

export interface WeekPerson {
  key: string;
  name: string;
  handle: string | null;
  avatar: string | null;
  platform: string;
  count: number;
  sampleId: string;
}

export interface WeekStats {
  weekId: string;
  start: string;
  end: string;
  /** Posts opened or marked read this week. */
  read: number;
  saved: number;
  /** Estimated minutes spent in articles (progress through each article times its length). */
  minutes: number;
  articles: number;
  highlights: number;
  /** Posts that arrived this week. */
  arrived: number;
  /** Of those, how many the noise filter or plain-English AI rules set aside. */
  setAside: number;
  noise: number;
  ruled: number;
  /** Rough minutes not spent scrolling past what was set aside, at SKIM_SECONDS a post. */
  savedMinutes: number;
  /** Posts read per day, Monday first. */
  days: number[];
  people: WeekPerson[];
  sources: { id: string; label: string; platform: string; count: number }[];
  topic: { id: string; name: string; count: number; before: number } | null;
  best: { itemId: string; title: string; author: string; source: string; url: string; image: string | null; minutes: number; highlight: { id: string; quote: string } | null } | null;
  /** Ids of the posts the AI may write about (read or saved this week), most telling first. */
  notable: string[];
  /** True when nothing happened: the story shows a gentle empty state instead. */
  quiet: boolean;
  /** Active reading time this week by profile, busiest first (core/timeSpent.ts). Absent on older weeks. */
  timeBy?: { profile: string; name: string; color: string | null; seconds: number }[];
}

export const SKIM_SECONDS = 5;
const WORDS_PER_MINUTE = 230;
const DAY = 86_400_000;

/** Monday 00:00 local time of the week holding `d`. */
export function weekStart(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

/** ISO 8601 week id, e.g. "2026-W41", for the week starting at Monday `start`. */
export function weekId(start: Date): string {
  const t = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); // the Thursday of this week decides the year
  const n = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(n).padStart(2, '0')}`;
}

/** Start of the week named by an id like "2026-W41". */
export function weekFromId(id: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return null;
  const jan4 = new Date(Number(m[1]), 0, 4);
  const start = weekStart(jan4);
  start.setDate(start.getDate() + (Number(m[2]) - 1) * 7);
  return weekId(start) === id ? start : null;
}

export function weekRange(start: Date): { start: Date; end: Date } {
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

const inRange = (iso: string | null | undefined, a: number, b: number) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= a && t < b;
};

/**
 * inRange for one window, for passes over the whole library. ISO timestamps whose date is more
 * than a day outside the window are rejected by comparing the date text, which skips parsing most
 * of 100k timestamps. A day of margin covers any UTC offset.
 */
function rangeTest(a: number, b: number) {
  const lo = new Date(a - DAY).toISOString().slice(0, 10);
  const past = new Date(b + 2 * DAY).toISOString().slice(0, 10);
  return (iso: string | null | undefined) => {
    if (!iso) return false;
    // Plain string order works on the date part: "2026-10-05T…" < "2026-10-06" and >= "2026-10-05".
    if (iso.charCodeAt(4) === 45 && iso.charCodeAt(7) === 45 && (iso < lo || iso >= past)) return false;
    const t = Date.parse(iso);
    return t >= a && t < b;
  };
}

/** Topic ids per post, kept while the post object and the topic list stay the same. */
const topicCache = new WeakMap<Item, { key: string; ids: string[] }>();

const authorKey = (it: Item) => `${it.platform}:${(it.author.handle ?? it.author.name).toLowerCase()}`;

export function computeWeek(input: WeekInput): WeekStats {
  const { lib, start, end } = input;
  const a = start.getTime();
  const b = end.getTime();
  // Demo posts count only when the whole library is the demo, the same rule the catch-up card uses.
  const allDemo = lib.items.length > 0 && lib.items.every((i) => i.isDemo);
  const items = allDemo ? lib.items : lib.items.filter((i) => !i.isDemo);
  // Only posts with reading progress or highlights are looked up by id; skip a 100k-entry map.
  const wanted = new Set<string>([...input.reading.map((r) => r.itemId), ...input.highlights.map((h) => h.itemId)]);
  const byId = new Map<string, Item>();
  if (wanted.size) for (const i of items) if (wanted.has(i.id)) byId.set(i.id, i);
  const labels = Object.fromEntries(lib.sources.map((s) => [s.id, s.label]));

  const inWeek = rangeTest(a, b);
  const readItems = items.filter((i) => i.state.read && inWeek(i.state.readAt));
  const savedItems = items.filter((i) => i.state.saved && inWeek(i.state.savedAt));
  const days = [0, 0, 0, 0, 0, 0, 0];
  for (const it of readItems) days[Math.min(6, Math.max(0, Math.floor((Date.parse(it.state.readAt!) - a) / DAY)))]++;

  // Minutes in articles: how far through each article, times its length, for positions saved this week.
  let minutes = 0;
  let articles = 0;
  const progressOf = new Map<string, number>();
  for (const r of input.reading) {
    if (!inRange(r.updatedAt, a, b) || !byId.has(r.itemId)) continue;
    const words = input.words[r.itemId] ?? 0;
    if (!words || r.progress <= 0) continue;
    progressOf.set(r.itemId, r.progress);
    minutes += (words / WORDS_PER_MINUTE) * Math.min(1, r.progress);
    if (r.progress >= 0.85) articles++;
  }
  const weekMarks = input.highlights.filter((h) => inRange(h.createdAt, a, b) && byId.has(h.itemId));

  // What arrived, and what the noise filter and AI rules set aside from it.
  const arrivedItems = items.filter((i) => inWeek(i.ingestedAt ?? i.publishedAt));
  const spec = normalizeSpec({ hideNoise: true, aiRules: true, hideDuplicates: false, archived: 'any', showDemo: true });
  const res = applyFilters(arrivedItems, spec, { topics: lib.topics, sourceLabels: labels, ai: { rules: lib.aiRules, labels: lib.labels } });
  let noise = 0;
  let ruled = 0;
  for (const ev of res.hidden) {
    if (ev.hidden.some((h) => h.key === 'aiRules')) ruled++;
    else if (ev.hidden.some((h) => h.key === 'hideNoise')) noise++;
  }
  const setAside = noise + ruled;

  // People and sources: who the reader actually spent time with; what arrived if nothing was read yet.
  const engaged = readItems.length + savedItems.length >= 3;
  const pool = engaged ? [...new Map([...readItems, ...savedItems].map((i) => [i.id, i])).values()] : res.visible.map((e) => e.item);
  const people = new Map<string, WeekPerson>();
  const sources = new Map<string, number>();
  for (const it of pool) {
    if (it.provenance?.connector !== 'friends') {
      // The same person on two platforms counts once: group by display name when there is one.
      const k = it.author.name ? `name:${it.author.name.trim().toLowerCase()}` : authorKey(it);
      const p = people.get(k) ?? { key: k, name: it.author.name || it.author.handle || 'Someone', handle: it.author.handle ?? null, avatar: it.author.avatar ?? null, platform: it.platform, count: 0, sampleId: it.id };
      p.count++;
      if (!p.avatar && it.author.avatar) p.avatar = it.author.avatar;
      people.set(k, p);
    }
    sources.set(it.sourceId, (sources.get(it.sourceId) ?? 0) + 1);
  }
  const topPeople = [...people.values()].sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)).slice(0, 5);
  const topSources = [...sources.entries()]
    .map(([id, count]) => ({ id, count, label: labels[id] ?? 'A source', platform: lib.sources.find((s) => s.id === id)?.platform ?? 'web' }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 4);

  // The topic that grew most against the week before (by posts that arrived).
  let topic: WeekStats['topic'] = null;
  if (lib.topics.length) {
    const prevA = a - 7 * DAY;
    const inTwoWeeks = rangeTest(prevA, b);
    const topicsKey = JSON.stringify(lib.topics);
    const count = new Map<string, number[]>();
    for (const it of items) {
      const at = it.ingestedAt ?? it.publishedAt;
      if (!inTwoWeeks(at)) continue;
      const slot = Date.parse(at) >= a ? 0 : 1;
      let hit = topicCache.get(it);
      if (hit?.key !== topicsKey) {
        hit = { key: topicsKey, ids: matchTopics(itemHaystack(it), lib.topics).map((m) => m.topicId) };
        topicCache.set(it, hit);
      }
      for (const id of hit.ids) {
        const c: number[] = count.get(id) ?? [0, 0];
        c[slot]++;
        count.set(id, c);
      }
    }
    let bestGrowth = -Infinity;
    for (const [id, [now, before]] of count) {
      if (now < 2) continue;
      const growth = now - before + now / 100; // ties go to the bigger topic
      if (growth > bestGrowth) {
        bestGrowth = growth;
        const t = lib.topics.find((x) => x.id === id)!;
        topic = { id, name: t.name, count: now, before };
      }
    }
  }

  // The best thing read: saved, highlighted, finished and long beats skimmed.
  const marksBy = new Map<string, WeekHighlight[]>();
  for (const h of weekMarks) marksBy.set(h.itemId, [...(marksBy.get(h.itemId) ?? []), h]);
  const candidates = new Map<string, Item>();
  for (const it of [...readItems, ...savedItems]) candidates.set(it.id, it);
  for (const id of [...progressOf.keys(), ...marksBy.keys()]) {
    const it = byId.get(id);
    if (it) candidates.set(id, it);
  }
  const score = (it: Item) =>
    (it.state.saved ? 3 : 0) +
    Math.min(3, (marksBy.get(it.id)?.length ?? 0) * 1.5) +
    (progressOf.get(it.id) ?? 0) * 2 +
    Math.min(2, (input.words[it.id] ?? 0) / 1500) +
    (it.title ? 0.5 : 0) +
    (it.kind === 'article' ? 0.5 : 0);
  const ranked = [...candidates.values()].sort((x, y) => score(y) - score(x) || Date.parse(y.publishedAt) - Date.parse(x.publishedAt));
  const top = ranked[0];
  const best: WeekStats['best'] = top
    ? {
        itemId: top.id,
        title: (top.title || top.text.replace(/\s+/g, ' ')).slice(0, 160) || 'Untitled',
        author: top.author.name || top.author.handle || '',
        source: labels[top.sourceId] ?? '',
        url: top.url,
        image: top.media.find((m) => m.type === 'image')?.url ?? top.media.find((m) => m.thumb)?.thumb ?? null,
        minutes: Math.max(0, Math.round((input.words[top.id] ?? 0) / WORDS_PER_MINUTE)),
        highlight: (() => {
          const h = marksBy.get(top.id)?.[0];
          return h ? { id: h.id, quote: h.quote.slice(0, 280) } : null;
        })(),
      }
    : null;

  return {
    weekId: weekId(start),
    start: start.toISOString(),
    end: end.toISOString(),
    read: readItems.length,
    saved: savedItems.length,
    minutes: Math.round(minutes),
    articles,
    highlights: weekMarks.length,
    arrived: arrivedItems.length,
    setAside,
    noise,
    ruled,
    savedMinutes: Math.round((setAside * SKIM_SECONDS) / 60),
    days,
    people: topPeople,
    sources: topSources,
    topic,
    best,
    notable: ranked.slice(0, 24).map((i) => i.id),
    quiet: readItems.length + savedItems.length + weekMarks.length === 0 && minutes < 1,
  };
}
