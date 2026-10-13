// Small helpers shared by connectors and importers. Pure functions only.

import type { Media, Platform } from '../../core/types.ts';
import { safeHttpUrl } from '../../core/normalize.ts';

export const MAX_TEXT_CHARS = 20_000;

export function truncateText(s: string, max = MAX_TEXT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** Returns a valid ISO string or null. Accepts Date, epoch ms/seconds numbers and parseable strings. */
export function toIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  let d: Date;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = new Date(value < 1e11 ? value * 1000 : value);
  else if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{9,13}$/.test(s)) {
      const n = Number(s);
      d = new Date(n < 1e11 ? n * 1000 : n);
    } else {
      // "2024-01-02 03:04:05 +08:00" / "2024-01-02 03:04:05 +0800" (common export formats)
      const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i);
      if (m) {
        let tz = m[3] ?? '';
        if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
        d = new Date(`${m[1]}T${m[2]}${tz}`);
      } else {
        d = new Date(s);
      }
    }
  } else return null;
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  // Reject absurd dates (before 1990 or more than a day in the future).
  if (t < 631152000000 || t > Date.now() + 86_400_000) return null;
  return d.toISOString();
}

/** Approximate creation time from an X/Twitter snowflake id (ids after Nov 2010). */
export function snowflakeToIso(id: unknown): string | null {
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const s = String(id);
  if (!/^\d{15,20}$/.test(s)) return null;
  try {
    const ms = Number((BigInt(s) >> 22n) + 1288834974657n);
    return toIso(ms);
  } catch {
    return null;
  }
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return undefined;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asArray<T = unknown>(v: unknown): T[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

export function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

export function pushMedia(list: Media[], m: Media | null | undefined): void {
  if (!m) return;
  const url = safeHttpUrl(m.url);
  if (!url) return;
  if (list.some((x) => x.url === url)) return;
  const out: Media = { type: m.type, url };
  if (m.alt) out.alt = m.alt;
  const thumb = safeHttpUrl(m.thumb);
  if (thumb) out.thumb = thumb;
  list.push(out);
}

const MASTODON_HOSTS = new Set([
  'mastodon.social', 'mastodon.online', 'mstdn.social', 'mas.to', 'fosstodon.org', 'hachyderm.io',
  'infosec.exchange', 'mastodon.world', 'techhub.social', 'universeodon.com', 'mastodon.art',
  'sigmoid.social', 'ioc.exchange', 'social.vivaldi.net', 'mstdn.jp', 'chaos.social', 'toot.community',
  'mastodon.xyz', 'masto.ai', 'troet.cafe', 'det.social', 'aus.social', 'mathstodon.xyz', 'front-end.social',
]);

/** Best-effort platform guess from a URL host/path. */
export function guessPlatform(rawUrl: string): Platform {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'rss';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'bsky.app' || host.endsWith('.bsky.app')) return 'bluesky';
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'reddit';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') return 'x';
  if (MASTODON_HOSTS.has(host)) return 'mastodon';
  if (/^\/@[\w.-]+(\.rss)?\/?$/.test(u.pathname) || /^\/users\/[\w.-]+(\.rss|\.atom)$/.test(u.pathname)) return 'mastodon';
  return 'rss';
}

/** Collects at most `max` error messages, then counts the rest. */
export class ErrorList {
  messages: string[] = [];
  dropped = 0;
  max: number;
  constructor(max = 50) {
    this.max = max;
  }
  add(msg: string): void {
    if (this.messages.length < this.max) this.messages.push(msg.slice(0, 300));
    else this.dropped++;
  }
  list(): string[] {
    return this.dropped ? [...this.messages, `…and ${this.dropped} more errors`] : [...this.messages];
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
