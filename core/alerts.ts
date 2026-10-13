// Alerts: plain-English watches ("tell me when MKBHD posts a phone review"). The cheap part of
// matching lives here and is pure: who posted, from which source, which words, what media. A
// fuzzy condition ("a phone review") is judged by the AI on the server, only for posts that
// already passed these cheap checks.

import type { Item } from './types.ts';

export interface Alert {
  id: string;
  /** Short title shown in lists and notifications ("MKBHD phone reviews"). */
  name: string;
  /** A fuzzy condition the AI judges, in the user's words. Null when the cheap checks are enough. */
  prompt: string | null;
  /** Only posts from these sources (ids). */
  sources: string[];
  /** Only posts by these people (handle or name, case-insensitive). */
  authors: string[];
  /** Posts mentioning any of these words or phrases. */
  keywords: string[];
  /** Only posts with this kind of media. */
  media: 'image' | 'video' | null;
  /** Only posts that show in this profile. Null means every profile. */
  profile: string | null;
  paused: boolean;
  createdAt: string;
  hits: number;
  lastHitAt: string | null;
}

export interface AlertHit {
  id: string;
  alertId: string;
  itemId: string;
  reason: string;
  at: string;
  seen: boolean;
}

export interface QuietHours {
  from: string; // HH:MM
  to: string; // HH:MM
}

const norm = (s: string) => s.toLowerCase().replace(/^@/, '').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Clean a user- or AI-supplied alert; throws when it would match nothing in particular. */
export function cleanAlert(input: Partial<Alert> & { name?: string }, prev?: Alert): Alert {
  const list = (v: unknown, max = 20) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80)).filter(Boolean))].slice(0, max) : [];
  const pick = <K extends keyof Alert>(k: K, fallback: Alert[K]): Alert[K] => (input[k] !== undefined ? (input[k] as Alert[K]) : prev ? prev[k] : fallback);
  const prompt = pick('prompt', null);
  const a: Alert = {
    id: prev?.id ?? String(input.id ?? ''),
    name: String(pick('name', '') ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60),
    prompt: prompt ? String(prompt).trim().slice(0, 300) || null : null,
    sources: input.sources !== undefined ? list(input.sources) : prev?.sources ?? [],
    authors: input.authors !== undefined ? list(input.authors) : prev?.authors ?? [],
    keywords: input.keywords !== undefined ? list(input.keywords, 30) : prev?.keywords ?? [],
    media: (() => {
      const m = pick('media', null);
      return m === 'image' || m === 'video' ? m : null;
    })(),
    profile: (() => {
      const p = pick('profile', null);
      return p && p !== 'all' ? String(p).slice(0, 80) : null;
    })(),
    paused: Boolean(pick('paused', false)),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    hits: prev?.hits ?? 0,
    lastHitAt: prev?.lastHitAt ?? null,
  };
  if (!a.prompt && !a.sources.length && !a.authors.length && !a.keywords.length && !a.media) {
    throw new Error('An alert needs something to watch for: a person, a source, some words, a kind of media or a description.');
  }
  if (!a.name) a.name = defaultName(a);
  return a;
}

export function defaultName(a: Pick<Alert, 'prompt' | 'authors' | 'keywords' | 'media'>): string {
  if (a.prompt) return a.prompt.slice(0, 60);
  const bits = [a.authors.length ? a.authors.slice(0, 2).join(', ') : '', a.keywords.length ? `“${a.keywords.slice(0, 2).join('”, “')}”` : '', a.media ? `${a.media}s` : ''].filter(Boolean);
  return (bits.join(' · ') || 'New alert').slice(0, 60);
}

function mentions(item: Item, word: string): boolean {
  const hay = `${item.title ?? ''} ${item.text} ${item.quoted?.text ?? ''}`;
  const w = word.trim();
  if (!w) return false;
  // Whole words for plain words, so "rust" does not fire on "trust"; phrases and symbols match as typed.
  const re = /^[\p{L}\p{N}]/u.test(w) && /[\p{L}\p{N}]$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'iu') : new RegExp(escapeRe(w), 'i');
  return re.test(hay);
}

function byAuthor(item: Item, who: string): boolean {
  const w = norm(who);
  if (!w) return false;
  const handle = norm(item.author.handle ?? '');
  const name = item.author.name.toLowerCase();
  return handle === w || name === w || (w.length >= 4 && (name.includes(w) || handle.split('.')[0] === w));
}

/**
 * The cheap checks. Returns a short reason when the post passes all of them, or null. `inProfile`
 * says whether the post shows in the alert's profile (the caller owns profile lenses).
 */
export function cheapMatch(alert: Alert, item: Item, inProfile: boolean, sourceLabel?: string): string | null {
  if (alert.profile && !inProfile) return null;
  const why: string[] = [];
  if (alert.sources.length) {
    if (!alert.sources.includes(item.sourceId)) return null;
    if (sourceLabel) why.push(`from ${sourceLabel}`);
  }
  if (alert.authors.length) {
    const who = alert.authors.find((a) => byAuthor(item, a));
    if (!who) return null;
    why.push(`by ${item.author.name}`);
  }
  if (alert.keywords.length) {
    const w = alert.keywords.find((k) => mentions(item, k));
    if (!w) return null;
    why.push(`mentions “${w}”`);
  }
  if (alert.media) {
    const n = item.media.filter((m) => m.type === alert.media).length;
    if (!n) return null;
    why.push(n === 1 ? `has ${alert.media === 'image' ? 'a photo' : 'a video'}` : `has ${n} ${alert.media === 'image' ? 'photos' : 'videos'}`);
  }
  return why.join(', ') || 'new post';
}

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

/** Whether `at` falls in quiet hours. Ranges may cross midnight (22:00 to 07:00). */
export function inQuietHours(q: QuietHours | null | undefined, at = new Date()): boolean {
  if (!q) return false;
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function cleanQuiet(v: unknown): QuietHours | null {
  if (!v || typeof v !== 'object') return null;
  const { from, to } = v as Record<string, unknown>;
  if (typeof from !== 'string' || typeof to !== 'string' || minutes(from) === null || minutes(to) === null) return null;
  const pad = (s: string) => s.trim().padStart(5, '0');
  return { from: pad(from), to: pad(to) };
}
