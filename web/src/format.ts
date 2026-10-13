import type { Item, Platform, Source } from '../../core/types.ts';

const PLATFORM_NAMES: Record<string, string> = {
  x: 'X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  reddit: 'Reddit',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  telegram: 'Telegram',
  hackernews: 'Hacker News',
  rss: 'Feed',
  web: 'Web',
  import: 'Import',
  demo: 'Demo',
};

export function platformLabel(p: Platform): string {
  return PLATFORM_NAMES[p] ?? p.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "just now", "5m ago", "3h ago", or "on Oct 9" for older times. */
export function agoText(iso: string, now = Date.now()): string {
  const r = relTime(iso, now);
  if (!r) return '';
  if (r === 'now') return 'just now';
  return /^\d+[mh]$/.test(r) ? `${r} ago` : `on ${r}`;
}

// toLocaleString with options builds a new formatter on every call, which shows up when a page
// of posts renders. These are built once, on first use, with the same options.
let dayFmt: Intl.DateTimeFormat | null = null;
let dayYearFmt: Intl.DateTimeFormat | null = null;
let fullFmt: Intl.DateTimeFormat | null = null;

export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (sameYear) return (dayFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(d);
  return (dayYearFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })).format(d);
}

export function fullTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Invalid Date';
  return (fullFmt ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })).format(d);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function authorLine(item: Item): string {
  const h = item.author.handle;
  if (!h) return '';
  if (item.platform === 'x' || item.platform === 'bluesky' || item.platform === 'mastodon') return '@' + h.replace(/^@/, '');
  return h;
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function sourceName(s: Source | undefined): string {
  return s ? s.label : 'Unknown source';
}

/** Splits plain text into paragraphs and linkifies http(s) URLs. Rendered as React text, never HTML. */
/** Splits text into paragraphs; a fenced ``` block stays whole, blank lines included. */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/(^```\n[\s\S]*?\n```$)/m);
  for (const part of parts) {
    if (/^```\n[\s\S]*\n```$/.test(part)) out.push(part);
    else out.push(...part.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean));
  }
  return out;
}

/** The code inside a fenced paragraph, or null for prose. */
export function codeBlock(p: string): string | null {
  const m = p.match(/^```\n([\s\S]*)\n```$/);
  return m ? m[1] : null;
}

/** Text for one-line previews: fences removed. */
export function previewText(text: string): string {
  return text.replace(/^```$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function tokens(text: string): { t: 'text' | 'url'; v: string }[] {
  const out: { t: 'text' | 'url'; v: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (m.index! > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    out.push({ t: 'url', v: url });
    last = m.index! + url.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

export function originalLabel(item: Item): string {
  if (item.isDemo) return 'Open sample link';
  switch (item.platform) {
    case 'x': return 'Open on X';
    case 'bluesky': return 'Open on Bluesky';
    case 'mastodon': return 'Open on Mastodon';
    case 'reddit': return 'Open on Reddit';
    case 'youtube': return 'Watch on YouTube';
    default: return `Open on ${hostOf(item.url)}`;
  }
}
