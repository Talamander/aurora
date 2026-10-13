// A small client for the local Aurora HTTP API. Like the app itself, it talks to loopback only
// unless the user explicitly allows a remote host.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Library } from '../core/types.ts';
import type { ArticleRecord } from '../core/longform.ts';

export function resolveBase(raw: string | undefined, allowRemote: boolean): URL {
  const url = new URL(raw || 'http://127.0.0.1:4317');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Aurora URL must be http(s): ${url.href}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!loopback && !allowRemote) throw new Error(`Refusing to talk to ${url.host}: Aurora is local-only. Pass --allow-remote if you really mean it.`);
  return url;
}

/**
 * When the owner lock is on, the server accepts local.key from the data folder in place of a
 * browser session, and only from this computer. Reading the file is the proof of being the owner.
 */
function localKey(base: URL): Record<string, string> {
  const host = base.hostname.replace(/^\[|\]$/g, '');
  if (!(host === 'localhost' || host === '::1' || /^127\./.test(host))) return {};
  const key = process.env.AURORA_KEY;
  if (key) return { 'x-aurora-key': key };
  try {
    const dir = process.env.SOCIAL_READER_DATA ?? join(fileURLToPath(new URL('..', import.meta.url)), 'data');
    return { 'x-aurora-key': readFileSync(join(dir, 'local.key'), 'utf8').trim() };
  } catch {
    return {};
  }
}

export type StreamEvent = { type: string; [k: string]: any };

export function createClient(base: URL) {
  let etag: string | null = null;
  let cached: Library | null = null;
  const auth = localKey(base);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, base), {
      method,
      // The server refuses writes that are not exactly JSON, which also blocks cross-site forms.
      headers: body === undefined ? { ...auth } : { ...auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* not JSON */
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  }

  return {
    base,
    /** The library, revalidated with the server's ETag so an unchanged library costs nothing. */
    async library(): Promise<Library> {
      const res = await fetch(new URL('/api/library', base), { headers: etag && cached ? { ...auth, 'if-none-match': etag } : auth });
      if (res.status === 304 && cached) return cached;
      if (!res.ok) throw new Error(`Library: ${res.status} ${res.statusText}`);
      cached = (await res.json()) as Library;
      etag = res.headers.get('etag');
      return cached;
    },
    setState: (ids: string[], patch: Record<string, unknown>) => call<{ items: unknown[] }>('POST', '/api/items/state', { ids, patch }),
    article: (id: string) => call<ArticleRecord & { canExtract: boolean }>('GET', `/api/articles/${encodeURIComponent(id)}`),
    extract: (id: string) => call<ArticleRecord>('POST', `/api/articles/${encodeURIComponent(id)}/extract`, {}),
    alertHits: () => call<import('./status.ts').AlertFeed>('GET', '/api/alerts/hits'),
    agentStatus: () => call<{ ready: boolean; reason?: string | null }>('GET', '/api/agent/status'),
    newThread: (title: string) => call<{ id: string }>('POST', '/api/agent/threads', { title }),
    ask: (threadId: string, text: string, context: unknown) => call<{ ok: boolean }>('POST', `/api/agent/threads/${encodeURIComponent(threadId)}/messages`, { text, context }),
    /** Opens the server's event stream and calls `on` for each event until `signal` aborts. */
    async stream(on: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
      const res = await fetch(new URL('/api/events', base), { signal, headers: { ...auth, accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`Events: ${res.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            on(JSON.parse(data));
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    },
  };
}
export type Client = ReturnType<typeof createClient>;
