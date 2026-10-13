// Quick look: a small Spotlight-style view of what is worth reading right now. The desktop app
// shows it in its own frameless window (desktop/main.cjs, summoned by a shortcut, `aurora --quick`
// or aurora://quick); in a browser it is /?quick=1, a page that fits a small popup.
//
// It never boots the full app: one small request for the top posts (/api/quick), one for alert
// hits, and the look settings to paint the theme. It makes no AI call. A question typed into the
// Ask box goes to the main window's agent panel (desktop IPC, or the last-used Aurora tab), and
// opening a post hands it to the main window's reader the same way.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Platform } from '../../core/types.ts';
import { api, type AlertHitView } from './api.ts';
import { agoText } from './format.ts';
import { Icon } from './icons.tsx';
import { quickBus, type NowPlaying, type QuickBus } from './quickBus.ts';
import { clean as cleanThemes } from './studioThemes.ts';
import { registerSaved } from './themeStudio.ts';
import { applyLook, setDesktopPreset, THEME_PRESETS, type Look } from './themes.ts';
import './quick.css';

interface QuickItem {
  id: string;
  title: string;
  author: string;
  avatar: string | null;
  source: string;
  platform: Platform;
  url: string | null;
  publishedAt: string;
  saved: boolean;
}

interface QuickData {
  profile: { id: string; name: string; color: string; look: Look } | null;
  worth: number;
  items: QuickItem[];
}

interface Row {
  key: string;
  id: string;
  title: string;
  author: string;
  source: string;
  url: string | null;
  publishedAt: string;
  saved: boolean;
  /** The alert's name, for alert hits. */
  alert?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

const KEYS: [string[], string][] = [[['j', 'k'], 'move'], [['↵'], 'read'], [['o'], 'original'], [['s'], 'save'], [['e'], 'hide'], [['/'], 'ask'], [['esc'], 'close']];

const desk = () => window.auroraDesktop?.quick;

/** The same theme the main window paints: light or dark, the app look or the profile's, the Omarchy desktop preset. */
async function paintTheme(profileLook: Look) {
  let mode: 'dark' | 'light' = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  try {
    const t = localStorage.getItem('sr.theme');
    if (t === 'dark' || t === 'light') mode = t;
  } catch {
    /* private window */
  }
  const [look, themes, desktop] = await Promise.all([
    api.getSetting<Look>('ui.look').catch(() => null),
    api.getSetting<unknown>('ui.themes').catch(() => null),
    api.desktopTheme().catch(() => null),
  ]);
  registerSaved(cleanThemes(themes?.value));
  setDesktopPreset(desktop?.theme ?? null);
  const shown = profileLook ?? look?.value ?? null;
  if (shown?.preset === 'desktop' && desktop?.theme) mode = desktop.theme.mode;
  const preset = shown?.preset ? THEME_PRESETS[shown.preset] : undefined;
  if (preset && !preset.light) mode = 'dark';
  document.documentElement.dataset.theme = mode;
  applyLook(shown, mode);
}

export function QuickLook() {
  const [data, setData] = useState<QuickData | null>(null);
  const [hits, setHits] = useState<AlertHitView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [question, setQuestion] = useState('');
  const undo = useRef<{ id: string; patch: { saved?: boolean; archived?: boolean; read?: boolean } } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const bus = useRef<QuickBus | null>(null);
  const lastLoad = useRef(0);
  const profileLook = useRef<Look>(null);

  const load = useCallback(async (reset: boolean) => {
    lastLoad.current = Date.now();
    try {
      const [d, h] = await Promise.all([
        getJson<QuickData>('/api/quick'),
        getJson<{ hits: AlertHitView[] }>('/api/alerts/hits').catch(() => ({ hits: [] as AlertHitView[] })),
      ]);
      setData(d);
      setHits((h.hits ?? []).filter((x) => !x.seen && x.item).slice(0, 3));
      setError(null);
      setGone(new Set());
      if (reset) setSel(0);
      profileLook.current = d.profile?.look ?? null;
      void paintTheme(profileLook.current);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    document.title = 'Aurora quick look';
    void load(true);
    bus.current = quickBus(setNow);
    // The desktop shell says when the window is shown again; a browser tab refreshes on focus.
    window.auroraDesktop?.onCommand((cmd) => {
      if (cmd !== 'quick') return;
      setQuestion('');
      setFlash(null);
      void load(true);
      listRef.current?.focus();
    });
    const onFocus = () => {
      if (Date.now() - lastLoad.current > 1500) void load(false);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'sr.theme') void paintTheme(profileLook.current);
    };
    addEventListener('focus', onFocus);
    addEventListener('storage', onStorage);
    listRef.current?.focus();
    return () => {
      removeEventListener('focus', onFocus);
      removeEventListener('storage', onStorage);
      bus.current?.close();
    };
  }, [load]);

  const rows: Row[] = useMemo(() => {
    const posts: Row[] = (data?.items ?? []).map((it) => ({ key: `p:${it.id}`, id: it.id, title: it.title, author: it.author, source: it.source, url: it.url, publishedAt: it.publishedAt, saved: it.saved }));
    const alerts: Row[] = hits.map((h) => ({
      key: `a:${h.id}`,
      id: h.itemId,
      title: (h.item?.text ?? '').replace(/\s+/g, ' ').slice(0, 220) || '(no text)',
      author: h.item?.author ?? '',
      source: h.item?.platform ?? '',
      url: h.item?.url ?? null,
      publishedAt: h.item?.publishedAt ?? h.at,
      saved: false,
      alert: h.alertName,
    }));
    return [...posts, ...alerts].filter((r) => !gone.has(r.key));
  }, [data, hits, gone]);
  const postCount = rows.filter((r) => !r.alert).length;
  const cur = rows[Math.min(sel, rows.length - 1)] ?? null;

  useEffect(() => {
    if (sel > rows.length - 1) setSel(Math.max(0, rows.length - 1));
  }, [rows.length, sel]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const hide = useCallback(() => {
    const q = desk();
    if (q) q.hide();
    else window.close(); // only closes a popup the page opened; a normal tab stays
  }, []);

  const patch = useCallback(async (row: Row, p: { saved?: boolean; archived?: boolean; read?: boolean }, undoPatch: typeof p, msg: string) => {
    try {
      await api.setState([row.id], p);
      undo.current = { id: row.id, patch: undoPatch };
      setFlash(msg);
    } catch (e) {
      setFlash((e as Error).message);
    }
  }, []);

  const open = useCallback(async (row: Row) => {
    const q = desk();
    if (q) return q.openPost(row.id);
    const tab = await bus.current?.findMain();
    if (tab) {
      bus.current?.open(tab, row.id);
      setFlash('Opened in your Aurora tab');
    } else {
      window.open(`/?post=${encodeURIComponent(row.id)}`, '_blank', 'noopener');
    }
    window.close();
  }, []);

  const original = useCallback((row: Row) => {
    if (!row.url) return setFlash('This post has no link');
    window.open(row.url, '_blank', 'noopener,noreferrer');
    // Like `aurora pick`: opening the original counts as reading it.
    void api.setState([row.id], { read: true }).catch(() => {});
    if (!row.alert) setGone((g) => new Set(g).add(row.key));
  }, []);

  const save = useCallback(
    (row: Row) => {
      const next = !row.saved;
      setData((d) => (d ? { ...d, items: d.items.map((it) => (it.id === row.id ? { ...it, saved: next } : it)) } : d));
      void patch(row, { saved: next }, { saved: !next }, next ? 'Saved · u to undo' : 'Unsaved · u to undo');
    },
    [patch],
  );

  const hideRow = useCallback(
    (row: Row) => {
      setGone((g) => new Set(g).add(row.key));
      void patch(row, { archived: true }, { archived: false }, 'Hidden · u to undo');
    },
    [patch],
  );

  const doUndo = useCallback(async () => {
    const u = undo.current;
    if (!u) return;
    undo.current = null;
    try {
      await api.setState([u.id], u.patch);
      setFlash('Undone');
      void load(false);
    } catch (e) {
      setFlash((e as Error).message);
    }
  }, [load]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text) return;
    const q = desk();
    setQuestion('');
    if (q) return q.ask(text);
    const tab = await bus.current?.findMain();
    if (tab) {
      bus.current?.ask(tab, text);
      setFlash('Asked in your Aurora tab');
    } else {
      window.open(`/?ask=${encodeURIComponent(text.slice(0, 2000))}`, '_blank', 'noopener');
    }
    window.close();
  }, [question]);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === 'j' || k === 'ArrowDown') setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (k === 'k' || k === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
    else if (k === 'Home') setSel(0);
    else if (k === 'End') setSel(rows.length - 1);
    else if (k === 'Enter' && cur) void open(cur);
    else if (k === 'o' && cur) original(cur);
    else if (k === 's' && cur) save(cur);
    else if (k === 'e' && cur) hideRow(cur);
    else if (k === 'u') void doUndo();
    else if (k === 'p' && now) bus.current?.toggleListen();
    else if (k === '/' || k === 'a') askRef.current?.focus();
    else if (k === 'Escape') hide();
    else handled = false;
    if (handled) e.preventDefault();
  };

  const onAskKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void ask();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (question) setQuestion('');
      else listRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      listRef.current?.focus();
    }
  };

  const profile = data?.profile;
  return (
    <div className="ql" onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && hide()}>
      <header className="ql-head">
        <span className="ql-mark" aria-hidden />
        <h1>Quick look</h1>
        {profile && (
          <span className="ql-profile" style={{ ['--pc' as string]: profile.color }}>
            <span className="ql-dot" aria-hidden />
            {profile.name}
          </span>
        )}
        <span className="ql-count">{data ? `${data.worth.toLocaleString()} worth reading` : ''}</span>
      </header>

      <label className="ql-ask">
        <Icon name="sparkle" size={16} />
        <input
          ref={askRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onAskKey}
          maxLength={2000}
          placeholder="Ask Aurora…"
          aria-label="Ask Aurora. The question opens in the main window's agent panel."
          spellCheck
        />
        <kbd>/</kbd>
      </label>

      <div ref={listRef} className="ql-list" role="listbox" tabIndex={0} aria-label="Worth reading" aria-activedescendant={cur ? `ql-${cur.key}` : undefined} onKeyDown={onListKey}>
        {error && <p className="ql-empty">Aurora is not answering ({error}).</p>}
        {!data && !error && [0, 1, 2, 3, 4].map((i) => <div key={i} className="ql-row ql-skel" aria-hidden><span /><span /></div>)}
        {data && !postCount && !error && <p className="ql-empty">Nothing new worth reading. Enjoy the quiet.</p>}
        {rows.map((r, i) => (
          <div
            key={r.key}
            id={`ql-${r.key}`}
            role="option"
            aria-selected={i === sel}
            className={`ql-row${r.alert ? ' ql-alert' : ''}${i === sel ? ' on' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setSel(i);
              listRef.current?.focus();
            }}
            onDoubleClick={() => void open(r)}
          >
            {r.alert && (i === 0 || !rows[i - 1].alert) && (
              <span className="ql-section">
                <Icon name="bell" size={12} /> Alerts
              </span>
            )}
            <span className="ql-title">{r.title}</span>
            <span className="ql-meta">
              {r.alert && <span className="ql-tag">{r.alert}</span>}
              <span className="ql-author">{r.author}</span>
              {r.source && <span className="ql-sep">{r.source}</span>}
              <span className="ql-sep">{agoText(r.publishedAt)}</span>
              {r.saved && <Icon name="bookmarkFill" size={12} />}
            </span>
            {i === sel && (
              <span className="ql-acts">
                <button tabIndex={-1} onClick={() => void open(r)} title="Read in Aurora (Enter)"><Icon name="book" size={14} /></button>
                {r.url && <button tabIndex={-1} onClick={() => original(r)} title="Open the original (o)"><Icon name="external" size={14} /></button>}
                <button tabIndex={-1} onClick={() => save(r)} title={r.saved ? 'Unsave (s)' : 'Save (s)'}><Icon name={r.saved ? 'bookmarkFill' : 'bookmark'} size={14} /></button>
                <button tabIndex={-1} onClick={() => hideRow(r)} title="Hide (e)"><Icon name="archive" size={14} /></button>
              </span>
            )}
          </div>
        ))}
      </div>

      {now && (
        <button className="ql-now" onClick={() => bus.current?.toggleListen()} title="Play or pause (p)">
          <Icon name={now.status === 'playing' ? 'pause' : 'play'} size={13} />
          <span className="ql-now-label">{now.status === 'paused' ? 'Paused' : 'Listening'}</span>
          <span className="ql-now-title">{now.title}</span>
          {now.by && <span className="ql-now-by">{now.by}</span>}
        </button>
      )}

      <footer className="ql-foot" aria-live="polite">
        {flash ? (
          <span className="ql-flash">{flash}</span>
        ) : (
          <span className="ql-keys">
            {KEYS.map(([keys, label]) => (
              <span key={label}>
                {keys.map((k) => <kbd key={k}>{k}</kbd>)} {label}
              </span>
            ))}
          </span>
        )}
      </footer>
    </div>
  );
}
