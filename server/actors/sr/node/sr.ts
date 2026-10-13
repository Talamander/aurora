// Aurora actor helper library (Node). Actors import it as `import * as sr from 'sr'`.
// All network goes through the host egress proxy: the runner sets HTTP(S)_PROXY and
// NODE_USE_ENV_PROXY=1 so the global fetch uses it.

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
};

function load(name: string): Record<string, any> {
  try {
    const v = JSON.parse(process.env[name] || 'null');
    return v ?? {};
  } catch {
    return {};
  }
}

export const input: Record<string, any> = load('SR_INPUT');
export const state: Record<string, any> = load('SR_STATE');

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export interface RawPostInput {
  id: string | number;
  url: string;
  [key: string]: unknown;
}

/** Emit one RawPost. Needs at least an id and an http(s) url. */
export function emit(item: RawPostInput): void {
  if (!item || typeof item !== 'object') throw new TypeError('emit() takes an object');
  if (item.id == null || String(item.id).trim() === '') throw new Error("emit(): item needs an 'id'");
  if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) throw new Error("emit(): item needs an http(s) 'url'");
  write({ type: 'item', item: { ...item, id: String(item.id) } });
}

/** Persist state for the next run (arrives as sr.state). Last call wins. */
export function saveState(obj: unknown): void {
  write({ type: 'state', state: obj });
}
export const save_state = saveState;

export function log(msg: unknown): void {
  write({ type: 'log', msg: typeof msg === 'string' ? msg : JSON.stringify(msg) });
}

export interface SrResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  text: string;
  json<T = any>(): T;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string | Record<string, unknown> | unknown[];
  timeout?: number; // seconds
}

/** HTTP request through the egress proxy. Never throws on HTTP status; check .status. */
export async function fetch(url: string, opts: FetchOptions = {}): Promise<SrResponse> {
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  let body: string | undefined;
  if (opts.body != null) {
    if (typeof opts.body === 'string') body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }
  }
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: (opts.method ?? 'GET').toUpperCase(),
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout((opts.timeout ?? 30) * 1000),
    });
  } catch (e) {
    const cause = (e as { cause?: { message?: string; code?: string } }).cause;
    throw new Error(`${url}: ${cause?.message ?? cause?.code ?? (e as Error).message} (blocked hosts fail here: is it in the manifest's hosts?)`);
  }
  const text = await res.text();
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (outHeaders[k] = v));
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url,
    headers: outHeaders,
    text,
    json() {
      return JSON.parse(text.replace(/^\)\]\}',?\s*/, ''));
    },
  };
}

export interface BrowserResult {
  url: string;
  status: number;
  title: string;
  html: string;
  text: string;
  links: { href: string; text: string }[];
  json: { url: string; status: number; contentType: string; body: string; truncated?: boolean }[];
  blocked: string[];
}

/** Render url in the host's Chromium. capture: regex of response URLs to keep (default: JSON XHR/fetch). */
export async function browser(url: string, opts: { waitMs?: number; scroll?: number; capture?: string } = {}): Promise<BrowserResult> {
  const r = await fetch('http://sr.internal/browser', {
    method: 'POST',
    body: { url, wait_ms: opts.waitMs ?? 1500, scroll: opts.scroll ?? 0, ...(opts.capture ? { capture: opts.capture } : {}) },
    timeout: 90,
  });
  let data: any;
  try {
    data = r.json();
  } catch {
    throw new Error(`browser(${url}): bad response ${r.status}`);
  }
  if (r.status !== 200) throw new Error(`browser(${url}): ${data?.error ?? r.status}`);
  return data as BrowserResult;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text from an HTML fragment (scripts and styles dropped). */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|blockquote|pre|ul|ol|li|table|tr|figure|section|article)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export const html_to_text = htmlToText;
