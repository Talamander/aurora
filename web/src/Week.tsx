// "Your week": a full-screen story of the reader's week. Tap or use the arrow keys to move, swipe
// on a phone, Esc closes. Numbers come from local data; one paragraph is written by the AI. The
// closing card can be saved as a picture, or sent to a friend through the encrypted share route,
// only when the reader presses Send after seeing exactly what goes.

import { formatMinutes } from '../../core/timeSpent.ts';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import '@fontsource-variable/literata/opsz.css';
import '@fontsource-variable/literata/opsz-italic.css';
import type { Item } from '../../core/types.ts';
import type { WeekStats } from '../../core/week.ts';
import { Icon } from './icons.tsx';
import { proxied } from './imgProxy.ts';
import { openReader } from './longform.ts';
import { RichText } from './rich.tsx';
import type { Reader } from './state.ts';
import { useSocial } from './Friends.tsx';
import { markWeekSeen, weekApi, weekLabel, type WeekPayload, type WeekStory } from './week.ts';
import './week.css';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Counts up to `to` when `on` turns true. Instant with reduced motion. */
function useCount(to: number, on: boolean, ms = 1100): number {
  const [v, setV] = useState(on && reducedMotion() ? to : 0);
  useEffect(() => {
    if (!on) return;
    if (reducedMotion() || to <= 0) {
      setV(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, on, ms]);
  return v;
}

function Initials({ name, src, size }: { name: string; src?: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (src && !broken) return <img className="wk-ava" src={proxied(src)} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
  return (
    <span className="wk-ava wk-ava-i" style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(140deg, hsl(${hue} 70% 62%), hsl(${(hue + 50) % 360} 70% 52%))` }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

interface Card {
  id: string;
  /** Three aurora colours for the sky behind this card. */
  sky: [string, string, string];
  ms: number;
  render: (on: boolean) => ReactNode;
}

// ------------------------------------------------------------------ story

/** The story itself, loaded on first open by WeekHost in WeekEntry.tsx. */
export function WeekStoryView({ r, initialWeek, close, openPost }: { r: Reader; initialWeek: string | null; close: () => void; openPost: (it: Item) => void }) {
  const [week, setWeek] = useState<string | null>(initialWeek);
  const [data, setData] = useState<WeekPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [writing, setWriting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    weekApi.get(r.profileId, week).then(
      (d) => {
        if (!live) return;
        setData(d);
        setIdx(0);
        if (d.stats.weekId) markWeekSeen(d.stats.weekId);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [r.profileId, week]);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    rootRef.current?.focus();
    const html = document.documentElement;
    const was = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = was;
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const byId = useMemo(() => new Map((r.lib?.items ?? []).map((i) => [i.id, i])), [r.lib]);
  const goPost = useCallback(
    (id: string) => {
      const it = byId.get(id);
      if (!it) return;
      close();
      if (it.kind === 'article' || (it.title && /^https?:/.test(it.url) && it.provenance.connector !== 'friends')) openReader(it.id);
      else openPost(it);
    },
    [byId, close, openPost],
  );

  const write = useCallback(async () => {
    if (!data) return;
    setWriting(true);
    try {
      setData(await weekApi.write(r.profileId, data.stats.weekId));
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setWriting(false);
    }
  }, [data, r]);

  const cards = useMemo<Card[]>(() => (data ? buildCards(data, { r, byId, goPost, write, writing }) : []), [data, r, byId, goPost, write, writing]);
  const n = cards.length;
  const card = cards[Math.min(idx, n - 1)];
  const next = useCallback(() => setIdx((i) => Math.min(n - 1, i + 1)), [n]);
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  // Auto-advance like a story, except with reduced motion, on the last card, or while paused.
  const auto = !reducedMotion();
  useEffect(() => {
    if (!auto || paused || !card || idx >= n - 1) return;
    const t = setTimeout(next, card.ms);
    return () => clearTimeout(t);
  }, [auto, paused, card, idx, n, next]);
  useEffect(() => {
    const vis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('textarea, input, select')) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      prev();
    } else if (e.key === 'p') setPaused((p) => !p);
  };

  // Tap the left third to go back, the rest to go on; swipe sideways on touch screens.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, textarea, input, select, label, .wk-nozone')) return;
    touch.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    setPaused(true);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touch.current;
    touch.current = null;
    setPaused(false);
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : prev();
    if (Date.now() - s.t > 500 || Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // a hold pauses, it does not tap
    const w = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - w.left < w.width / 3) prev();
    else next();
  };

  const sky = card?.sky ?? ['var(--lamp)', '#ff7a9c', '#a69bff'];
  const pc = r.profile?.color;
  return (
    <div
      ref={rootRef}
      className="wk"
      role="dialog"
      aria-modal="true"
      aria-label="Your week"
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ ['--s1' as string]: sky[0], ['--s2' as string]: sky[1], ['--s3' as string]: sky[2], ...(pc ? { ['--pc' as string]: pc } : {}) } as CSSProperties}
    >
      <div className="wk-sky" aria-hidden>
        <span />
        <span />
        <span />
        <i />
      </div>
      <header className="wk-top">
        <div className="wk-bars" aria-hidden>
          {cards.map((c, i) => (
            <span key={c.id} className={i < idx ? 'done' : i === idx ? `now${paused || !auto || i === n - 1 ? ' still' : ''}` : ''}>
              <b style={i === idx ? ({ animationDuration: `${c.ms}ms` } as CSSProperties) : undefined} />
            </span>
          ))}
        </div>
        <div className="wk-head">
          <span className="wk-brand">
            <img src="/icon.svg" alt="" width={22} height={22} /> Your week{r.profile ? <em> · {r.profile.name}</em> : null}
          </span>
          {data && data.weeks.length > 1 ? (
            <label className="wk-pick">
              <span className="sr-only">Week</span>
              <select value={data.stats.weekId} onChange={(e) => setWeek(e.target.value)}>
                {data.weeks.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.current ? 'This week' : weekLabel(w.start)}
                    {w.title ? ` · ${w.title}` : ''}
                  </option>
                ))}
              </select>
              <Icon name="back" size={13} />
            </label>
          ) : (
            <span className="wk-pick-static">{data ? weekLabel(data.stats.start) : ''}</span>
          )}
          {auto && (
            <button className="wk-icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (p)' : 'Pause (p)'}>
              <Icon name={paused ? 'play' : 'pause'} size={16} />
            </button>
          )}
          <button className="wk-icon" onClick={close} aria-label="Close" title="Close (Esc)">
            <Icon name="x" size={18} />
          </button>
        </div>
      </header>
      <div className="wk-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => ((touch.current = null), setPaused(false))}>
        {error ? (
          <div className="wk-card wk-in">
            <p className="wk-eyebrow">Your week</p>
            <h2 className="wk-h">Could not open it.</h2>
            <p className="wk-dek">{error}</p>
          </div>
        ) : !data ? (
          <div className="wk-card">
            <p className="wk-dek wk-loading">Adding up your week…</p>
          </div>
        ) : (
          card && (
            <div key={`${data.stats.weekId}:${card.id}`} className={`wk-card wk-in wk-c-${card.id}`} aria-live="polite">
              {card.render(true)}
            </div>
          )
        )}
      </div>
      <footer className="wk-foot" aria-hidden={!data}>
        <button className="wk-nav" onClick={prev} disabled={idx === 0} aria-label="Previous">
          <Icon name="back" size={18} />
        </button>
        <span className="wk-count">
          {Math.min(idx + 1, n)} / {n}
        </span>
        <button className="wk-nav wk-nav-next" onClick={next} disabled={idx >= n - 1} aria-label="Next">
          <Icon name="back" size={18} />
        </button>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ cards

interface Ctx {
  r: Reader;
  byId: Map<string, Item>;
  goPost: (id: string) => void;
  write: () => void;
  writing: boolean;
}

function buildCards(d: WeekPayload, c: Ctx): Card[] {
  const s = d.stats;
  const cards: Card[] = [];
  const range = weekLabel(s.start);
  const live = !d.frozenAt && new Date(s.end).getTime() > Date.now();

  cards.push({
    id: 'intro',
    sky: ['var(--lamp)', '#ff7a9c', '#a69bff'],
    ms: 4200,
    render: () => (
      <>
        <p className="wk-eyebrow" style={{ ['--i' as string]: 0 } as CSSProperties}>{range}{live ? ' · so far' : ''}</p>
        <h1 className="wk-title" style={{ ['--i' as string]: 1 } as CSSProperties}>
          {d.story?.title ? (
            d.story.title
          ) : s.quiet ? (
            <>A quiet week<span className="wk-lit">.</span></>
          ) : (
            <>
              Your week, <span className="wk-lit">read back to you.</span>
            </>
          )}
        </h1>
        <p className="wk-dek" style={{ ['--i' as string]: 2 } as CSSProperties}>
          {s.quiet
            ? `${plural(s.arrived, 'post')} arrived. Nothing read yet, which is a kind of rest too.`
            : `${c.r.profile ? `${c.r.profile.name}, ` : ''}${plural(s.read, 'post')} read, ${plural(s.minutes, 'minute')} in articles. Tap to begin.`}
        </p>
      </>
    ),
  });

  if (!s.quiet) {
    cards.push({ id: 'numbers', sky: ['#ffc56b', 'var(--lamp)', '#ff7a9c'], ms: 6500, render: (on) => <NumbersCard s={s} on={on} /> });
  }

  cards.push({ id: 'rules', sky: ['#5eead4', '#7aa2f7', 'var(--lamp)'], ms: 6000, render: (on) => <RulesCard s={s} on={on} /> });

  if (s.people.length) {
    cards.push({ id: 'people', sky: ['#ff7a9c', '#a69bff', '#7dcfff'], ms: 6500, render: () => <PeopleCard s={s} read={s.read + s.saved >= 3} /> });
  }

  if (s.topic) {
    const t = s.topic;
    cards.push({
      id: 'topic',
      sky: ['#9ece6a', '#5eead4', '#ffc56b'],
      ms: 5500,
      render: (on) => <TopicCard t={t} on={on} />,
    });
  }

  if (s.best) {
    const b = s.best;
    cards.push({
      id: 'best',
      sky: ['#ffc56b', '#ff9e64', '#a69bff'],
      ms: 9000,
      render: () => <BestCard b={b} open={() => c.goPost(b.itemId)} />,
    });
  }

  if (!s.quiet) {
    cards.push({
      id: 'words',
      sky: ['#a69bff', '#ff7a9c', '#7dcfff'],
      ms: 13000,
      render: () => <WordsCard d={d} c={c} />,
    });
  }

  cards.push({ id: 'close', sky: ['var(--lamp)', '#ff7a9c', '#a69bff'], ms: 60000, render: () => <ClosingCard d={d} c={c} /> });
  return cards;
}

const at = (i: number) => ({ ['--i' as string]: i }) as CSSProperties;

function NumbersCard({ s, on }: { s: WeekStats; on: boolean }) {
  const read = useCount(s.read, on);
  const max = Math.max(1, ...s.days);
  const busiest = s.days.indexOf(Math.max(...s.days));
  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>The week in numbers</p>
      <p className="wk-giant" style={at(1)}>
        <span className="wk-lit">{fmt(read)}</span>
      </p>
      <p className="wk-under" style={at(2)}>{s.read === 1 ? 'post read' : 'posts read'}</p>
      <div className="wk-days" style={at(3)} aria-label={`Busiest day: ${DAY_NAMES[busiest]}`}>
        {s.days.map((v, i) => (
          <span key={i} className={i === busiest && v > 0 ? 'top' : ''}>
            <b style={{ height: `${Math.max(4, (v / max) * 100)}%`, animationDelay: `${0.5 + i * 0.06}s` }} />
            <em>{DAYS[i][0]}</em>
          </span>
        ))}
      </div>
      <div className="wk-grid" style={at(4)}>
        <Stat n={s.minutes} label={s.minutes === 1 ? 'minute in articles' : 'minutes in articles'} sub={s.articles ? `${plural(s.articles, 'article')} finished` : undefined} on={on} />
        <Stat n={s.saved} label="saved" on={on} />
        <Stat n={s.highlights} label={s.highlights === 1 ? 'highlight' : 'highlights'} on={on} />
      </div>
      {s.days[busiest] > 0 && <p className="wk-note" style={at(5)}>{DAY_NAMES[busiest]} was your big reading day.</p>}
      {!!s.timeBy?.length && (
        <p className="wk-note wk-time" style={at(6)}>
          Time well spent: {s.timeBy.slice(0, 4).map((t, i) => (
            <span key={t.profile}>{i ? ', ' : ''}<b>{t.name}</b> {formatMinutes(t.seconds)}</span>
          ))}.
        </p>
      )}
    </>
  );
}

function Stat({ n, label, sub, on }: { n: number; label: string; sub?: string; on: boolean }) {
  const v = useCount(n, on, 900);
  return (
    <div className="wk-stat">
      <b>{fmt(v)}</b>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function RulesCard({ s, on }: { s: WeekStats; on: boolean }) {
  const n = useCount(s.setAside, on);
  const kept = Math.max(0, s.arrived - s.setAside);
  const pct = s.arrived ? Math.round((s.setAside / s.arrived) * 100) : 0;
  if (!s.setAside) {
    return (
      <>
        <p className="wk-eyebrow" style={at(0)}>Your rules</p>
        <h2 className="wk-h" style={at(1)}>{s.arrived ? <>All {fmt(s.arrived)} posts got through.</> : <>Nothing new arrived.</>}</h2>
        <p className="wk-dek" style={at(2)}>No noise to set aside this week. When something gets loud, ask Aurora for a rule in plain English.</p>
      </>
    );
  }
  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>Quietly handled</p>
      <p className="wk-giant wk-giant-m" style={at(1)}>
        <span className="wk-lit">{fmt(n)}</span>
      </p>
      <p className="wk-under" style={at(2)}>posts set aside, so you didn't have to</p>
      <div className="wk-split" style={at(3)} role="img" aria-label={`${pct}% of ${s.arrived} posts set aside`}>
        <span className="kept" style={{ flexGrow: Math.max(kept, 0.001) }} />
        <span className="aside" style={{ flexGrow: Math.max(s.setAside, 0.001) }} />
      </div>
      <div className="wk-legend" style={at(4)}>
        <span><i className="kept" /> {fmt(kept)} kept</span>
        {s.noise > 0 && <span><i className="aside" /> {fmt(s.noise)} noise</span>}
        {s.ruled > 0 && <span><i className="aside" /> {fmt(s.ruled)} by your AI rules</span>}
      </div>
      <p className="wk-dek" style={at(5)}>
        That is about <b>{plural(s.savedMinutes, 'minute')}</b> of scrolling you got back.
      </p>
    </>
  );
}

function PeopleCard({ s, read }: { s: WeekStats; read: boolean }) {
  const [first, ...rest] = s.people;
  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>{read ? 'Who you spent it with' : 'Who showed up'}</p>
      <div className="wk-first" style={at(1)}>
        <Initials name={first.name} src={first.avatar} size={112} />
        <div>
          <h2 className="wk-h wk-h-name">{first.name}</h2>
          <p className="wk-note">
            {first.handle ? `${first.handle.startsWith('@') ? '' : '@'}${first.handle} · ` : ''}
            {plural(first.count, 'post')}
          </p>
        </div>
      </div>
      {rest.length > 0 && (
        <ol className="wk-people" style={at(2)}>
          {rest.map((p, i) => (
            <li key={p.key}>
              <span className="wk-rank">{i + 2}</span>
              <Initials name={p.name} src={p.avatar} size={40} />
              <span className="wk-pname">{p.name}</span>
              <span className="wk-pcount">{fmt(p.count)}</span>
            </li>
          ))}
        </ol>
      )}
      {s.sources.length > 0 && (
        <p className="wk-sources" style={at(3)}>
          Mostly from {s.sources.map((x) => x.label).slice(0, 3).join(', ').replace(/, ([^,]*)$/, ' and $1')}.
        </p>
      )}
    </>
  );
}

function TopicCard({ t, on }: { t: NonNullable<WeekStats['topic']>; on: boolean }) {
  const now = useCount(t.count, on);
  const max = Math.max(t.count, t.before, 1);
  const up = t.count - t.before;
  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>{up > 0 ? 'On the rise' : 'Holding steady'}</p>
      <h2 className="wk-title wk-title-m" style={at(1)}>{t.name}</h2>
      <div className="wk-vs" style={at(2)}>
        <div>
          <span className="wk-vs-bar before" style={{ height: `${(t.before / max) * 100}%` }} />
          <b>{fmt(t.before)}</b>
          <em>last week</em>
        </div>
        <div>
          <span className="wk-vs-bar now" style={{ height: `${(t.count / max) * 100}%` }} />
          <b className="wk-lit">{fmt(now)}</b>
          <em>this week</em>
        </div>
      </div>
      <p className="wk-dek" style={at(3)}>
        {up > 0 ? (t.before ? `Up ${plural(up, 'post')} on the week before.` : 'New this week: it was not in your feed before.') : `${plural(t.count, 'post')}, your busiest topic.`}
      </p>
    </>
  );
}

function BestCard({ b, open }: { b: NonNullable<WeekStats['best']>; open: () => void }) {
  return (
    <>
      {b.image && <div className="wk-best-bg" style={{ backgroundImage: `url("${proxied(b.image)?.replace(/"/g, '%22')}")` }} aria-hidden />}
      <p className="wk-eyebrow" style={at(0)}>The best thing you read</p>
      <h2 className="wk-best-title" style={at(1)}>{b.title}</h2>
      <p className="wk-note" style={at(2)}>
        {[b.author, b.source, b.minutes ? `${b.minutes} min` : ''].filter(Boolean).join(' · ')}
      </p>
      {b.highlight && (
        <blockquote className="wk-quote" style={at(3)}>
          <span aria-hidden>“</span>
          {b.highlight.quote}
          <small>You highlighted this.</small>
        </blockquote>
      )}
      <div className="wk-actions" style={at(4)}>
        <button className="wk-btn" onClick={open}>
          <Icon name="book" size={16} /> Open it again
        </button>
      </div>
    </>
  );
}

function WordsCard({ d, c }: { d: WeekPayload; c: Ctx }) {
  const story = d.story;
  if (!story) {
    return (
      <>
        <p className="wk-eyebrow" style={at(0)}>In your words</p>
        <h2 className="wk-h" style={at(1)}>The week, as you would tell it.</h2>
        {d.aiReady ? (
          <>
            <p className="wk-dek" style={at(2)}>Aurora writes one paragraph from what you read, in your voice. It runs on your AI setup and stays on this computer.</p>
            <div className="wk-actions" style={at(3)}>
              <button className="wk-btn wk-btn-lit" onClick={c.write} disabled={c.writing}>
                <Icon name="sparkle" size={16} /> {c.writing ? 'Writing…' : 'Write it'}
              </button>
            </div>
          </>
        ) : (
          <p className="wk-dek" style={at(2)}>Set up the AI in AI settings and Aurora will write this paragraph every Sunday evening.</p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>In your words</p>
      <div className="wk-words" style={at(1)}>
        <RichText
          text={story.text}
          cite={(id, n) =>
            c.byId.has(id) ? (
              <button className="wk-cite" onClick={() => c.goPost(id)} title={(c.byId.get(id)!.title ?? c.byId.get(id)!.text).slice(0, 120)} aria-label={`Open post ${n}`}>
                {n}
              </button>
            ) : null
          }
        />
      </div>
      <p className="wk-note" style={at(2)}>
        Written by your AI from your own reading.{' '}
        {d.aiReady && (
          <button className="wk-link" onClick={c.write} disabled={c.writing}>
            {c.writing ? 'Writing…' : 'Write it again'}
          </button>
        )}
      </p>
    </>
  );
}

// ------------------------------------------------------------------ closing card and sharing

function ClosingCard({ d, c }: { d: WeekPayload; c: Ctx }) {
  const s = d.stats;
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const name = c.r.profile?.name ?? null;

  const save = async () => {
    setBusy('save');
    try {
      const blob = await drawShareCard(s, d.story, name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aurora-week-${s.weekId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      c.r.toast('Saved the picture of your week');
    } catch (e) {
      c.r.toast(`Could not make the picture: ${(e as Error).message}`, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    setBusy('copy');
    try {
      const blob = await drawShareCard(s, d.story, name);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      c.r.toast('Copied the picture');
    } catch {
      c.r.toast('Copying pictures is not allowed here. Save it instead.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="wk-eyebrow" style={at(0)}>That was your week</p>
      <div className="wk-end" style={at(1)}>
        <div className="wk-poster wk-nozone">
          <div className="wk-poster-sky" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <div className="wk-poster-head">
            <img src="/icon.svg" alt="" width={28} height={28} />
            <span>
              My week in Aurora{name ? ` · ${name}` : ''}
              <small>{weekLabel(s.start)}</small>
            </span>
          </div>
          <p className="wk-poster-title">{d.story?.title ?? (s.quiet ? 'A quiet week' : `${fmt(s.read)} posts read`)}</p>
          <div className="wk-poster-grid">
            <span><b>{fmt(s.read)}</b>read</span>
            <span><b>{fmt(s.minutes)}</b>min in articles</span>
            <span><b>{fmt(s.saved)}</b>saved</span>
            <span><b>{fmt(s.setAside)}</b>set aside</span>
          </div>
          {s.best && <p className="wk-poster-best">Best read: <b>{s.best.title}</b></p>}
          <p className="wk-poster-foot">Private, on my own computer</p>
        </div>
        <div className="wk-end-side">
          <div className="wk-actions wk-nozone">
            <button className="wk-btn wk-btn-lit" onClick={() => void save()} disabled={!!busy}>
              <Icon name="upload" size={16} /> {busy === 'save' ? 'Making it…' : 'Save picture'}
            </button>
            {typeof ClipboardItem !== 'undefined' && (
              <button className="wk-btn" onClick={() => void copy()} disabled={!!busy}>
                <Icon name="page" size={16} /> Copy
              </button>
            )}
            <button className="wk-btn" onClick={() => setSharing((x) => !x)} aria-expanded={sharing} disabled={s.quiet}>
              <Icon name="people" size={16} /> Send to a friend
            </button>
          </div>
          {sharing && <FriendShare d={d} c={c} close={() => setSharing(false)} />}
          <p className="wk-note">
            The picture stays on this computer until you save or send it. {d.weeks.length > 1 ? 'Earlier weeks are in the menu at the top.' : ''}
          </p>
        </div>
      </div>
    </>
  );
}

/** The note a friend receives, written from the numbers only. The reader can edit it before sending. */
export function shareNote(s: WeekStats, story: WeekStory | null): string {
  const bits = [`${plural(s.read, 'post')} read`, `${plural(s.minutes, 'minute')} in articles`];
  if (s.saved) bits.push(`${fmt(s.saved)} saved`);
  const head = story?.title ? `My week in Aurora: ${story.title}.` : 'My week in Aurora.';
  const best = s.best ? ` The best thing I read was this one.` : '';
  return `${head} ${bits.join(', ')}.${best}`;
}

function FriendShare({ d, c, close }: { d: WeekPayload; c: Ctx; close: () => void }) {
  const social = useSocial();
  const s = d.stats;
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState(() => shareNote(s, d.story));
  const [busy, setBusy] = useState(false);
  const best = s.best ? c.byId.get(s.best.itemId) : undefined;
  const fromFriend = best?.provenance.connector === 'friends';
  const friends = social?.friends.filter((f) => f.status === 'friend') ?? [];
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), []);

  const send = async () => {
    if (!best || !picked.length) return;
    setBusy(true);
    try {
      const res = await fetch('/api/social/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: best.id, note: note.trim(), friends: picked }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      c.r.toast(`Sent to ${(data.sentTo as string[]).join(', ')}`);
      close();
    } catch (e) {
      c.r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (!social) body = <p className="wk-note">Loading friends…</p>;
  else if (!social.enabled || !friends.length) body = <p className="wk-note">Add a friend first, from Friends in the sidebar. Then you can send them your week.</p>;
  else if (!best || fromFriend) body = <p className="wk-note">Your best read came from a friend, and friends' shares stay between you and them. Save the picture instead.</p>;
  else
    body = (
      <>
        <div className="wk-fr-list">
          {friends.map((f) => (
            <label key={f.fp} className={`wk-fr ${picked.includes(f.fp) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.includes(f.fp)} onChange={() => setPicked((p) => (p.includes(f.fp) ? p.filter((x) => x !== f.fp) : [...p, f.fp]))} />
              <Initials name={f.name} size={24} /> {f.name}
            </label>
          ))}
        </div>
        <label className="wk-fr-label" htmlFor="wk-note">Your note</label>
        <textarea id="wk-note" className="wk-fr-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        <div className="wk-fr-preview">
          <p className="wk-fr-label">Exactly what they get</p>
          <p className="wk-fr-quote">“{note.trim() || '(no note)'}”</p>
          <div className="wk-fr-post">
            <b>{best.title || best.text.slice(0, 120)}</b>
            <span>{[best.author.name, best.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)].filter(Boolean).join(' · ')}</span>
          </div>
          <p className="wk-fr-small">Sent as a normal Aurora share: your note and that one post. Not the picture, not your numbers beyond what the note says, nothing else from your library. End-to-end encrypted.</p>
        </div>
        <div className="wk-actions">
          <button className="wk-btn wk-btn-lit" onClick={() => void send()} disabled={busy || !picked.length}>
            {busy ? 'Sending…' : picked.length ? `Send to ${picked.length === 1 ? friends.find((f) => f.fp === picked[0])?.name : `${picked.length} friends`}` : 'Pick a friend'}
          </button>
          <button className="wk-btn" onClick={close}>Cancel</button>
        </div>
      </>
    );
  return (
    <section ref={ref} className="wk-share wk-nozone" aria-label="Send your week to a friend">
      {body}
    </section>
  );
}

/** Draws the closing card as a 1080 x 1350 PNG. Text and shapes only: no third-party pictures. */
export async function drawShareCard(s: WeekStats, story: WeekStory | null, profileName: string | null): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  if (!g) throw new Error('No canvas');
  try {
    await Promise.all([document.fonts.load('700 120px "Geist Variable"'), document.fonts.load('500 40px "Geist Variable"')]);
  } catch {
    /* system font then */
  }
  const sans = '"Geist Variable", "Geist", system-ui, sans-serif';
  g.fillStyle = '#06070c';
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, rx: number, ry: number, color: string, a: number) => {
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = a;
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, rx, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  blob(260, 220, 520, 260, '#ffc56b', 0.55);
  blob(620, 160, 560, 300, '#ff7a9c', 0.5);
  blob(900, 300, 480, 260, '#a69bff', 0.55);
  blob(540, 1250, 700, 260, '#7a5cff', 0.25);
  // A fine grain of stars.
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 60; i++) {
    const x = (i * 197) % W;
    const y = (i * 331) % (H * 0.6);
    g.globalAlpha = 0.15 + ((i * 7) % 10) / 30;
    g.fillRect(x, y, 2, 2);
  }
  g.globalAlpha = 1;

  const icon = await new Promise<HTMLImageElement | null>((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = '/icon.svg';
  });
  const M = 88;
  if (icon) g.drawImage(icon, M, 96, 72, 72);
  g.fillStyle = '#eef0f6';
  g.font = `600 34px ${sans}`;
  g.textBaseline = 'alphabetic';
  g.fillText(`My week in Aurora${profileName ? ` · ${profileName}` : ''}`, M + (icon ? 96 : 0), 128);
  g.fillStyle = 'rgba(238,240,246,0.62)';
  g.font = `500 28px ${sans}`;
  g.fillText(weekLabel(s.start), M + (icon ? 96 : 0), 164);

  // Title, wrapped to three lines at most.
  const lit = g.createLinearGradient(M, 0, W - M, 0);
  lit.addColorStop(0, '#ffc56b');
  lit.addColorStop(0.6, '#ff7a9c');
  lit.addColorStop(1, '#a69bff');
  const title = story?.title ?? (s.quiet ? 'A quiet week' : `${fmt(s.read)} posts read`);
  g.font = `700 104px ${sans}`;
  const lines = wrap(g, title, W - M * 2, 3);
  let y = 420;
  g.fillStyle = lit;
  for (const l of lines) {
    g.fillText(l, M, y);
    y += 112;
  }

  // The bottom is laid out upwards from the footer, so a long title or best read never collides.
  const foot = H - 64;
  g.font = `600 38px ${sans}`;
  const bestLines = s.best ? wrap(g, s.best.title, W - M * 2, 2) : [];
  const bestTop = foot - 70 - bestLines.length * 50 - (bestLines.length ? 40 : 0);
  if (s.best) {
    let by = bestTop + 28;
    g.fillStyle = 'rgba(238,240,246,0.6)';
    g.font = `500 28px ${sans}`;
    g.fillText('Best read', M, by);
    g.fillStyle = '#eef0f6';
    g.font = `600 38px ${sans}`;
    for (const l of bestLines) {
      by += 50;
      g.fillText(l, M, by);
    }
  }
  g.fillStyle = 'rgba(238,240,246,0.45)';
  g.font = `500 26px ${sans}`;
  g.fillText('Private, on my own computer', M, foot);

  // Four numbers on glass, just above the best read.
  const cw = (W - M * 2 - 24) / 2;
  const ch = 160;
  y = Math.max(y - 40, bestTop - 48 - ch * 2 - 24);
  const cells: [string, string][] = [
    [fmt(s.read), 'posts read'],
    [fmt(s.minutes), 'min in articles'],
    [fmt(s.saved), 'saved'],
    [fmt(s.setAside), 'set aside for me'],
  ];
  cells.forEach(([n, label], i) => {
    const x = M + (i % 2) * (cw + 24);
    const yy = y + Math.floor(i / 2) * (ch + 24);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(g, x, yy, cw, ch, 28);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = `700 72px ${sans}`;
    g.fillText(n, x + 32, yy + 88);
    g.fillStyle = 'rgba(238,240,246,0.66)';
    g.font = `500 28px ${sans}`;
    g.fillText(label, x + 32, yy + 130);
  });
  return await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture'))), 'image/png'));
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > max && line) {
      out.push(line);
      line = w;
      if (out.length === maxLines) break;
    } else line = t;
  }
  if (out.length < maxLines && line) out.push(line);
  else if (out.length === maxLines && line) {
    let last = out[maxLines - 1];
    while (last.length > 1 && g.measureText(`${last}…`).width > max) last = last.slice(0, -1);
    out[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
