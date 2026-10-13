// Client side of longform reading: API calls, a tiny global opener (any component can open the
// reader, the read-later queue or highlights), and a shared highlights cache for citation chips.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ArticleRecord, Highlight, HighlightColor } from '../../core/longform.ts';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // The server only accepts JSON bodies on writes, DELETE included.
    headers: method !== 'GET' ? { 'content-type': 'application/json' } : undefined,
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface QueueEntry {
  id: string;
  title: string;
  author: string;
  source: string;
  url: string;
  words: number;
  minutes: number;
  exact: boolean;
  status: string;
  progress: number;
  publishedAt: string;
  addedAt: string;
  read: boolean;
  saved: boolean;
  inQueue: boolean;
  image: string | null;
}

export const lf = {
  article: (id: string) => call<ArticleRecord & { canExtract: boolean }>('GET', `/api/articles/${encodeURIComponent(id)}`),
  extract: (id: string, force = false) => call<ArticleRecord>('POST', `/api/articles/${encodeURIComponent(id)}/extract`, { force }),
  ai: (id: string, mode: 'summary' | 'eli5' | 'ask', question?: string) => call<{ text: string }>('POST', `/api/articles/${encodeURIComponent(id)}/ai`, { mode, question }),
  reading: (id: string, progress: number, position: number) => call('PUT', `/api/reading/${encodeURIComponent(id)}`, { progress, position }),
  highlights: (q?: { item?: string; q?: string }) => call<Highlight[]>('GET', `/api/highlights?${new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v) as [string, string][]).toString()}`),
  addHighlight: (h: { itemId: string; block: number; quote: string; note?: string; color?: HighlightColor }) => call<Highlight>('POST', '/api/highlights', h),
  updateHighlight: (id: string, patch: { note?: string; color?: HighlightColor }) => call<Highlight>('PATCH', `/api/highlights/${id}`, patch),
  deleteHighlight: (id: string) => call('DELETE', `/api/highlights/${id}`),
  queue: () => call<{ queue: QueueEntry[]; suggestions: QueueEntry[]; collection: string }>('GET', '/api/longform/queue'),
  subscribe: (url: string) => call<{ source: { id: string; label: string } | null; feed: string; result: { added?: number } }>('POST', '/api/longform/subscribe', { url }),
  importFile: (fileName: string, text: string) => call<{ format: string; added: number; updated: number; queued: number; archived: number; errors: string[] }>('POST', '/api/longform/import', { fileName, text }),
  epubUrl: (q: { ids?: string[]; collection?: string; page?: string }) =>
    `/api/longform/epub?${q.ids ? `ids=${encodeURIComponent(q.ids.join(','))}` : q.collection ? `collection=${encodeURIComponent(q.collection)}` : `page=${encodeURIComponent(q.page ?? '')}`}`,
};

export const READ_LATER = 'Read later';

/** Downloads a file from a local API URL (EPUB export), surfacing server errors as text. */
export async function download(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'aurora.epub';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---------------------------------------------------------------- opener

export type LongformView = { kind: 'reader'; itemId: string; block?: number } | { kind: 'queue' } | { kind: 'highlights' } | null;
let view: LongformView = null;
const subs = new Set<() => void>();
const setView = (v: LongformView) => {
  view = v;
  for (const fn of subs) fn();
};
export const openReader = (itemId: string, block?: number) => setView({ kind: 'reader', itemId, block });
export const openReadLater = () => setView({ kind: 'queue' });
export const openHighlights = () => setView({ kind: 'highlights' });
export const closeLongform = () => setView(null);
export function useLongformView(): LongformView {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => view,
  );
}

// ---------------------------------------------------------------- highlights cache

let hlCache: Map<string, Highlight> | null = null;
let hlLoading: Promise<void> | null = null;
const hlSubs = new Set<() => void>();
export function refreshHighlights() {
  hlLoading = lf
    .highlights()
    .then((list) => {
      hlCache = new Map(list.map((h) => [h.id, h]));
      for (const fn of hlSubs) fn();
    })
    .catch(() => {})
    .finally(() => (hlLoading = null));
  return hlLoading;
}
/** One highlight by id, for citation chips. Loads the list once and refreshes on demand. */
export function useHighlight(id: string): Highlight | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    hlSubs.add(fn);
    if (!hlCache && !hlLoading) void refreshHighlights();
    return () => void hlSubs.delete(fn);
  }, []);
  if (!hlCache) return undefined;
  return hlCache.get(id) ?? null;
}

export const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim());
