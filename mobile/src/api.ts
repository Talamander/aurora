// Talks to the user's own Aurora server over its JSON API and Server-Sent Events.
// Every request carries the device token as a Bearer token. The token is stored in the OS
// keychain / keystore (see secure.ts) and never logged.
import EventSource from 'react-native-sse';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import type { AgentEvent, AgentThread, ItemState, Library } from '../../core/types.ts';
import type { ArticleRecord, Highlight } from '../../core/longform.ts';
import type { WeekStats } from '../../core/week.ts';
import type { Routine, RoutineRun } from '../../core/routines.ts';
import type { RelatedHit, SearchResult } from '../../core/search.ts';
import { setCacheScope, wipeCache } from './cache';
import { getItem, setItem } from './secure';

export interface Connection {
  url: string;
  token: string;
  deviceId: string;
  server: string;
}

const KEY = 'aurora.connection';
let conn: Connection | null = null;
const subs = new Set<() => void>();

export async function loadConnection(): Promise<Connection | null> {
  try {
    const raw = await getItem(KEY);
    conn = raw ? (JSON.parse(raw) as Connection) : null;
  } catch {
    conn = null;
  }
  setCacheScope(conn?.deviceId ?? null);
  subs.forEach((f) => f());
  return conn;
}
export function connection() {
  return conn;
}
export function onConnection(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}
export async function saveConnection(c: Connection | null) {
  conn = c;
  // Unpaired: forget the posts and articles kept for offline reading along with the token.
  if (!c) { wipeCache(); await setItem('aurora.imgProxy', null).catch(() => {}); }
  setCacheScope(c?.deviceId ?? null);
  await setItem(KEY, c ? JSON.stringify(c) : null);
  subs.forEach((f) => f());
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** True when the computer could not be reached at all (no network, or not on the same network). */
export function isOffline(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

/** Only http(s) server addresses, without a trailing slash. */
export function cleanServerUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

interface RawResponse<T> {
  status: number;
  header: (name: string) => string | null;
  data: T | null;
}

async function send<T>(base: string, method: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<RawResponse<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    if (res.status === 304) return { status: 304, header: (n) => res.headers.get(n), data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
    return { status: res.status, header: (n) => res.headers.get(n), data: data as T };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, `Cannot reach ${base}. Is Aurora running with HOST set, and is the phone on the same network?`);
  } finally {
    clearTimeout(timer);
  }
}

async function raw<T>(base: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  return (await send<T>(base, method, path, body, token)).data as T;
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await callRaw<T>(method, path, body)).data as T;
}

/** A GET with extra headers (If-None-Match) that also hands back the status and response headers. */
export async function callRaw<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RawResponse<T>> {
  if (!conn) throw new ApiError(401, 'Not paired');
  try {
    return await send<T>(conn.url, method, path, body, conn.token, headers);
  } catch (e) {
    // Unpaired on the computer: forget the token and go back to pairing.
    if (e instanceof ApiError && e.status === 401) await saveConnection(null);
    throw e;
  }
}

// ---------------------------------------------------------------- pairing

export interface PairLink {
  url: string;
  pair: string;
  name: string;
}

/** Parses aurora://pair?v=1&u=<url>&p=<id.secret>&n=<name> from the QR code. */
export function parsePairLink(text: string): PairLink | null {
  const m = /^aurora:\/\/pair\?(.+)$/.exec(text.trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const [k, v = ''] = part.split('=');
    try { q[k] = decodeURIComponent(v); } catch { return null; }
  }
  const url = cleanServerUrl(q.u ?? '');
  if (!url || !/^[a-f0-9]{12}\.[A-Za-z0-9_-]{20,}$/.test(q.p ?? '')) return null;
  return { url, pair: q.p, name: (q.n ?? 'Aurora').slice(0, 40) };
}

export function deviceName(): string {
  const os = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Web preview';
  return (Device.deviceName || Device.modelName || os).slice(0, 60);
}

export const pairing = {
  claim: (link: PairLink) =>
    raw<{ state: string; check: string; claimKey: string; expiresAt: string }>(link.url, 'POST', '/api/devices/claim', { pair: link.pair, name: deviceName(), platform: Platform.OS }),
  status: (link: PairLink, claimKey: string) =>
    raw<{ state: 'waiting' | 'claimed' | 'approved' | 'denied'; token?: string; deviceId?: string; server?: string }>(link.url, 'POST', '/api/devices/claim/status', { pair: link.pair, claimKey }),
};

// ---------------------------------------------------------------- API

/** One entry of the Read later queue (server/longform/routes.ts). */
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

/** A friend share's conversation (server/social/index.ts threadView). */
export interface FriendThread {
  localId: string;
  direction: 'in' | 'out';
  note: string;
  at: string;
  itemId: string | null;
  conversations: {
    peer: { fp: string; name: string; status: string };
    reaction: string | null;
    myReaction: string | null;
    messages: { id: string; fromMe: boolean; text: string; at: string }[];
  }[];
}

/** The reactions a friend share accepts (server/social/index.ts REACTIONS). */
export const REACTIONS = ['❤️', '👍', '😂', '😮', '🤔', '🔥'];

export interface AlertHit {
  id: string;
  alertId: string;
  itemId: string;
  reason: string;
  at: string;
  seen: boolean;
  alertName: string;
  item: { author: string; avatar?: string; text: string; platform: string; url: string; publishedAt: string; media?: string } | null;
}

/** Your week, as the computer computed it. Read-only on the phone. */
export interface WeekPayload {
  stats: WeekStats;
  story: { title: string; text: string; postIds: string[]; at: string } | null;
  frozenAt: string | null;
  profile: string;
  weeks: { id: string; start: string | null; title: string | null; current: boolean }[];
  aiReady: boolean;
  writing: boolean;
}

/** One routine as the computer describes it (server/routines.ts view). Read-only on the phone. */
export type RoutineView = Routine & {
  when: string;
  nextRunAt: string | null;
  running: boolean;
  queued: boolean;
  monthSpent: number;
  lastRun: RoutineRun | null;
};

export const api = {
  alertHits: () => call<{ unseen: number; quietNow: boolean; hits: AlertHit[] }>('GET', '/api/alerts/hits'),
  alertsSeen: (ids?: string[]) => call<{ ok: true }>('POST', '/api/alerts/seen', { ids }),
  library: () => call<Library>('GET', '/api/library'),
  setState: (ids: string[], patch: Partial<ItemState>) =>
    call<{ ok: true }>('POST', '/api/items/state', { ids, patch }),
  sync: () => call<unknown>('POST', '/api/sync', {}),
  syncSource: (id: string) => call<unknown>('POST', `/api/sources/${encodeURIComponent(id)}/sync`, {}),
  edition: (profile?: string | null) => call<{ ok: boolean; message: string }>('POST', '/api/edition', profile ? { profile } : {}),
  collections: (ids: string[], collections: string[]) => call<{ ok: true }>('POST', '/api/items/state', { ids, patch: { collections } }),
  // Long-form reading
  article: (id: string) => call<ArticleRecord & { canExtract: boolean }>('GET', `/api/articles/${encodeURIComponent(id)}`),
  extract: (id: string, force = false) => call<ArticleRecord>('POST', `/api/articles/${encodeURIComponent(id)}/extract`, { force }),
  reading: (id: string, progress: number, position: number) => call<{ ok: true }>('PUT', `/api/reading/${encodeURIComponent(id)}`, { progress, position }),
  queue: () => call<{ queue: QueueEntry[]; suggestions: QueueEntry[]; collection: string }>('GET', '/api/longform/queue'),
  highlights: (itemId: string) => call<Highlight[]>('GET', `/api/highlights?item=${encodeURIComponent(itemId)}`),
  allHighlights: () => call<Highlight[]>('GET', '/api/highlights'),
  highlight: (h: { itemId: string; block: number; quote: string; note?: string }) => call<Highlight>('POST', '/api/highlights', h),
  // Friends: one share's conversation
  friendThread: (localId: string) => call<FriendThread>('GET', `/api/social/thread/${encodeURIComponent(localId)}`),
  friendReply: (shareId: string, text: string, peer?: string) => call<FriendThread>('POST', '/api/social/reply', { shareId, text, peer }),
  friendReact: (shareId: string, emoji: string, peer?: string) => call<FriendThread>('POST', '/api/social/react', { shareId, emoji, peer }),
  personAbout: (key: string, ids: string[]) => call<{ about: string }>('POST', '/api/person/about', { key, ids }),
  agentStatus: () => call<{ ready: boolean; reason?: string }>('GET', '/api/agent/status'),
  threads: () => call<AgentThread[]>('GET', '/api/agent/threads?kind=chat'),
  newThread: (title?: string) => call<AgentThread>('POST', '/api/agent/threads', { title }),
  thread: (id: string) => call<{ thread: AgentThread; events: AgentEvent[]; running: boolean }>('GET', `/api/agent/threads/${encodeURIComponent(id)}`),
  send: (id: string, text: string, context?: unknown) => call<{ ok: true }>('POST', `/api/agent/threads/${encodeURIComponent(id)}/messages`, { text, context }),
  week: (profile: string, week?: string | null) =>
    call<WeekPayload>('GET', `/api/week?profile=${encodeURIComponent(profile)}${week ? `&week=${encodeURIComponent(week)}` : ''}`),
  // Full-text search and More like this, ranked on the computer (server/search.ts).
  search: (q: string, profile: string, limit = 30) =>
    call<SearchResult>('GET', `/api/search?q=${encodeURIComponent(q)}&limit=${limit}&profile=${encodeURIComponent(profile)}`),
  related: (id: string, profile: string, limit = 6) =>
    call<{ id: string; results: RelatedHit[] }>('GET', `/api/items/${encodeURIComponent(id)}/related?limit=${limit}&profile=${encodeURIComponent(profile)}`),
  // Routines are made, turned on and run on the computer; the phone only reads the list.
  routines: () => call<{ routines: RoutineView[]; aiReady: boolean; aiReason: string | null }>('GET', '/api/routines'),
  me: () => call<{ device: { id: string; name: string; createdAt: string }; server: string }>('GET', '/api/devices/me'),
  unpair: () => call<{ ok: true }>('DELETE', '/api/devices/me'),
};

// ---------------------------------------------------------------- events

export type ServerEvent =
  | { type: 'library'; reason?: string }
  | { type: 'agent'; threadId: string; event: AgentEvent }
  | { type: 'thread'; threadId: string; status: string }
  | { type: 'delta'; threadId: string; text: string }
  | { type: 'ui'; action: Record<string, unknown> };

/** Opens /api/events with the Bearer token. Reconnects on its own; returns a closer. */
export function openEvents(onEvent: (e: ServerEvent) => void): () => void {
  if (!conn) return () => {};
  const es = new EventSource(`${conn.url}/api/events`, {
    headers: { Authorization: `Bearer ${conn.token}` },
    pollingInterval: 4000,
    timeout: 0,
  });
  es.addEventListener('message', (m) => {
    if (!m.data) return;
    try { onEvent(JSON.parse(m.data) as ServerEvent); } catch { /* ignore a malformed line */ }
  });
  return () => { es.removeAllEventListeners(); es.close(); };
}
