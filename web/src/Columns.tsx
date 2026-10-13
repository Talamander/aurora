// Columns: several views side by side, each scrolling on its own, the way a tiling window manager
// lays out windows. A column is a profile plus something to show (a view, a topic, a source, a
// search, Read later or a collection). The layout lives in the `ui.columns` setting, so the web
// app and the desktop app share it.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { applyFilters, DEFAULT_SPEC, normalizeSpec, type Evaluation, type FilterResult } from '../../core/filter.ts';
import { ALL_PROFILE, scopeLibrary } from '../../core/profiles.ts';
import type { FilterSpec, Item, Library } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { READ_LATER } from './longform.ts';
import { BUILTIN_VIEWS, type Reader } from './state.ts';
import { itemIndex } from './itemIndex.ts';
import { ThreadsContext, useThreadGroups, type ThreadsValue } from './threads.ts';
import { collapseThreads, threadFor } from '../../core/threads.ts';
import './columns.css';

export type ColumnKind = 'view' | 'topic' | 'source' | 'search' | 'later' | 'collection';
export interface ColumnDef {
  id: string;
  profile: string;
  kind: ColumnKind;
  ref: string;
  wide?: boolean;
}
export interface ColumnsLayout {
  on: boolean;
  cols: ColumnDef[];
}

const SETTING = 'ui.columns';
const MAX_COLUMNS = 8;
const PAGE = 40;

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * A first layout: Worth reading for All and for up to three profiles. Without profiles, the
 * busiest topic or source and whichever of Saved and Read later has posts fill the row.
 */
function starterColumns(lib: Library | null): ColumnDef[] {
  const all = ALL_PROFILE;
  const cols: ColumnDef[] = [{ id: newId(), profile: all, kind: 'view', ref: 'worth' }];
  for (const p of (lib?.profiles ?? []).slice(0, 3)) cols.push({ id: newId(), profile: p.id, kind: 'view', ref: 'worth' });
  if (cols.length >= 3 || !lib) return cols;
  const items = lib.items;
  const topic = lib.topics[0];
  const busiest = Object.entries(items.reduce<Record<string, number>>((m, i) => ((m[i.sourceId] = (m[i.sourceId] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topic) cols.push({ id: newId(), profile: all, kind: 'topic', ref: topic.id });
  else if (busiest) cols.push({ id: newId(), profile: all, kind: 'source', ref: busiest });
  if (items.some((i) => i.state.collections.includes(READ_LATER))) cols.push({ id: newId(), profile: all, kind: 'later', ref: '' });
  else if (items.some((i) => i.state.saved)) cols.push({ id: newId(), profile: all, kind: 'view', ref: 'saved' });
  if (cols.length < 3) cols.push({ id: newId(), profile: all, kind: 'view', ref: 'everything' });
  return cols;
}

function validLayout(v: unknown): ColumnsLayout | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<ColumnsLayout>;
  if (!Array.isArray(o.cols)) return null;
  const kinds: ColumnKind[] = ['view', 'topic', 'source', 'search', 'later', 'collection'];
  const cols = o.cols
    .filter((c): c is ColumnDef => !!c && typeof c.id === 'string' && typeof c.profile === 'string' && kinds.includes(c.kind) && typeof c.ref === 'string')
    .slice(0, MAX_COLUMNS)
    .map((c) => ({ id: c.id, profile: c.profile, kind: c.kind, ref: c.ref.slice(0, 200), wide: !!c.wide }));
  return { on: !!o.on, cols };
}

/** The layout and whether Columns is on, loaded from and saved to the server. */
export function useColumnsLayout(lib: Library | null) {
  const [layout, setLayoutRaw] = useState<ColumnsLayout>({ on: false, cols: [] });
  const loaded = useRef(false);
  useEffect(() => {
    api.getSetting<ColumnsLayout>(SETTING).then((x) => {
      const v = validLayout(x.value);
      if (v) setLayoutRaw(v);
      loaded.current = true;
    }, () => { loaded.current = true; });
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setLayout = useCallback((next: ColumnsLayout | ((l: ColumnsLayout) => ColumnsLayout)) => {
    setLayoutRaw((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void api.putSetting(SETTING, v).catch(() => {}), 400);
      return v;
    });
  }, []);
  const toggle = useCallback((on?: boolean) => {
    setLayout((l) => {
      const want = on ?? !l.on;
      return { on: want, cols: want && !l.cols.length ? starterColumns(lib) : l.cols };
    });
  }, [setLayout, lib]);
  return useMemo(() => ({ layout, setLayout, toggle }), [layout, setLayout, toggle]);
}

interface Resolved {
  spec: FilterSpec;
  name: string;
}

function resolve(col: ColumnDef, lib: Library): Resolved | null {
  const base = { ...DEFAULT_SPEC };
  switch (col.kind) {
    case 'view': {
      const v = BUILTIN_VIEWS.find((x) => x.id === col.ref) ?? lib.views.find((x) => x.id === col.ref);
      return v ? { spec: normalizeSpec(v.spec), name: v.name } : null;
    }
    case 'topic': {
      const t = lib.topics.find((x) => x.id === col.ref);
      return t ? { spec: normalizeSpec({ ...base, topics: [t.id] }), name: t.name } : null;
    }
    case 'source': {
      const s = lib.sources.find((x) => x.id === col.ref);
      return s ? { spec: normalizeSpec({ ...base, sources: [s.id] }), name: s.label } : null;
    }
    case 'search':
      return col.ref.trim() ? { spec: normalizeSpec({ ...base, query: col.ref }), name: `“${col.ref}”` } : null;
    case 'later':
      return { spec: normalizeSpec({ ...base, collection: READ_LATER, archived: 'any' }), name: 'Read later' };
    case 'collection':
      return lib.collections.includes(col.ref) ? { spec: normalizeSpec({ ...base, collection: col.ref, archived: 'any' }), name: col.ref } : null;
  }
}

export type ColumnPostRenderer = (ev: Evaluation, markRead: (ids: string[]) => void, full: boolean) => React.ReactNode;

export function Columns({
  r, layout, setLayout, exit, renderPost, postKey, keysRef,
}: {
  r: Reader;
  layout: ColumnsLayout;
  setLayout: (next: ColumnsLayout | ((l: ColumnsLayout) => ColumnsLayout)) => void;
  exit: () => void;
  renderPost: ColumnPostRenderer;
  /** Runs a post shortcut (s, e, l, o, r, v, w, i...) on an item. True when the key was one. */
  postKey: (key: string, item: Item) => boolean;
  keysRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
}) {
  const raw = r.rawLib!;
  const cols = layout.cols;
  const [focus, setFocus] = useState(0);
  const fi = Math.max(0, Math.min(cols.length - 1, focus));
  const [adding, setAdding] = useState(false);
  const lists = useRef(new Map<string, Evaluation[]>());
  const picks = useRef(new Map<string, string>());
  const wrapRef = useRef<HTMLDivElement>(null);

  // One scoped library per profile in use, shared by that profile's columns.
  const scoped = useMemo(() => {
    const m = new Map<string, Library>();
    for (const c of cols) if (!m.has(c.profile)) m.set(c.profile, scopeLibrary(raw, c.profile));
    return m;
  }, [raw, cols]);

  // Posts read here stay in their column until the layout changes, so lists do not jump.
  const [keepRead, setKeepRead] = useState<ReadonlySet<string>>(() => new Set());
  // Threads collapse to one card here too; reading the card reads the whole thread.
  const threads = useThreadGroups(raw.items);
  const rawIndex = useMemo(() => itemIndex(raw.items), [raw.items]);
  const threadsValue = useMemo<ThreadsValue | null>(() => (threads ? { g: threads, get: (id) => rawIndex.get(id) } : null), [threads, rawIndex]);
  const markRead = useCallback((items: Item[]) => {
    const all = threads ? items.flatMap((i) => (threadFor(threads, i.id) ?? [i.id]).map((id) => (id === i.id ? i : rawIndex.get(id))).filter((x): x is Item => !!x)) : items;
    const unread = [...new Map(all.map((i) => [i.id, i])).values()].filter((i) => !i.state.read);
    if (!unread.length) return;
    setKeepRead((k) => new Set([...k, ...unread.map((i) => i.id)]));
    void r.changeState(unread, { read: true }, 'marked read', { silent: true });
  }, [r, threads, rawIndex]);

  const update = useCallback((fn: (cs: ColumnDef[]) => ColumnDef[]) => setLayout((l) => ({ ...l, cols: fn(l.cols) })), [setLayout]);
  const moveCol = useCallback((from: number, to: number) => {
    if (to < 0 || to >= cols.length || from === to) return;
    update((cs) => {
      const next = [...cs];
      const [c] = next.splice(from, 1);
      next.splice(to, 0, c);
      return next;
    });
    setFocus(to);
  }, [cols.length, update]);
  const removeCol = useCallback((i: number) => {
    const gone = cols[i];
    if (!gone) return;
    update((cs) => cs.filter((c) => c.id !== gone.id));
    setFocus((f) => Math.max(0, f > i ? f - 1 : Math.min(f, cols.length - 2)));
    r.toast('Closed the column', { undo: () => update((cs) => [...cs.slice(0, i), gone, ...cs.slice(i)].slice(0, MAX_COLUMNS)) });
  }, [cols, update, r]);

  const focusCol = useCallback((i: number) => {
    const c = cols[i];
    if (!c) return;
    setFocus(i);
    r.setSelectedId(picks.current.get(c.id) ?? null);
    const el = document.getElementById(`col-${c.id}`);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    el?.querySelector<HTMLElement>('.col-scroll')?.focus({ preventScroll: true });
  }, [cols, r]);

  const step = useCallback((delta: number) => {
    const c = cols[fi];
    const list = c ? lists.current.get(c.id) ?? [] : [];
    if (!c || !list.length) return;
    const idx = list.findIndex((e) => e.item.id === r.selectedId);
    const next = list[Math.max(0, Math.min(list.length - 1, idx === -1 ? 0 : idx + delta))];
    picks.current.set(c.id, next.item.id);
    r.setSelectedId(next.item.id);
    window.dispatchEvent(new CustomEvent('aurora:col-reveal', { detail: { col: c.id, item: next.item.id } }));
  }, [cols, fi, r]);

  keysRef.current = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft': case 'H': focusCol(Math.max(0, fi - 1)); return true;
      case 'ArrowRight': case 'L': focusCol(Math.min(cols.length - 1, fi + 1)); return true;
      case '[': moveCol(fi, fi - 1); return true;
      case ']': moveCol(fi, fi + 1); return true;
      case 'q': removeCol(fi); return true;
      case 'n': setAdding(true); return true;
      case 'j': case 'ArrowDown': step(1); return true;
      case 'k': case 'ArrowUp': step(-1); return true;
    }
    if (/^[1-9]$/.test(e.key)) {
      focusCol(Number(e.key) - 1);
      return true;
    }
    const c = cols[fi];
    const item = c && r.selectedId ? lists.current.get(c.id)?.find((x) => x.item.id === r.selectedId)?.item : undefined;
    if (!item) return false;
    if (e.key === 'Enter' || e.key === 'o' || e.key === 'r') markRead([item]);
    return postKey(e.key, item);
  };
  useEffect(() => () => { keysRef.current = null; }, [keysRef]);

  // Drag a column by its header onto another to move it there.
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null);
  const onDrop = (target: string, after: boolean) => {
    if (!drag || drag.id === target) return setDrag(null);
    const from = cols.findIndex((c) => c.id === drag.id);
    let to = cols.findIndex((c) => c.id === target);
    if (from < 0 || to < 0) return setDrag(null);
    if (after) to += 1;
    if (from < to) to -= 1;
    moveCol(from, to);
    setDrag(null);
  };

  const scopeFor = useCallback((p: string) => scoped.get(p) ?? scopeLibrary(raw, p), [scoped, raw]);
  const profileName = (id: string) => (id === ALL_PROFILE ? 'All' : raw.profiles?.find((p) => p.id === id)?.name ?? 'Missing profile');
  const profileColor = (id: string) => (id === ALL_PROFILE ? undefined : raw.profiles?.find((p) => p.id === id)?.color);

  return (
    <ThreadsContext.Provider value={threadsValue}>
    <main className="columns" id="feed" tabIndex={-1} aria-label="Columns">
      <header className="columns-bar">
        <h1 className="columns-title">Columns <span className="columns-n">{cols.length}</span></h1>
        <p className="columns-hint" aria-hidden>
          <kbd>←</kbd><kbd>→</kbd> column · <kbd>j</kbd><kbd>k</kbd> post · <kbd>[</kbd><kbd>]</kbd> move · <kbd>q</kbd> close
        </p>
        <button className="btn small" onClick={() => setAdding(true)} disabled={cols.length >= MAX_COLUMNS}><Icon name="plus" size={15} /> Add column</button>
        <button className="btn small ghost" onClick={exit} title="Back to one feed (c)">One feed</button>
      </header>
      <div className="columns-row" ref={wrapRef}>
        {cols.map((c, i) => {
          const lib = scoped.get(c.profile)!;
          return (
            <Column
              key={c.id} col={c} index={i} count={cols.length} lib={lib} focused={i === fi} keepRead={keepRead}
              profileName={profileName(c.profile)} profileColor={profileColor(c.profile)} multiProfile={!!raw.profiles?.length}
              onFocus={() => { if (i !== fi) { setFocus(i); } }}
              onList={(list) => lists.current.set(c.id, list)}
              onSelect={(id) => picks.current.set(c.id, id)}
              renderPost={(ev) => renderPost(ev, (ids) => markRead(ids.map((id) => ev.item.id === id ? ev.item : rawIndex.get(id)).filter((x): x is Item => !!x)), !!c.wide)}
              move={(d) => moveCol(i, i + d)} remove={() => removeCol(i)}
              toggleWide={() => update((cs) => cs.map((x) => (x.id === c.id ? { ...x, wide: !x.wide } : x)))}
              drag={drag} setDrag={setDrag} onDrop={onDrop}
            />
          );
        })}
        {(adding || !cols.length) && (
          <AddColumn
            raw={raw} scoped={scopeFor} defaultProfile={r.profileId}
            cancel={cols.length ? () => setAdding(false) : undefined}
            add={(c) => { update((cs) => [...cs, c].slice(0, MAX_COLUMNS)); setAdding(false); setFocus(cols.length); }}
          />
        )}
      </div>
    </main>
    </ThreadsContext.Provider>
  );
}

function Column({
  col, index, count, lib, focused, keepRead, profileName, profileColor, multiProfile, onFocus, onList, onSelect, renderPost, move, remove, toggleWide, drag, setDrag, onDrop,
}: {
  col: ColumnDef; index: number; count: number; lib: Library; focused: boolean; keepRead: ReadonlySet<string>;
  profileName: string; profileColor?: string; multiProfile: boolean;
  onFocus: () => void; onList: (list: Evaluation[]) => void; onSelect: (id: string) => void;
  renderPost: (ev: Evaluation) => React.ReactNode; move: (d: number) => void; remove: () => void; toggleWide: () => void;
  drag: { id: string; over?: string; after?: boolean } | null;
  setDrag: (d: { id: string; over?: string; after?: boolean } | null) => void;
  onDrop: (target: string, after: boolean) => void;
}) {
  const def = useMemo(() => resolve(col, lib), [col, lib]);
  const specKey = def ? JSON.stringify(def.spec) : '';
  const sourceLabels = useMemo(() => Object.fromEntries(lib.sources.map((s) => [s.id, s.label])), [lib.sources]);
  const [res, setRes] = useState<FilterResult | null>(null);
  const prev = useRef<FilterResult | null>(null);
  // Filtering a big library takes a moment per column, so columns take turns instead of all
  // blocking the same frame. Small changes (a post marked read) re-check only the changed posts.
  useEffect(() => {
    if (!def) return;
    const t = setTimeout(() => {
      const out = applyFilters(lib.items, def.spec, { topics: lib.topics, sourceLabels, keepRead, ai: { rules: lib.aiRules, labels: lib.labels } }, prev.current);
      prev.current = out;
      setRes(out);
    }, prev.current ? 0 : index * 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, specKey, sourceLabels, keepRead]);
  const threads = useContext(ThreadsContext)?.g ?? null;
  const list = useMemo(() => (res ? (threads ? collapseThreads(res.visible, threads) : res.visible) : []), [res, threads]);
  useEffect(() => {
    onList(list);
  }, [list, onList]);

  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLimit(PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [specKey]);
  useEffect(() => {
    const el = moreRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
    }, { root, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.length, limit]);

  // Keyboard selection: load far enough, then bring the post into view inside this column.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ col: string; item: string }>).detail;
      if (d.col !== col.id) return;
      const idx = list.findIndex((x) => x.item.id === d.item);
      if (idx >= limit - 2) setLimit(idx + PAGE);
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(d.item)}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        el?.focus({ preventScroll: true });
      });
    };
    window.addEventListener('aurora:col-reveal', on);
    return () => window.removeEventListener('aurora:col-reveal', on);
  }, [col.id, list, limit]);

  const name = def?.name ?? 'Gone';
  const dropClass = drag && drag.over === col.id && drag.id !== col.id ? (drag.after ? 'drop-after' : 'drop-before') : '';
  const unread = useMemo(() => list.reduce((n, e) => n + (e.item.state.read ? 0 : 1), 0), [list]);

  return (
    <section
      id={`col-${col.id}`}
      className={`col ${focused ? 'focused' : ''} ${col.wide ? 'wide' : ''} ${dropClass} ${drag?.id === col.id ? 'dragging' : ''}`}
      aria-label={`${name}${multiProfile ? `, ${profileName}` : ''}`}
      style={profileColor ? ({ ['--col-pc' as string]: profileColor } as React.CSSProperties) : undefined}
      onMouseDown={onFocus}
      onFocusCapture={(e) => {
        onFocus();
        const post = (e.target as HTMLElement).closest<HTMLElement>('.post[data-id]');
        if (post?.dataset.id) onSelect(post.dataset.id);
      }}
      onClickCapture={(e) => {
        const post = (e.target as HTMLElement).closest<HTMLElement>('.post[data-id]');
        if (post?.dataset.id) onSelect(post.dataset.id);
      }}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        const after = e.clientX > box.left + box.width / 2;
        if (drag.over !== col.id || drag.after !== after) setDrag({ ...drag, over: col.id, after });
      }}
      onDrop={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        onDrop(col.id, e.clientX > box.left + box.width / 2);
      }}
    >
      <header
        className="col-head"
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); setDrag({ id: col.id }); }}
        onDragEnd={() => setDrag(null)}
        title="Drag to move"
      >
        <span className="col-grip" aria-hidden />
        <div className="col-titles">
          <h2 className="col-name">{name}</h2>
          <p className="col-sub">
            {multiProfile && <span className="col-prof"><span className="col-dot" aria-hidden />{profileName}</span>}
            <span>{res ? `${list.length.toLocaleString()}${unread && unread !== list.length ? ` · ${unread.toLocaleString()} new` : ''}` : '…'}</span>
          </p>
        </div>
        <div className="col-tools">
          <button className="icon-btn small" onClick={() => move(-1)} disabled={index === 0} aria-label={`Move ${name} left`} title="Move left ([)"><Icon name="back" size={15} /></button>
          <button className="icon-btn small col-right" onClick={() => move(1)} disabled={index === count - 1} aria-label={`Move ${name} right`} title="Move right (])"><Icon name="back" size={15} /></button>
          <button className={`icon-btn small ${col.wide ? 'on' : ''}`} onClick={toggleWide} aria-pressed={!!col.wide} aria-label={`Make ${name} wide`} title="Wide"><Icon name="expand" size={15} /></button>
          <button className="icon-btn small" onClick={remove} aria-label={`Close ${name}`} title="Close (q)"><Icon name="x" size={15} /></button>
        </div>
      </header>
      <div className="col-scroll" ref={scrollRef} tabIndex={-1} aria-label={`Posts in ${name}`}>
        {!def ? (
          <div className="col-empty"><p>This column’s {col.kind} no longer exists.</p><button className="btn small" onClick={remove}>Close it</button></div>
        ) : !res ? (
          <div className="col-empty" aria-busy="true"><span className="spin" aria-hidden /> Filtering…</div>
        ) : !list.length ? (
          <div className="col-empty"><p className="col-empty-title">Nothing here.</p><p>{emptyLine(col)}</p></div>
        ) : (
          <div className="col-posts">
            {list.slice(0, limit).map((ev) => renderPost(ev))}
            {list.length > limit ? <div ref={moreRef} className="col-more" aria-hidden /> : <p className="col-end">End of {name}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function emptyLine(col: ColumnDef): string {
  if (col.kind === 'later') return 'Press l on a post to keep it here for later.';
  if (col.kind === 'view' && col.ref === 'worth') return 'You are caught up.';
  if (col.kind === 'view' && col.ref === 'saved') return 'Press s on a post to save it here.';
  if (col.kind === 'search') return 'Nothing matches this search yet. New posts that do will show up here.';
  return 'No posts match this column yet.';
}

function AddColumn({ raw, scoped, defaultProfile, add, cancel }: {
  raw: Library; scoped: (profile: string) => Library; defaultProfile: string; add: (c: ColumnDef) => void; cancel?: () => void;
}) {
  const [profile, setProfile] = useState(defaultProfile);
  const lib = useMemo(() => scoped(profile), [scoped, profile]);
  const [what, setWhat] = useState('view:worth');
  const [query, setQuery] = useState('');
  const selRef = useRef<HTMLSelectElement>(null);
  useEffect(() => selRef.current?.focus(), []);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const [kind, ...rest] = what.split(':') as [ColumnKind, ...string[]];
    const ref = kind === 'search' ? query.trim() : rest.join(':');
    if (kind === 'search' && !ref) return;
    add({ id: newId(), profile, kind, ref });
  };
  return (
    <form className="col col-add" onSubmit={submit} aria-label="Add a column">
      <h2 className="col-name">Add a column</h2>
      <label className="col-field">
        <span>Profile</span>
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value={ALL_PROFILE}>All</option>
          {(raw.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="col-field">
        <span>Show</span>
        <select ref={selRef} value={what} onChange={(e) => setWhat(e.target.value)}>
          <optgroup label="Views">
            {BUILTIN_VIEWS.map((v) => <option key={v.id} value={`view:${v.id}`}>{v.name}</option>)}
            {lib.views.map((v) => <option key={v.id} value={`view:${v.id}`}>{v.name}</option>)}
          </optgroup>
          <optgroup label="Reading">
            <option value="later:">Read later</option>
            <option value="search:">A search…</option>
          </optgroup>
          {lib.topics.length > 0 && <optgroup label="Topics">{lib.topics.map((t) => <option key={t.id} value={`topic:${t.id}`}>{t.name}</option>)}</optgroup>}
          {lib.sources.length > 0 && <optgroup label="Sources">{lib.sources.map((s) => <option key={s.id} value={`source:${s.id}`}>{s.label}</option>)}</optgroup>}
          {lib.collections.length > 0 && <optgroup label="Collections">{lib.collections.map((c) => <option key={c} value={`collection:${c}`}>{c}</option>)}</optgroup>}
        </select>
      </label>
      {what.startsWith('search:') && (
        <label className="col-field">
          <span>Search for</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='e.g. "sqlite" -giveaway' maxLength={200} spellCheck={false} />
        </label>
      )}
      <div className="col-add-actions">
        <button className="btn small primary" type="submit" disabled={what.startsWith('search:') && !query.trim()}>Add</button>
        {cancel && <button className="btn small ghost" type="button" onClick={cancel}>Cancel</button>}
      </div>
      <p className="col-add-hint">Each column keeps its own filters and scrolls on its own. Up to {MAX_COLUMNS}.</p>
    </form>
  );
}
