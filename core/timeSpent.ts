// Time well spent: how long you actively read in each profile, per local day. Only daily totals
// are kept (seconds per profile per day, for the last few weeks); nothing records which posts were
// on screen or when. Pure functions here; the server stores the log and the web app measures.

/** Day key (local calendar day, YYYY-MM-DD) to profile id to seconds. */
export type TimeLog = Record<string, Record<string, number>>;

/** Days of history kept. Your week needs 7; the profile sheet shows 7; the rest is slack. */
export const KEEP_DAYS = 35;
/** No single report may add more than this, so a bad clock or a stuck tab cannot inflate a day. */
export const MAX_TICK_SECONDS = 120;
/** Without a key, click, scroll or touch for this long, the reader counts as away. */
export const IDLE_MS = 60_000;
/** A soft daily limit is between 5 minutes and 12 hours. */
export const MIN_LIMIT = 5;
export const MAX_LIMIT = 720;
/** Seconds in a day: the most any profile can have on one day. */
const DAY_SECONDS = 86_400;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isDayKey(v: unknown): v is string {
  return typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`));
}

/** The day keys ending at `end`, oldest first. */
export function daysEnding(end: string, n: number): string[] {
  const [y, m, d] = end.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(y, m - 1, d - i)));
  return out;
}

/** A cleaned soft limit in minutes, or null for none. */
export function cleanLimit(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
}

/**
 * Adds seconds to one profile's day and drops days older than KEEP_DAYS before `today`. Returns a
 * new log; the input is not changed. Bad input (unknown day shape, negative or huge seconds) adds
 * nothing.
 */
export function addTime(log: TimeLog, day: string, profile: string, seconds: number, today = dayKey()): TimeLog {
  const keep = new Set(daysEnding(today, KEEP_DAYS));
  const next: TimeLog = {};
  for (const [d, row] of Object.entries(log ?? {})) if (keep.has(d) && row && typeof row === 'object') next[d] = { ...row };
  const s = Math.round(Number(seconds));
  if (!keep.has(day) || !profile || !Number.isFinite(s) || s <= 0) return next;
  const row = (next[day] ??= {});
  row[profile] = Math.min(DAY_SECONDS, (row[profile] ?? 0) + Math.min(MAX_TICK_SECONDS, s));
  return next;
}

/**
 * Active seconds between the last report and now: counted only while the page is visible and the
 * last interaction was under IDLE_MS ago. Once idle, time stops at the moment the reader went quiet.
 */
export function activeSeconds(lastTick: number, now: number, lastInput: number, visible: boolean, idleMs = IDLE_MS): number {
  if (!visible || now <= lastTick) return 0;
  const until = Math.min(now, lastInput + idleMs);
  return Math.max(0, (until - lastTick) / 1000);
}

export function secondsOn(log: TimeLog, day: string, profile: string): number {
  return log?.[day]?.[profile] ?? 0;
}

export function dayTotal(log: TimeLog, day: string): number {
  return Object.values(log?.[day] ?? {}).reduce((a, b) => a + b, 0);
}

/** Per-profile seconds over the last `n` days ending at `end`, busiest first. */
export function totalsOver(log: TimeLog, end: string, n: number): { profile: string; seconds: number }[] {
  const sum: Record<string, number> = {};
  for (const d of daysEnding(end, n)) for (const [p, s] of Object.entries(log?.[d] ?? {})) sum[p] = (sum[p] ?? 0) + s;
  return Object.entries(sum)
    .filter(([, s]) => s >= 30)
    .map(([profile, seconds]) => ({ profile, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** "under a minute", "1 minute", "34 minutes", "1 h 20 min". */
export function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Short form for rings and bars: "34m", "1h20". */
export function shortMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const r = m % 60;
  return `${Math.floor(m / 60)}h${r ? String(r).padStart(2, '0') : ''}`;
}

/**
 * Whether today's soft limit should show its card. `snoozeTo` is the seconds mark "Five more
 * minutes" pushed it to; `dismissed` means "Keep going" (or the snoozed card already showed again)
 * so it stays quiet for the rest of the day.
 */
export function limitDue(limitMinutes: number | null | undefined, used: number, nudge: { snoozeTo?: number; dismissed?: boolean } = {}): boolean {
  if (!limitMinutes || nudge.dismissed) return false;
  return used >= Math.max(limitMinutes * 60, nudge.snoozeTo ?? 0);
}

/** The one-line summary for Your week: "Work 3 h 10 min, Gaming 52 minutes, All 20 minutes". */
export function weekLine(log: TimeLog, end: string, nameOf: (profile: string) => string): string | null {
  const rows = totalsOver(log, end, 7).slice(0, 4);
  if (!rows.length) return null;
  return rows.map((r) => `${nameOf(r.profile)} ${formatMinutes(r.seconds)}`).join(', ');
}
