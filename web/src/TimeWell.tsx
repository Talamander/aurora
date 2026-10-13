// Time well spent: the Today ring by the profile switcher, the calm card where the feed ends once a
// profile's soft limit is reached, the seven-day strip in the profile sheet, and a small sheet with
// today and the week by profile. Nothing here blocks reading; every limit is a sentence, not a wall.

import { useMemo } from 'react';
import { ALL_PROFILE } from '../../core/profiles.ts';
import { dayKey, daysEnding, formatMinutes, secondsOn, shortMinutes, totalsOver, type TimeLog } from '../../core/timeSpent.ts';
import type { Profile } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { ProfileAvatar } from './Profiles.tsx';
import type { Reader } from './state.ts';
import { nudgeFor, setNudge, useTimeLog } from './timeWell.ts';
import { useDialog } from './useDialog.ts';
import './timeWell.css';

const ALL_COLOR = 'var(--lamp)';
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function colorOf(profiles: Profile[], id: string) {
  return profiles.find((p) => p.id === id)?.color ?? ALL_COLOR;
}
function nameOf(profiles: Profile[], id: string) {
  return id === ALL_PROFILE ? 'All' : profiles.find((p) => p.id === id)?.name ?? 'A deleted profile';
}

/** A ring: today's minutes in this profile, against its limit when it has one (else against an hour). */
export function TodayRing({ r, onOpen }: { r: Reader; onOpen: () => void }) {
  const log = useTimeLog();
  const id = r.profile?.id ?? ALL_PROFILE;
  const used = secondsOn(log, dayKey(), id);
  const limit = r.profile?.dailyMinutes ?? null;
  const of = (limit ?? 60) * 60;
  const frac = Math.min(1, used / of);
  const over = !!limit && used >= limit * 60;
  const R = 9;
  const C = 2 * Math.PI * R;
  // Starts with the visible text ("7m") so speech and sight agree.
  const label = `${shortMinutes(used)} today in ${r.profile?.name ?? 'All'}: ${formatMinutes(used)}${limit ? ` of ${limit} minutes` : ''}. Time well spent`;
  return (
    <button type="button" className={`tw-ring ${over ? 'over' : ''}`} onClick={onOpen} aria-label={label} title={label} style={{ ['--pc' as string]: r.profile?.color ?? ALL_COLOR }}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <circle className="tw-ring-bg" cx="12" cy="12" r={R} />
        <circle className="tw-ring-fg" cx="12" cy="12" r={R} strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 12 12)" />
      </svg>
      <span className="tw-ring-n">{shortMinutes(used)}</span>
    </button>
  );
}

/** Seven bars, one a day, ending today; optional limit line. */
export function WeekStrip({ log, profile, color, limit }: { log: TimeLog; profile: string; color: string; limit?: number | null }) {
  const days = daysEnding(dayKey(), 7);
  const vals = days.map((d) => secondsOn(log, d, profile));
  const top = Math.max(limit ? limit * 60 : 0, ...vals, 15 * 60);
  const total = vals.reduce((a, b) => a + b, 0);
  return (
    <figure className="tw-strip" style={{ ['--pc' as string]: color }}>
      <div className="tw-bars" role="img" aria-label={`Last 7 days: ${days.map((d, i) => `${WEEKDAY[new Date(`${d}T12:00:00`).getDay()]} ${formatMinutes(vals[i])}`).join(', ')}`}>
        {limit ? <span className="tw-limit" style={{ bottom: `${((limit * 60) / top) * 100}%` }} aria-hidden /> : null}
        {days.map((d, i) => (
          <span key={d} className={`tw-bar ${i === 6 ? 'today' : ''}`} aria-hidden>
            <i style={{ height: `${Math.max(vals[i] ? 4 : 0, (vals[i] / top) * 100)}%` }} />
            <b>{WEEKDAY[new Date(`${d}T12:00:00`).getDay()].slice(0, 1)}</b>
          </span>
        ))}
      </div>
      <figcaption>{total >= 60 ? `${formatMinutes(total)} this week, about ${formatMinutes(total / 7)} a day` : 'No reading time here this week yet.'}</figcaption>
    </figure>
  );
}

/**
 * The card at the end of the feed once today's soft limit is reached. It ends the endless scroll
 * until you choose: switch profile, five more minutes (once), or keep going for the rest of the day.
 */
export function TimeUpCard({ r }: { r: Reader }) {
  const log = useTimeLog();
  const p = r.profile;
  if (!p?.dailyMinutes) return null;
  const used = secondsOn(log, dayKey(), p.id);
  const nudge = nudgeFor(p.id);
  const others: (Profile | null)[] = [null, ...r.profiles.filter((x) => x.id !== p.id)].slice(0, 4);
  return (
    <section className="tw-up" style={{ ['--pc' as string]: p.color }} aria-labelledby="tw-up-title">
      <span className="tw-up-glow" aria-hidden />
      <ProfileAvatar p={p} size={40} active />
      <h3 id="tw-up-title">{nudge.snoozed ? `That was five more minutes of ${p.name}.` : `That's your ${formatMinutes(p.dailyMinutes * 60)} of ${p.name} for today.`}</h3>
      <p>{formatMinutes(used)} so far. The rest of the feed is still here whenever you want it.</p>
      <div className="tw-up-switch" role="group" aria-label="Switch profile">
        {others.map((o) => (
          <button key={o?.id ?? ALL_PROFILE} type="button" className="btn tw-up-to" style={{ ['--pc' as string]: o?.color ?? ALL_COLOR }} onClick={() => r.switchProfile(o?.id ?? ALL_PROFILE)}>
            <ProfileAvatar p={o} size={20} /> {o?.name ?? 'All'}
          </button>
        ))}
      </div>
      <div className="tw-up-actions">
        {!nudge.snoozed && (
          <button type="button" className="btn" onClick={() => setNudge(p.id, { snoozeTo: used + 300, snoozed: true })}>Five more minutes</button>
        )}
        <button type="button" className="btn ghost" onClick={() => setNudge(p.id, { ...nudge, dismissed: true })}>Keep going</button>
      </div>
    </section>
  );
}

/** Today and this week, by profile. Opened from the ring, the palette or What's new. */
export function TimeSheet({ r, close, editProfile }: { r: Reader; close: () => void; editProfile: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const log = useTimeLog();
  const today = dayKey();
  const ids = useMemo(() => [ALL_PROFILE, ...r.profiles.map((p) => p.id)], [r.profiles]);
  const rows = ids
    .map((id) => ({ id, today: secondsOn(log, today, id), week: totalsOver(log, today, 7).find((x) => x.profile === id)?.seconds ?? 0 }))
    .filter((x) => x.today >= 30 || x.week >= 30 || x.id === (r.profile?.id ?? ALL_PROFILE));
  const top = Math.max(60, ...rows.map((x) => x.week));
  const todayTotal = rows.reduce((a, b) => a + b.today, 0);
  const cur = r.profile;
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet tw-sheet" role="dialog" aria-modal="true" aria-labelledby="tw-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <p className="tw-kicker">Time well spent</p>
            <h2 id="tw-title">{todayTotal >= 60 ? `${formatMinutes(todayTotal)} today` : 'A quiet day so far'}</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <p className="f-hint lead">Active reading only: Aurora counts while this window is in front and you have touched it in the last minute. It keeps daily totals per profile on this computer, nothing about which posts.</p>
          <ul className="tw-rows">
            {rows.map((x) => {
              const p = r.profiles.find((q) => q.id === x.id) ?? null;
              const limit = p?.dailyMinutes ?? null;
              return (
                <li key={x.id} className="tw-row" style={{ ['--pc' as string]: colorOf(r.profiles, x.id) }}>
                  <ProfileAvatar p={p} size={28} />
                  <div className="tw-row-main">
                    <div className="tw-row-top">
                      <span className="tw-row-name">{nameOf(r.profiles, x.id)}</span>
                      <span className="tw-row-today">{formatMinutes(x.today)} today{limit ? ` of ${limit} min` : ''}</span>
                    </div>
                    <div className="tw-row-track" aria-hidden><i style={{ width: `${(x.week / top) * 100}%` }} /></div>
                    <span className="tw-row-week">{formatMinutes(x.week)} in the last 7 days</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {cur && (
            <section className="f-sec">
              <h3>{cur.name}, day by day</h3>
              <WeekStrip log={log} profile={cur.id} color={cur.color} limit={cur.dailyMinutes} />
              <button type="button" className="btn small" onClick={editProfile}>
                <Icon name="clock" size={14} /> {cur.dailyMinutes ? `Change the ${cur.dailyMinutes}-minute limit` : `Give ${cur.name} a daily limit`}
              </button>
            </section>
          )}
          {!cur && r.profiles.length > 0 && <p className="f-hint">Limits belong to profiles: open one and set its minutes a day in its settings.</p>}
        </div>
      </div>
    </div>
  );
}
