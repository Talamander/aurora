// The end of the feed: a calm "you're caught up" with what the rules saved you today and when
// new posts are due, and two quiet ways onward. No auto-loading, no "keep scrolling".

import type { FilterResult } from '../../core/filter.ts';
import type { Library, Source } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { openAmbient } from './ambient.ts';
import { openWeek } from './week.ts';

/** Same estimate Your week uses for a post you never had to skim past. */
const SKIM_SECONDS = 5;
const AUTO_SYNC_MINUTES = 30;
const MANUAL_ONLY = new Set(['x-bookmarks']);

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function savedToday(res: FilterResult, now = Date.now()): { posts: number; seconds: number } {
  const since = startOfToday(now);
  const posts = res.hidden.filter((e) => Date.parse(e.item.ingestedAt) >= since).length;
  return { posts, seconds: posts * SKIM_SECONDS };
}

export function savedText(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${h} h${rest ? ` ${rest} min` : ''}`;
}

/** When the server's background sync will next pick something up, roughly. Null when nothing syncs on its own. */
export function nextSync(sources: Source[], now = Date.now()): number | null {
  let next: number | null = null;
  for (const s of sources) {
    if (!s.enabled || s.isDemo || s.status === 'blocked' || MANUAL_ONLY.has(s.connector) || s.connector === 'file' || s.connector === 'import') continue;
    const every = Math.max(AUTO_SYNC_MINUTES, Number(s.config.everyMinutes ?? (s.connector === 'actor' ? 60 : 0)) || 0);
    const due = s.lastSyncAt ? Date.parse(s.lastSyncAt) + every * 60_000 : now;
    const at = Math.max(due, now);
    if (next === null || at < next) next = at;
  }
  return next;
}

export function EndCard({ res, lib, viewName, seeHidden, ms }: { res: FilterResult; lib: Library; viewName: string; seeHidden: () => void; ms: number }) {
  const now = Date.now();
  const saved = savedToday(res, now);
  const hidden = res.hidden.length;
  const next = nextSync(lib.sources, now);
  const soon = next !== null && next - now < 2 * 60_000;
  const at = next === null ? null : new Date(next).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return (
    <section className="end-card" aria-labelledby="end-card-title">
      <span className="end-orb" aria-hidden />
      <h2 className="end-title" id="end-card-title">You’re caught up.</h2>
      <p className="end-sub">
        {saved.posts > 0
          ? <>Your rules saved you <b>{savedText(saved.seconds)}</b> today by setting aside {saved.posts.toLocaleString()} {saved.posts === 1 ? 'post' : 'posts'}.</>
          : viewName === 'Worth reading' ? 'Nothing new needed setting aside today.' : `That is everything in ${viewName}.`}
      </p>
      {at && <p className="end-next"><Icon name="sync" size={13} /> {soon ? 'Next sync in a moment' : `Next sync around ${at}`}</p>}
      <div className="end-actions">
        {hidden > 0 && <button className="btn ghost" onClick={seeHidden}><Icon name="eye" size={16} /> See the {hidden.toLocaleString()} set aside</button>}
        <button className="btn ghost" onClick={() => openAmbient({})}><Icon name="image" size={16} /> Ambient</button>
        <button className="btn ghost" onClick={() => openWeek()}><Icon name="chart" size={16} /> Your week</button>
      </div>
      <p className="end-meta">Filtered {lib.items.length.toLocaleString()} posts in {ms < 1 ? '<1' : Math.round(ms)} ms</p>
    </section>
  );
}
