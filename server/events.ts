// Server-Sent Events hub. The UI keeps one stream open and hears about library changes,
// agent progress and UI actions the agent asked for.

import type { IncomingMessage, ServerResponse } from 'node:http';

export type ServerEvent =
  | { type: 'library'; reason?: string }
  | { type: 'agent'; threadId: string; event: { id: number; type: string; data: unknown; at: string } }
  | { type: 'thread'; threadId: string; status: string; kind?: string; title?: string | null; parentId?: string | null }
  | { type: 'delta'; threadId: string; text: string }
  | { type: 'ui'; action: Record<string, unknown> };

const clients = new Set<ServerResponse>();
const listeners = new Set<(evt: ServerEvent) => void>();

/** In-process listeners (the classifier wakes up on new posts and new rules). */
export function onBroadcast(fn: (evt: ServerEvent) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(evt: ServerEvent) {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      /* a listener must not break the stream */
    }
  }
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}

let libraryTimer: NodeJS.Timeout | null = null;
/** Coalesce bursts of writes (a sync adding 300 posts) into one refresh. */
export function libraryChanged(reason?: string) {
  if (libraryTimer) return;
  libraryTimer = setTimeout(() => {
    libraryTimer = null;
    broadcast({ type: 'library', reason });
  }, 400);
}

export function openStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}
