// Routines: jobs the user describes in plain English ("every weekday at 7:30, make a Work brief"),
// run by the agent on a schedule. This file is pure: the shapes, schedule parsing, next-run math
// and the list of tools a routine may use. The server runs them (server/routines.ts).

export type Schedule =
  /** At a time of day on some days of the week (0 = Sunday). An empty list means every day. */
  | { kind: 'at'; time: string; days: number[] }
  /** Every N hours (1 to 24), counted from the last run. */
  | { kind: 'every'; hours: number }
  /** Shortly after a sync brings new posts, at most once every 30 minutes. */
  | { kind: 'sync' };

export interface Routine {
  id: string;
  name: string;
  /** What to do, in the user's words. */
  prompt: string;
  schedule: Schedule;
  /** Profile id the routine works in, or null for All. */
  profile: string | null;
  /** Runs on schedule. New routines start off until the user has seen a plan and turned them on. */
  enabled: boolean;
  /** Why the routine stopped by itself (a spending cap), or null. */
  paused: string | null;
  /** Dollars one run may spend before it is stopped. */
  runCapUsd: number;
  /** Dollars this routine may spend in a calendar month. */
  monthCapUsd: number;
  /** The dry-run plan the user saw, and the prompt it was made for. */
  plan: string | null;
  planFor: string | null;
  plannedAt: string | null;
  /** The schedule slot the routine last ran (or skipped) for. */
  lastSlotAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  origin: 'schedule' | 'user';
  status: 'running' | 'ok' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  costUsd: number | null;
  /** The agent's closing summary (plain text, may cite [post:id]). */
  summary: string;
  error: string | null;
  threadId: string | null;
  /** Steps the agent took, as short labels. */
  steps: string[];
}

export const DEFAULT_RUN_CAP = 0.5;
export const DEFAULT_MONTH_CAP = 5;
export const MAX_ROUTINES = 40;
export const SYNC_GAP_MS = 30 * 60_000;
/** A time-of-day slot missed by more than this (the computer was off) is skipped, not run late. */
export const LATE_GRACE_MS = 6 * 3600_000;

/**
 * The only tools a routine run gets. Routines run with nobody watching, so they may read the
 * library and organise it (pages, views, topics, saved, Read later), but never add, remove, sync
 * or repair sources, start connector builds, sign in anywhere, change the theme, move the user's
 * screen, or make more routines. An allowlist, so a new tool is off for routines until added here.
 */
export const ROUTINE_TOOLS = [
  'library_overview',
  'search_posts',
  'related_posts',
  'get_post',
  'save_page',
  'save_view',
  'save_topic',
  'set_posts_state',
  'read_article',
  'search_highlights',
] as const;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, twelve: 12 };

const pad = (n: number) => String(n).padStart(2, '0');

export function cleanTime(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

/** Validates a schedule from a request body. Null when it is not a schedule. */
export function cleanSchedule(v: unknown): Schedule | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (s.kind === 'sync') return { kind: 'sync' };
  if (s.kind === 'every') {
    const h = Math.round(Number(s.hours));
    return h >= 1 && h <= 24 ? { kind: 'every', hours: h } : null;
  }
  if (s.kind === 'at') {
    const time = cleanTime(s.time);
    if (!time) return null;
    const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    return { kind: 'at', time, days: days.length === 7 ? [] : days };
  }
  return null;
}

/**
 * Reads a schedule out of a sentence: "every weekday at 7:30", "Sunday night", "every 2 hours",
 * "after each sync", "mon, wed and fri at 8:15am", "daily at 7pm". Null when it finds none.
 */
export function parseSchedule(text: string): Schedule | null {
  const t = ` ${text.toLowerCase().replace(/[.,;!?]/g, ' ').replace(/\s+/g, ' ')} `;
  if (/\bafter (?:each|every|a|the) sync|\bafter syncing\b|\bwhen (?:new posts|posts) (?:arrive|come in)\b/.test(t)) return { kind: 'sync' };
  const every = /\bevery (\d{1,2}|one|two|three|four|five|six|eight|twelve) ?(?:hours?|hrs?|h)\b/.exec(t);
  if (every) {
    const n = NUM_WORDS[every[1]] ?? Number(every[1]);
    if (n >= 1 && n <= 24) return { kind: 'every', hours: n };
  }
  if (/\b(?:hourly|every hour|each hour)\b/.test(t)) return { kind: 'every', hours: 1 };

  let days: number[] | null = null;
  if (/\bweekdays?\b|\bwork ?days?\b/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(t)) days = [0, 6];
  else {
    const found = new Set<number>();
    for (const m of t.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?s?\b/g)) {
      const d = DAY_NAMES.indexOf(m[1].slice(0, 3));
      if (d >= 0) found.add(d);
    }
    if (found.size) days = [...found].sort();
  }
  const daily = /\b(?:daily|every ?day|each day|every (?:morning|evening|night|afternoon)|nightly|each (?:morning|evening|night))\b/.test(t);

  let time: string | null = null;
  const ampm = /\b(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m|p\.m)\b/.exec(t);
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(t);
  const atHour = /\bat (\d{1,2})\b(?!:)/.exec(t);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].startsWith('p')) h += 12;
    time = cleanTime(`${h}:${ampm[2] ?? '00'}`);
  } else if (clock) time = cleanTime(`${clock[1]}:${clock[2]}`);
  else if (atHour) time = cleanTime(`${atHour[1]}:00`);
  else if (/\bnoon\b|\blunch ?time\b/.test(t)) time = '12:00';
  else if (/\bmornings?\b/.test(t)) time = '07:00';
  else if (/\bafternoons?\b/.test(t)) time = '15:00';
  else if (/\bevenings?\b/.test(t)) time = '18:00';
  else if (/\bnights?\b|\bnightly\b|\btonight\b/.test(t)) time = '20:00';

  if (!days && !daily && !time) return null;
  return { kind: 'at', time: time ?? '08:00', days: days ?? [] };
}

/** "Every weekday at 7:30, make a Work brief" becomes a name, a schedule and the task. */
export function splitRoutine(text: string): { name: string; schedule: Schedule | null; prompt: string } {
  const prompt = text.replace(/\s+/g, ' ').trim().slice(0, 1500);
  const schedule = parseSchedule(prompt);
  // The name is the task without its leading "every weekday at 7:30," part, when there is one.
  const comma = prompt.indexOf(',');
  let rest = prompt;
  if (comma > 0 && comma < 60 && parseSchedule(prompt.slice(0, comma))) rest = prompt.slice(comma + 1).trim();
  rest = rest.replace(/^(?:please |can you |could you )/i, '');
  const name = (rest.charAt(0).toUpperCase() + rest.slice(1)).replace(/[.!?]+$/, '');
  return { name: name.length > 60 ? `${name.slice(0, 57).replace(/\s+\S*$/, '')}…` : name || 'Routine', schedule, prompt };
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'sync') return 'After each sync';
  if (s.kind === 'every') return s.hours === 1 ? 'Every hour' : `Every ${s.hours} hours`;
  const at = `at ${s.time}`;
  const d = s.days;
  if (!d.length) return `Every day ${at}`;
  if (d.join() === '1,2,3,4,5') return `Weekdays ${at}`;
  if (d.join() === '0,6') return `Weekends ${at}`;
  if (d.length === 1) return `${DAY_LONG[d[0]]} ${at}`;
  return `${d.map((x) => DAY_NAMES[x].charAt(0).toUpperCase() + DAY_NAMES[x].slice(1)).join(', ')} ${at}`;
}

/** The first time-of-day slot strictly after `after`, in local time. */
function nextAt(s: { time: string; days: number[] }, after: Date): Date {
  const [h, m] = s.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const c = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, m, 0, 0);
    if (c > after && (!s.days.length || s.days.includes(c.getDay()))) return c;
  }
  return new Date(after.getTime() + 7 * 86_400_000);
}

/**
 * When the routine should next run, counting from the slot it last ran for (or from when it was
 * turned on). Null for routines that wait for a sync.
 */
export function nextRun(s: Schedule, since: Date): Date | null {
  if (s.kind === 'sync') return null;
  if (s.kind === 'every') return new Date(since.getTime() + s.hours * 3600_000);
  return nextAt(s, since);
}

/**
 * What the scheduler does with a routine right now: run it, skip a slot that was missed long ago
 * (the computer was asleep), or wait. `since` is the last slot, or when the routine was turned on.
 */
export function dueAction(s: Schedule, since: Date, now: Date): 'run' | 'skip' | 'wait' {
  const next = nextRun(s, since);
  if (!next || next > now) return 'wait';
  if (s.kind === 'at' && now.getTime() - next.getTime() > LATE_GRACE_MS) return 'skip';
  return 'run';
}

/** The next slot to show in the UI. */
export function upcoming(r: Pick<Routine, 'schedule' | 'enabled' | 'paused' | 'lastSlotAt' | 'updatedAt'>, now = new Date()): string | null {
  if (!r.enabled || r.paused || r.schedule.kind === 'sync') return null;
  const since = new Date(r.lastSlotAt ?? r.updatedAt);
  const next = nextRun(r.schedule, since);
  if (!next) return null;
  if (next <= now) return dueAction(r.schedule, since, now) === 'skip' ? nextRun(r.schedule, now)!.toISOString() : now.toISOString();
  return next.toISOString();
}

export function parseMoney(v: unknown, fallback: number, max = 100): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, Math.round(n * 100) / 100);
}
