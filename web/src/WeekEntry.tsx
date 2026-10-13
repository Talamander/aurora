// The always-loaded side of "Your week": the listener that opens the story and the side-pane
// card. The story itself (Week.tsx, its cards, fonts and styles) loads the first time it opens.

import { lazy, Suspense, useEffect, useState } from 'react';
import type { Item } from '../../core/types.ts';
import { weekId, weekStart } from '../../core/week.ts';
import { Icon } from './icons.tsx';
import type { Reader } from './state.ts';
import { onOpenWeek, openWeek, weekApi, weekSeen, type WeekPayload } from './week.ts';
import './weekCard.css';

const WeekStoryView = lazy(() => import('./Week.tsx').then((m) => ({ default: m.WeekStoryView })));

const fmt = (n: number) => n.toLocaleString();

/** Mounted once by the app. Opens the story from the palette, the agent, a card or a notification. */
export function WeekHost({ r, openPost }: { r: Reader; openPost: (it: Item) => void }) {
  const [open, setOpen] = useState<{ week: string | null } | null>(null);
  useEffect(() => onOpenWeek((week) => setOpen({ week })), []);
  useEffect(
    () =>
      r.subscribe((e) => {
        if (e.type === 'ui' && e.action?.kind === 'week') setOpen({ week: typeof e.action.week === 'string' ? e.action.week : null });
      }),
    [r],
  );
  if (!open || !r.lib) return null;
  return (
    <Suspense fallback={<div className="lazy-veil" role="status" aria-label="Opening Your week" />}>
      <WeekStoryView key={r.profileId} r={r} initialWeek={open.week} close={() => setOpen(null)} openPost={openPost} />
    </Suspense>
  );
}

/**
 * Shown in the side pane from Sunday evening through Monday until the reader opens the story.
 * Also a quiet "Your week so far" entry the rest of the week, once something was read.
 */
export function WeekCard({ r }: { r: Reader }) {
  const [d, setD] = useState<WeekPayload | null>(null);
  const now = new Date();
  const sundayEvening = now.getDay() === 0 && now.getHours() >= 18;
  const monday = now.getDay() === 1;
  const wanted = sundayEvening || monday;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    // On Monday, the week that just ended.
    const ref = new Date(now);
    if (monday) ref.setDate(ref.getDate() - 7);
    weekApi.get(r.profileId, monday ? weekId(weekStart(ref)) : null).then((x) => live && setD(x), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, r.profileId]);
  useEffect(
    () =>
      r.subscribe((e) => {
        if (e.type === 'ui' && e.action?.kind === 'week-ready') weekApi.get(r.profileId, String(e.action.week ?? '') || null).then(setD, () => undefined);
      }),
    [r],
  );
  if (!d || d.stats.quiet || weekSeen(d.stats.weekId)) return null;
  const s = d.stats;
  return (
    <section className="rules-card wk-ready">
      <div className="wk-ready-sky" aria-hidden />
      <h3 className="eyebrow">Your week is ready</h3>
      <p className="wk-ready-title">{d.story?.title ?? `${fmt(s.read)} read, ${fmt(s.minutes)} min in articles`}</p>
      <p className="wk-ready-sub">
        {s.setAside ? `${fmt(s.setAside)} posts set aside for you. ` : ''}
        {s.best ? `Best read: ${s.best.title.slice(0, 70)}${s.best.title.length > 70 ? '…' : ''}` : ''}
      </p>
      <button className="btn small primary" onClick={() => openWeek(s.weekId)}>
        <Icon name="play" size={14} /> Play your week
      </button>
    </section>
  );
}
