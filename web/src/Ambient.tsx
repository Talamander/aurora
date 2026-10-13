// Ambient: the feed as a slow, full-screen display for a second monitor, a TV or the desktop app.
// Pictures fill the screen and drift (Ken Burns) over a sky made of their own colours; short posts
// are set big; articles get a title card. It never marks anything read and never plays sound.
// Every picture is the library's own, already routed through the image proxy. Post text is
// rendered as React text, never as HTML.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';
import '@fontsource-variable/literata/opsz.css';
import { buildSlides, peopleIn, personKey, sizeStep, skyFor, type Slide } from '../../core/ambient.ts';
import { applyFilters, normalizeSpec } from '../../core/filter.ts';
import type { FilterSpec, Item } from '../../core/types.ts';
import { loadPrefs, nearestPace, PACES, savePrefs, type AmbientOpen, type AmbientPrefs } from './ambient.ts';
import { platformLabel, relTime } from './format.ts';
import { Icon } from './icons.tsx';
import { openReader } from './longform.ts';
import { BUILTIN_VIEWS, type Reader } from './state.ts';
import './ambient.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = 1600;
const IDLE_MS = 2800;

// ------------------------------------------------------------------ helpers

interface ViewChoice {
  id: string;
  name: string;
  spec: FilterSpec;
}

function useClock(on: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Four gentle Ken Burns paths; a post always takes the same one. */
function drift(id: string): number {
  return [...id].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5) % 4;
}

function Avatar({ it }: { it: Item }) {
  const [broken, setBroken] = useState(false);
  const name = it.author.name || it.author.handle || '?';
  if (it.author.avatar && !broken) return <img className="amb-ava" src={it.author.avatar} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  const [h] = skyFor(personKey(it));
  return <span className="amb-ava amb-ava-i" style={{ background: `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 50) % 360} 70% 50%))` }} aria-hidden>{name.trim()[0]?.toUpperCase()}</span>;
}

function Meta({ s, source }: { s: Slide; source: string }) {
  const it = s.item;
  return (
    <div className="amb-meta">
      <Avatar it={it} />
      <div className="amb-meta-t">
        <b>{it.author.name || it.author.handle}</b>
        <span>
          {source || platformLabel(it.platform)} · {relTime(it.publishedAt) || 'recently'}
          {it.isDemo && ' · fictional demo'}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ one slide

function SlideView({ s, source, pace, state }: { s: Slide; source: string; pace: number; state: 'in' | 'out' }) {
  const [fit, setFit] = useState<'cover' | 'contain' | null>(null);
  const [broken, setBroken] = useState(false);
  const motion = !reducedMotion();
  const it = s.item;
  const sky = skyFor(personKey(it) || it.id);
  const style = {
    '--kb-ms': `${(pace * 1000 + FADE_MS * 2) | 0}ms`,
    '--h1': `${sky[0]}`,
    '--h2': `${sky[1]}`,
    '--h3': `${sky[2]}`,
  } as CSSProperties;
  const picture = s.image && !broken ? s.image : null;

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const a = img.naturalWidth / Math.max(1, img.naturalHeight);
    const screen = window.innerWidth / Math.max(1, window.innerHeight);
    // Fill the screen when the picture is close to its shape; otherwise show all of it over its own sky.
    setFit(a / screen > 0.72 && a / screen < 1.4 ? 'cover' : 'contain');
  };

  return (
    <div className={`amb-slide amb-${s.kind} ${state}${picture ? ' has-pic' : ''}`} style={style} aria-hidden={state === 'out'}>
      {picture ? (
        <>
          <img className="amb-sky-img" src={picture} alt="" referrerPolicy="no-referrer" />
          <div className="amb-shade" />
        </>
      ) : (
        <div className="amb-sky" aria-hidden>
          <span /><span /><span />
        </div>
      )}

      {(s.kind === 'photo' || s.kind === 'video') && picture && (
        <>
          <div className={`amb-frame ${fit ?? 'loading'}`}>
            <img
              className={`amb-pic${motion ? ` kb kb-${drift(it.id)}` : ''}`}
              src={picture}
              alt={s.alt || (s.text ? s.text.slice(0, 140) : `Picture from ${it.author.name}`)}
              referrerPolicy="no-referrer"
              onLoad={onLoad}
              onError={() => setBroken(true)}
              draggable={false}
            />
          </div>
          <div className="amb-scrim" />
          <div className="amb-caption">
            {s.kind === 'video' && <span className="amb-badge"><Icon name="video" size={14} /> Video</span>}
            {s.text && <p className="amb-cap-text">{s.text}</p>}
            <Meta s={s} source={source} />
          </div>
        </>
      )}

      {(s.kind === 'text' || ((s.kind === 'photo' || s.kind === 'video') && !picture)) && (
        <div className="amb-quote">
          {s.title && s.kind === 'text' && <p className="amb-kicker">{s.title}</p>}
          <p className={`amb-say amb-say-${sizeStep(s.text)}`}>{s.text}</p>
          <Meta s={s} source={source} />
        </div>
      )}

      {s.kind === 'article' && (
        <div className="amb-article">
          <p className="amb-kicker">Article · {source || platformLabel(it.platform)}</p>
          <h2 className="amb-a-title">{s.title}</h2>
          {s.text && <p className="amb-a-dek">{s.text}</p>}
          <Meta s={s} source={source} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the display

/** The display itself, loaded on first open by AmbientHost in AmbientEntry.tsx. */
export function Ambient({ r, req, close, openPost }: { r: Reader; req: AmbientOpen; close: () => void; openPost: (it: Item) => void }) {
  const lib = r.lib!;
  const rootRef = useRef<HTMLDivElement>(null);
  const [prefs, setPrefsRaw] = useState<AmbientPrefs>(() => {
    const p = loadPrefs();
    return { ...p, pace: nearestPace(req.pace) ?? p.pace, photosOnly: req.photosOnly ?? p.photosOnly };
  });
  const setPrefs = (patch: Partial<AmbientPrefs>) =>
    setPrefsRaw((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  // Views: the built-in ones (except Archive) and the reader's own.
  const views: ViewChoice[] = useMemo(() => [...BUILTIN_VIEWS.filter((v) => v.id !== 'archive'), ...lib.views], [lib.views]);
  const [viewId, setViewId] = useState<string>(() => {
    const want = (req.view ?? '').trim().toLowerCase();
    const hit = want ? views.find((v) => v.id.toLowerCase() === want || v.name.toLowerCase() === want) : null;
    return hit?.id ?? (views.some((v) => v.id === r.viewId) ? r.viewId! : 'worth');
  });
  const view = views.find((v) => v.id === viewId) ?? views[0];

  // Posts in the chosen view. Reading in Ambient changes nothing, so this list holds still.
  const viewItems = useMemo(() => {
    const res = applyFilters(lib.items, normalizeSpec(view.spec), { topics: lib.topics, sourceLabels: r.sourceLabels, ai: { rules: lib.aiRules, labels: lib.labels } });
    return res.visible.map((e) => e.item);
  }, [lib.items, lib.topics, lib.aiRules, lib.labels, r.sourceLabels, view]);
  const people = useMemo(() => peopleIn(viewItems), [viewItems]);
  const [person, setPerson] = useState<string | null>(() => {
    const want = (req.person ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!want) return null;
    const hit = people.find((p) => p.key.replace(/^@/, '') === want || p.name.toLowerCase() === want) ?? people.find((p) => p.name.toLowerCase().includes(want) || p.key.includes(want));
    return hit?.key ?? null;
  });

  // The order is fixed when the filters change, so new posts arriving do not reshuffle the screen.
  const [seed, setSeed] = useState(() => (Math.random() * 2 ** 31) | 0);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const slides = useMemo(
    () => buildSlides(viewItems, { photosOnly: prefs.photosOnly, person }, prefs.shuffle ? { seed } : undefined).filter((s) => !gone.has(s.item.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewItems.length, view.id, prefs.photosOnly, prefs.shuffle, person, seed, gone],
  );
  const [index, setIndex] = useState(0);
  const [prev, setPrev] = useState<Slide | null>(null);
  const at = slides.length ? ((index % slides.length) + slides.length) % slides.length : 0;
  const cur = slides[at] ?? null;
  const live = cur ? lib.items.find((i) => i.id === cur.item.id) ?? cur.item : null;

  const [paused, setPaused] = useState(false);
  const [hiddenTab, setHiddenTab] = useState(false);
  const [awake, setAwake] = useState(true);
  const [full, setFull] = useState(false);

  const go = useCallback(
    (step: number) => {
      if (!slides.length) return;
      setPrev(cur);
      setIndex((i) => i + step);
    },
    [slides.length, cur],
  );
  useEffect(() => {
    if (!prev) return;
    const t = setTimeout(() => setPrev(null), FADE_MS + 80);
    return () => clearTimeout(t);
  }, [prev]);

  // Advance on its own unless paused, the tab is hidden, or there is only one slide.
  useEffect(() => {
    if (paused || hiddenTab || slides.length < 2) return;
    const t = setTimeout(() => go(1), prefs.pace * 1000);
    return () => clearTimeout(t);
  }, [at, paused, hiddenTab, prefs.pace, slides.length, go]);
  useEffect(() => {
    const v = () => setHiddenTab(document.hidden);
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, []);

  // Preload the next picture so the crossfade never shows a half-loaded image.
  useEffect(() => {
    const next = slides[(at + 1) % Math.max(1, slides.length)];
    if (next?.image) {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = next.image;
    }
  }, [at, slides]);

  // Controls and cursor fade away when nobody moves.
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();
  const poke = useCallback(() => {
    setAwake(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => clearTimeout(idleTimer.current);
  }, [poke]);

  // Full screen: the desktop app does it natively; a browser needs the request to come from a click.
  const desk = window.auroraDesktop;
  const enterFull = useCallback(() => {
    if (desk?.setFullScreen) {
      desk.setFullScreen(true);
      setFull(true);
      return;
    }
    const el = rootRef.current;
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => undefined);
  }, [desk]);
  const exitFull = useCallback(() => {
    if (desk?.setFullScreen) {
      desk.setFullScreen(false);
      setFull(false);
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [desk]);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    if (req.fullscreen) enterFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const leave = useCallback(() => {
    exitFull();
    close();
  }, [exitFull, close]);

  // While Ambient is up, the app's toasts sit above its controls.
  useEffect(() => {
    document.documentElement.classList.add('ambient-on');
    const opener = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      document.documentElement.classList.remove('ambient-on');
      // Give focus back to whatever opened Ambient (the rail button, the palette's page).
      if (opener && opener !== document.body && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  const save = useCallback(() => {
    if (!live) return;
    void r.changeState([live], { saved: !live.state.saved }, live.state.saved ? 'unsaved a post' : 'saved a post');
  }, [live, r]);
  const hide = useCallback(() => {
    if (!live) return;
    void r.changeState([live], { archived: true }, 'hid a post');
    setGone((g) => new Set([...g, live.id]));
    setPrev(cur);
  }, [live, r, cur]);
  const openIt = useCallback(() => {
    if (!live) return;
    leave();
    if (live.kind === 'article' && live.text) openReader(live.id);
    else openPost(live);
  }, [live, leave, openPost]);
  const original = useCallback(() => {
    if (live?.url && /^https?:\/\//i.test(live.url)) window.open(live.url, '_blank', 'noopener,noreferrer');
  }, [live]);

  // Keys. Captured first so the feed underneath does not also act on them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'SELECT' || t.tagName === 'INPUT') {
        if (e.key === 'Escape') (t as HTMLElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let done = true;
      switch (e.key) {
        case ' ': setPaused((p) => !p); break;
        case 'ArrowRight': go(1); break;
        case 'ArrowLeft': go(-1); break;
        case 'h': hide(); break;
        case 's': save(); break;
        case 'o': case 'Enter': if (t.tagName === 'BUTTON' && e.key === 'Enter') { done = false; break; } openIt(); break;
        case 'O': original(); break;
        case 'f': if (full) exitFull(); else enterFull(); break;
        case 'p': setPrefs({ photosOnly: !prefs.photosOnly }); setIndex(0); break;
        case 'Escape': leave(); break;
        default: done = false;
      }
      if (done) {
        e.preventDefault();
        e.stopPropagation();
        poke();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const now = useClock(prefs.clock);
  const sourceOf = (s: Slide) => r.sourceLabels[s.item.sourceId] ?? '';
  const phoneWidth = typeof window !== 'undefined' && window.innerWidth < 640;

  // Swipe on touch screens.
  const touch = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={rootRef}
      className={`amb${awake ? ' awake' : ''}${paused ? ' paused' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Ambient"
      tabIndex={-1}
      onMouseMove={poke}
      onPointerDown={poke}
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = touch.current;
        touch.current = null;
        if (!s) return;
        const dx = e.changedTouches[0].clientX - s.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.changedTouches[0].clientY - s.y)) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="amb-stage" onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.amb-slide')) { if (awake) setPaused((p) => !p); poke(); } }}>
        {prev && prev.item.id !== cur?.item.id && <SlideView key={`out:${prev.item.id}`} s={prev} source={sourceOf(prev)} pace={prefs.pace} state="out" />}
        {cur && <SlideView key={`in:${cur.item.id}:${at}`} s={cur} source={sourceOf(cur)} pace={prefs.pace} state="in" />}
        {!cur && (
          <div className="amb-empty">
            <p className="amb-kicker">Ambient</p>
            <h2>Nothing to show here yet.</h2>
            <p>{person || prefs.photosOnly ? 'The filters leave no posts in this view.' : `${view.name} has no posts with something to show.`}</p>
            <div className="amb-empty-actions">
              {(person || prefs.photosOnly) && <button className="amb-btn" onClick={() => { setPerson(null); setPrefs({ photosOnly: false }); }}>Clear filters</button>}
              {view.id !== 'everything' && <button className="amb-btn" onClick={() => setViewId('everything')}>Show Everything</button>}
              <button className="amb-btn ghost" onClick={leave}>Back to the feed</button>
            </div>
          </div>
        )}
      </div>

      {prefs.clock && (
        <div className="amb-clock" aria-hidden>
          <b>{now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</b>
          <span>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        </div>
      )}

      {cur && slides.length > 1 && (
        <div className="amb-progress" aria-hidden>
          <b key={`${cur.item.id}:${at}:${prefs.pace}`} style={{ animationDuration: `${prefs.pace}s` }} />
        </div>
      )}
      {paused && <div className="amb-paused" aria-hidden><Icon name="pause" size={14} /> Paused</div>}

      <div className="amb-top">
        <span className="amb-count" aria-live="polite">{slides.length ? `${at + 1} / ${slides.length}` : ''}</span>
        {!full && <button className="amb-ico" onClick={enterFull} aria-label="Full screen (f)" title="Full screen  f"><Icon name="expand" size={17} /></button>}
        <button className="amb-ico" onClick={leave} aria-label="Leave Ambient (Esc)" title="Leave  Esc"><Icon name="x" size={18} /></button>
      </div>

      <div className="amb-bar" role="toolbar" aria-label="Ambient controls">
        <div className="amb-group amb-g-play">
          <button className="amb-ico" onClick={() => go(-1)} aria-label="Previous (left arrow)" disabled={slides.length < 2}><Icon name="back" size={18} /></button>
          <button className="amb-ico amb-play" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play (space)' : 'Pause (space)'}><Icon name={paused ? 'play' : 'pause'} size={17} /></button>
          <button className="amb-ico amb-next" onClick={() => go(1)} aria-label="Next (right arrow)" disabled={slides.length < 2}><Icon name="back" size={18} /></button>
        </div>
        <div className="amb-group amb-g-pace amb-seg" role="radiogroup" aria-label="Pace">
          {PACES.map((p) => (
            <button key={p} role="radio" aria-checked={prefs.pace === p} className={prefs.pace === p ? 'on' : ''} onClick={() => setPrefs({ pace: p })}>{p}s</button>
          ))}
        </div>
        <div className="amb-group amb-g-chips">
          <button className={`amb-chip${prefs.shuffle ? ' on' : ''}`} aria-pressed={prefs.shuffle} onClick={() => { setPrefs({ shuffle: !prefs.shuffle }); setSeed((Math.random() * 2 ** 31) | 0); setIndex(0); }}>Shuffle</button>
          <button className={`amb-chip${prefs.photosOnly ? ' on' : ''}`} aria-pressed={prefs.photosOnly} onClick={() => { setPrefs({ photosOnly: !prefs.photosOnly }); setIndex(0); }}><Icon name="image" size={14} /> Photos</button>
          {!phoneWidth && (
            <button className={`amb-chip${prefs.clock ? ' on' : ''}`} aria-pressed={prefs.clock} onClick={() => setPrefs({ clock: !prefs.clock })}>Clock</button>
          )}
        </div>
        <div className="amb-group amb-g-pick">
          <label className="amb-select">
            <span className="sr-only">View</span>
            <select value={view.id} onChange={(e) => { setViewId(e.target.value); setPerson(null); setIndex(0); }}>
              {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="amb-select">
            <span className="sr-only">Person</span>
            <select value={person ?? ''} onChange={(e) => { setPerson(e.target.value || null); setIndex(0); }}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.count})</option>)}
            </select>
          </label>
        </div>
        <div className="amb-group amb-g-act">
          <button className="amb-ico" onClick={save} disabled={!live} aria-label={live?.state.saved ? 'Unsave (s)' : 'Save (s)'} aria-pressed={!!live?.state.saved}><Icon name={live?.state.saved ? 'bookmarkFill' : 'bookmark'} size={17} /></button>
          <button className="amb-ico" onClick={openIt} disabled={!live} aria-label="Open in Aurora (o)"><Icon name="external" size={17} /></button>
          <button className="amb-ico" onClick={hide} disabled={!live} aria-label="Hide from the feed (h)"><Icon name="eyeOff" size={17} /></button>
        </div>
      </div>
    </div>
  );
}
