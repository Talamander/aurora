// Profile hours: when a profile's schedule covers a moment, and which profile should be on.
//
// A schedule is a set of start days plus a from/to time in the computer's local time. A window
// belongs to the day it starts on, so "Fri 22:00 to 02:00" runs from Friday night into Saturday
// morning and does not start again on Saturday night unless Saturday is ticked too. Windows are
// built from local calendar dates (never by adding 24 hours), so they stay right across daylight
// saving changes: a 09:00 to 17:00 window is 09:00 to 17:00 on the clock even on a 23-hour day.

import type { Profile } from './types.ts';

export type ProfileSchedule = NonNullable<Profile['schedule']>;

export interface ScheduleWindow {
  start: Date;
  end: Date;
}

const minutes = (t: string) => {
  const [h, m] = String(t).split(':').map(Number);
  return Math.min(24 * 60, (h || 0) * 60 + (m || 0));
};

const at = (day: Date, mins: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60);

/** The window of `s` that covers `now`, or null. A from equal to to means the whole day. */
export function windowAt(s: ProfileSchedule | null | undefined, now = new Date()): ScheduleWindow | null {
  if (!s || !s.days?.length) return null;
  const from = minutes(s.from);
  const to = minutes(s.to);
  // The window could have started today or, when it runs past midnight, yesterday.
  for (const back of [0, 1]) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!s.days.includes(day.getDay())) continue;
    const start = at(day, from);
    const endDay = to > from ? day : new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const end = at(endDay, to);
    if (now >= start && now < end) return { start, end };
  }
  return null;
}

export interface ScheduledProfile {
  profile: Profile;
  window: ScheduleWindow;
  /** A stable name for this one window, so a boundary is acted on once. */
  key: string;
}

/**
 * The profile whose hours cover `now` and that is set to switch by itself. When several overlap,
 * the shortest window wins (a 12:00 to 13:00 Lunch beats a 09:00 to 17:00 Work), then the one
 * listed first.
 */
export function scheduledProfile(profiles: Profile[] | undefined, now = new Date()): ScheduledProfile | null {
  let best: ScheduledProfile | null = null;
  let bestLen = Infinity;
  for (const p of [...(profiles ?? [])].sort((a, b) => a.position - b.position)) {
    if (!p.schedule?.auto) continue;
    const w = windowAt(p.schedule, now);
    if (!w) continue;
    const len = w.end.getTime() - w.start.getTime();
    if (len < bestLen) {
      best = { profile: p, window: w, key: `${p.id}@${w.start.toISOString()}` };
      bestLen = len;
    }
  }
  return best;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Weekdays", "Weekends", "Every day", "Monday", or "Mon, Wed and Fri". */
export function describeDays(days: number[]): string {
  const d = [...new Set(days)].sort();
  const key = d.join('');
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  if (d.length === 1) return `${DAY_NAMES[d[0]]}s`;
  // Start the week on Monday for reading.
  const names = [...d.filter((x) => x !== 0), ...d.filter((x) => x === 0)].map((x) => SHORT[x]);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A plain-English read-back: "Weekdays, 09:00 to 17:00. Aurora switches to Work then and back afterwards." */
export function describeProfileSchedule(s: ProfileSchedule, name: string): string {
  const overnight = minutes(s.to) <= minutes(s.from) && s.to !== s.from;
  const span = s.from === s.to ? 'all day' : `${s.from} to ${s.to}${overnight ? ' the next morning' : ''}`;
  const when = `${describeDays(s.days)}, ${span}.`;
  const who = name.trim() || 'this profile';
  return s.auto ? `${when} Aurora switches to ${who} then, and back afterwards.` : `${when} Aurora offers to switch to ${who} then.`;
}
