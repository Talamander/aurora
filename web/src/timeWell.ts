// Time well spent in the web app: measures active reading time and keeps today's totals at hand.
// Time counts only while the page is visible and you touched a key, the mouse, the wheel or the
// screen in the last minute. Totals go to the server every 30 seconds (core/timeSpent.ts keeps
// only daily sums per profile). One small store, so only the parts that show time re-render.

import { useSyncExternalStore } from 'react';
import { activeSeconds, addTime, dayKey, limitDue, secondsOn, type TimeLog } from '../../core/timeSpent.ts';
import type { Profile } from '../../core/types.ts';
import { api } from './api.ts';

const SAMPLE_MS = 5_000;
const FLUSH_MS = 30_000;
const NUDGE_KEY = 'aurora.timeNudge';

let log: TimeLog = {};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export const getTimeLog = () => log;

/** Today's log, re-rendering the caller whenever it changes (about every 10 seconds while reading). */
export function useTimeLog(): TimeLog {
  return useSyncExternalStore(subscribe, getTimeLog);
}

// ------------------------------------------------------------------ the gentle limit

export interface Nudge { snoozeTo?: number; dismissed?: boolean; snoozed?: boolean }
type NudgeState = { day: string; by: Record<string, Nudge> };

function loadNudges(): NudgeState {
  try {
    const v = JSON.parse(localStorage.getItem(NUDGE_KEY) ?? 'null') as NudgeState | null;
    if (v && v.day === dayKey() && v.by && typeof v.by === 'object') return v;
  } catch {
    /* blocked storage: the card may show again after a reload, which is harmless */
  }
  return { day: dayKey(), by: {} };
}

export function nudgeFor(profile: string): Nudge {
  return loadNudges().by[profile] ?? {};
}

export function setNudge(profile: string, n: Nudge) {
  const s = loadNudges();
  s.by[profile] = n;
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(s));
  } catch {
    /* see above */
  }
  emit();
}

/** Whether the active profile's soft limit card is due. A boolean, so the feed re-renders only when it flips. */
export function useLimitDue(profile: Profile | null): boolean {
  return useSyncExternalStore(subscribe, () => (profile?.dailyMinutes ? limitDue(profile.dailyMinutes, secondsOn(log, dayKey(), profile.id), nudgeFor(profile.id)) : false));
}

// ------------------------------------------------------------------ measuring

let current = 'all';
let sampleNow: (() => void) | null = null;

/** Names the profile to credit from now on; time so far goes to the one that was active. */
export function setTrackedProfile(id: string) {
  if (id === current) return;
  sampleNow?.();
  current = id;
}

/** Starts measuring for the whole page and returns a stop function. Call once from the app shell. */
export function startTimeTracking(): () => void {
  const profile = () => current;
  let lastInput = Date.now();
  let lastTick = Date.now();
  // Seconds measured but not yet sent, per day and profile, with the fractions carried over.
  let pending: TimeLog = {};
  let carry = 0;
  let lastEmit = 0;

  const refresh = () =>
    api.timeLog().then(
      (r) => {
        let next = r.log ?? {};
        for (const [d, row] of Object.entries(pending)) for (const [p, s] of Object.entries(row)) next = addTime(next, d, p, s);
        log = next;
        emit();
      },
      () => {},
    );

  const sample = (force = false) => {
    const now = Date.now();
    const secs = activeSeconds(lastTick, now, lastInput, document.visibilityState === 'visible') + carry;
    lastTick = now;
    const whole = Math.floor(secs);
    carry = secs - whole;
    if (whole > 0) {
      const day = dayKey(new Date(now));
      const p = profile();
      const row = (pending[day] ??= {});
      row[p] = (row[p] ?? 0) + whole;
      log = addTime(log, day, p, whole);
    }
    if (force || now - lastEmit > 10_000) {
      lastEmit = now;
      emit();
    }
  };

  const flush = (keepalive = false) => {
    sample(true);
    const out = pending;
    pending = {};
    for (const [day, row] of Object.entries(out)) {
      for (const [p, s] of Object.entries(row)) {
        // The server caps one report at two minutes; split anything longer (a long offline stretch).
        for (let left = s; left > 0; left -= 120) {
          api.timeTick(day, p, Math.min(120, left), keepalive).catch(() => {
            const r = (pending[day] ??= {});
            r[p] = (r[p] ?? 0) + Math.min(120, left);
          });
        }
      }
    }
  };

  const onInput = () => {
    const now = Date.now();
    // Coming back after being away: the quiet stretch does not count.
    if (now - lastInput > 60_000) {
      sample();
      lastTick = now;
    }
    lastInput = now;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush(true);
    else {
      lastTick = Date.now();
      lastInput = Date.now();
      void refresh();
    }
  };
  const onHide = () => flush(true);

  sampleNow = () => sample(true);
  const opts = { capture: true, passive: true } as const;
  const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'scroll'] as const;
  events.forEach((e) => window.addEventListener(e, onInput, opts));
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  const s = setInterval(() => sample(), SAMPLE_MS);
  const f = setInterval(() => flush(), FLUSH_MS);
  void refresh();
  return () => {
    flush(true);
    sampleNow = null;
    clearInterval(s);
    clearInterval(f);
    events.forEach((e) => window.removeEventListener(e, onInput, opts));
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
  };
}
