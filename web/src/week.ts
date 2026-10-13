// Client side of "Your week": API calls and a tiny global opener, so the palette, the agent and
// any card can open the story without threading props through the app.

import type { WeekStats } from '../../core/week.ts';

export interface WeekStory {
  title: string;
  text: string;
  postIds: string[];
  at: string;
}

export interface WeekPayload {
  stats: WeekStats;
  story: WeekStory | null;
  frozenAt: string | null;
  profile: string;
  weeks: { id: string; start: string | null; title: string | null; current: boolean }[];
  aiReady: boolean;
  writing: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

export const weekApi = {
  get: (profile: string, week?: string | null) =>
    call<WeekPayload>('GET', `/api/week?profile=${encodeURIComponent(profile)}${week ? `&week=${encodeURIComponent(week)}` : ''}`),
  write: (profile: string, week: string) => call<WeekPayload>('POST', '/api/week/write', { profile, week }),
};

const EVT = 'aurora:week';

/** Opens the story (this week when no id is given). */
export function openWeek(week?: string | null) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { week: week ?? null } }));
}

export function onOpenWeek(fn: (week: string | null) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent).detail?.week ?? null);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

const SEEN = 'sr.week.seen';
export function weekSeen(id: string): boolean {
  try {
    return localStorage.getItem(SEEN) === id;
  } catch {
    return false;
  }
}
export function markWeekSeen(id: string) {
  try {
    localStorage.setItem(SEEN, id);
  } catch {
    /* ignore */
  }
}

/** "Oct 6 to 12" or "Sep 29 to Oct 5". */
export function weekLabel(startIso: string | null | undefined): string {
  if (!startIso) return 'This week';
  const a = new Date(startIso);
  const b = new Date(a);
  b.setDate(b.getDate() + 6);
  const m = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  return a.getMonth() === b.getMonth() ? `${m(a)} ${a.getDate()} to ${b.getDate()}` : `${m(a)} ${a.getDate()} to ${m(b)} ${b.getDate()}`;
}
