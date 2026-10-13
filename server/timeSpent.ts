// Time well spent: the server side. Keeps the daily totals (core/timeSpent.ts) in one settings
// row, adds the active seconds the web and phone apps report, and hands the log back. Only daily
// totals per profile are stored; no post, page or moment-by-moment trail.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALL_PROFILE } from '../core/profiles.ts';
import { addTime, dayKey, isDayKey, type TimeLog } from '../core/timeSpent.ts';
import type { Store } from './db.ts';
import type { Profiles } from './profiles.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

const KEY = 'time.spent';

export function createTimeSpent(store: Store) {
  const log = (): TimeLog => {
    const raw = store.getSetting<TimeLog>(KEY);
    return raw && typeof raw === 'object' ? raw : {};
  };
  return {
    log,
    /** Adds one report. The window is anchored a day ahead so a phone east of the server still counts. */
    add(day: string, profile: string, seconds: number): TimeLog {
      const next = addTime(log(), day, profile, seconds, dayKey(new Date(Date.now() + 86_400_000)));
      store.setSetting(KEY, next);
      return next;
    },
  };
}

export function registerTimeRoutes(route: RouteFn, deps: { store: Store; profiles: Profiles; HttpError: new (status: number, message: string) => Error }) {
  const { profiles, HttpError } = deps;
  const time = createTimeSpent(deps.store);
  route('GET', '/api/time', () => ({ log: time.log() }));
  route('POST', '/api/time/tick', (_q, _s, _p, body) => {
    const day = body?.day;
    const profile = String(body?.profile ?? '');
    const seconds = Number(body?.seconds);
    if (!isDayKey(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
    if (profile !== ALL_PROFILE && !profiles.list().some((p) => p.id === profile)) throw new HttpError(400, 'No such profile');
    if (!Number.isFinite(seconds) || seconds < 0) throw new HttpError(400, 'seconds must be a positive number');
    const log = time.add(day, profile, seconds);
    return { day, profile, seconds: log[day]?.[profile] ?? 0 };
  });
  return time;
}
