// Text and URL normalisation shared by connectors, dedupe and filtering.

import type { ContentType, Item } from './types.ts';

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src|ref_url|cmpid|mkt_tok)$/i;
// Short names like s, t and si are tracking only on these hosts; elsewhere they can be real (?t=2 a forum topic).
const SHORT_TRACKING_HOSTS = new Set(['x.com', 'youtube.com', 'instagram.com', 'threads.net', 'open.spotify.com', 'tiktok.com']);

/** Only http(s) URLs survive. Everything else (javascript:, data:, file:) becomes null. */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Canonical URL used for dedupe: lower-case host, no www, no tracking params, no hash. */
export function canonicalUrl(raw: string): string | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const u = new URL(safe);
  let host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^mobile\./, '').replace(/^m\./, '');
  if (host === 'twitter.com' || host === 'x.com' || host === 'fxtwitter.com' || host === 'vxtwitter.com') {
    const m = u.pathname.match(/\/status(?:es)?\/(\d+)/);
    if (m) return `x.com/status/${m[1]}`;
    host = 'x.com';
  }
  if (host === 'youtu.be') return `youtube.com/watch?v=${u.pathname.slice(1)}`;
  if (host === 'youtube.com' && u.searchParams.get('v')) return `youtube.com/watch?v=${u.searchParams.get('v')}`;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k) && !(SHORT_TRACKING_HOSTS.has(host) && /^(s|t|si)$/i.test(k)))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${host}${path}${qs}`;
}

/** Small, fast, stable string hash (FNV-1a, 32-bit, hex). Not cryptographic. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Convert untrusted HTML to plain text plus extracted links and images.
 * The output is rendered as text by the UI, so no markup can execute.
 */
export function htmlToText(html: string): { text: string; links: string[]; images: string[] } {
  const links: string[] = [];
  const images: string[] = [];
  let s = html.replace(/<(script|style|iframe|object|embed|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Code blocks keep their line breaks and indentation, as a fenced block in the plain text.
  const code: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const body = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/^\n+|\s+$/g, '');
    if (!body.trim()) return ' ';
    code.push(body.replace(/^```/gm, '\u200b```'));
    return `\n\n\u0000${code.length - 1}\u0000\n\n`;
  });
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, href: string) => {
    const u = safeHttpUrl(decodeEntities(href));
    if (u && !links.includes(u)) links.push(u);
    return '';
  });
  s = s.replace(/<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, (tag: string, src: string) => {
    // 1x1 images are newsletter tracking pixels, not content.
    if (/\b(width|height)\s*=\s*["']?[01](px)?["'\s/>]/i.test(tag)) return ' ';
    const u = safeHttpUrl(decodeEntities(src));
    if (u && !images.includes(u)) images.push(u);
    return ' ';
  });
  s = s.replace(/<\/?(p|div|h[1-6]|blockquote|pre|ul|ol|table|figure)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<(br|\/li|\/tr)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  // Inline tags join their neighbours; anything else becomes a space.
  s = s.replace(/<\/?(a|span|em|strong|b|i|u|code|mark|small|sup|sub|abbr|time|cite|q|s)\b[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => '```\n' + code[Number(i)] + '\n```');
  return { text: s, links, images };
}

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const u = safeHttpUrl(m[0].replace(/[.,;:!?]+$/, ''));
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Dedupe key: the canonical URL of the main linked thing if there is one, else a text hash. */
export function dedupeKeyFor(input: { url: string; text: string; links: string[]; kind: string }): string {
  // Articles and link posts share a key with any other post linking the same page.
  const primary = input.kind === 'article' || input.kind === 'video' ? input.url : input.links[0] ?? null;
  const canon = primary ? canonicalUrl(primary) : null;
  // A bare share ("Good read: <link>") is the linked page. Real commentary is its own post,
  // so two people's different takes on one article are not collapsed.
  const commentary = input.text.replace(/https?:\/\/\S+/g, '').trim();
  if (canon && (input.kind === 'article' || input.kind === 'video' || commentary.length <= 80)) return 'u:' + canon;
  const norm = normalizeForMatch(input.text.replace(/https?:\/\/\S+/g, '')).replace(/[^\p{L}\p{N} ]/gu, '');
  if (norm.length >= 24) return 't:' + hash(norm);
  return 'u:' + (canonicalUrl(input.url) ?? input.url);
}

export function contentTypesOf(item: Pick<Item, 'media' | 'links' | 'kind'>): ContentType[] {
  const types = new Set<ContentType>();
  for (const m of item.media) types.add(m.type === 'link' ? 'link' : m.type);
  if (item.links.length) types.add('link');
  if (item.kind === 'article') types.add('article');
  if (item.kind === 'video') types.add('video');
  if (!types.size) types.add('text');
  return [...types];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
