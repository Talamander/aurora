import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeClauses, applyFilters, clearClause, DEFAULT_SPEC, normalizeSpec, type Evaluation, type FilterResult } from '../../core/filter.ts';
import type { FilterSpec, Item, Source } from '../../core/types.ts';
import { api } from './api.ts';
import { itemIndex, type ItemIndex } from './itemIndex.ts';
import { BestMatches, RelatedSheet, openRelated } from './Search.tsx';
import { Icon } from './icons.tsx';
import { BUILTIN_VIEWS, sameSpec, useReader, type Reader } from './state.ts';
import { authorLine, fullTime, hostOf, originalLabel, paragraphs, plural, platformLabel, relTime, tokens, agoText, codeBlock, previewText } from './format.ts';
import { FilterSheet, clauseChips } from './FilterSheet.tsx';
import { useDialog } from './useDialog.ts';
import { AgentPanel, AskPill, SUGGESTIONS, useAgentStatus } from './Agent.tsx';
import { PageView, pageIcon } from './Pages.tsx';
import type { ServerEvent } from './state.ts';
import { applyLook, setDesktopPreset, THEME_PRESETS, type DesktopTheme, type Look } from './themes.ts';
import { ThemePicker } from './ThemePicker.tsx';
import { InlineVideo, playable } from './Video.tsx';
import { CatchUpCard, freshSince, useLastSeen } from './CatchUp.tsx';
import { PersonSheet, openPerson, usePersonOpener } from './Person.tsx';
import { TasteCard } from './Taste.tsx';
import './follows.css';
import './aiJobs.css';
import type { PaletteActions } from './Palette.tsx';
// Sheets opened now and then load on first use, keeping the first paint small.
const Workshop = lazy(() => import('./Workshop.tsx').then((m) => ({ default: m.Workshop })));
import type { AiTab } from './AiSettings.tsx';
const AiSettings = lazy(() => import('./AiSettings.tsx').then((m) => ({ default: m.AiSettings })));
const LoginSheet = lazy(() => import('./Login.tsx').then((m) => ({ default: m.LoginSheet })));
const Palette = lazy(() => import('./Palette.tsx').then((m) => ({ default: m.Palette })));
const ThemeStudio = lazy(() => import('./ThemeStudio.tsx').then((m) => ({ default: m.ThemeStudio })));
const SourcesPanel = lazy(() => import('./Sources.tsx').then((m) => ({ default: m.SourcesPanel })));
const FollowsSheet = lazy(() => import('./Follows.tsx').then((m) => ({ default: m.FollowsSheet })));
const AlertsSheet = lazy(() => import('./Alerts.tsx').then((m) => ({ default: m.AlertsSheet })));
const RoutinesSheet = lazy(() => import('./Routines.tsx').then((m) => ({ default: m.RoutinesSheet })));
const Triage = lazy(() => import('./Triage.tsx').then((m) => ({ default: m.Triage })));
import { ProfileHours, ProfileSheet, ProfileSwitcher, ScheduleHint } from './Profiles.tsx';
import { TimeSheet, TimeUpCard } from './TimeWell.tsx';
import { setTrackedProfile, startTimeTracking, useLimitDue } from './timeWell.ts';
import { OnThisDayCard, OnThisDaySheet } from './OnThisDay.tsx';
import { ALL_PROFILE, editionId } from '../../core/profiles.ts';
import { FriendThread, FriendsRailButton, FriendsSheet, FriendsWeekCard, ShareToFriends } from './Friends.tsx';
import { LongformHost } from './Longform.tsx';
import { ListenPlayer } from './ListenPlayer.tsx';
import { articleEntry, listen } from './listenQueue.ts';
import { openQuickLook, serveQuickLook } from './quickBus.ts';
import { WeekCard, WeekHost } from './WeekEntry.tsx';
import { openWeek } from './week.ts';
import { AmbientHost } from './AmbientEntry.tsx';
import { ConstellationHost, openConstellation } from './ConstellationEntry.tsx';
import { FrontPageHost, openFrontPage } from './FrontPageEntry.tsx';
import { openAmbient } from './ambient.ts';
import { shouldShowWhatsNew, WhatsNew, type WhatsNewGo } from './WhatsNew.tsx';
import { Columns, useColumnsLayout } from './Columns.tsx';
import { openHighlights, openReader, openReadLater, READ_LATER } from './longform.ts';
import { useStudioThemes } from './studioThemes.ts';
import { EndCard } from './EndCard.tsx';
import { ThreadsContext, useThread, useThreadGroups } from './threads.ts';
import { collapseThreads, stripMarker, threadFor } from '../../core/threads.ts';
import './threads.css';
import { PullToRefresh, SheetSkeleton, SkeletonCards, popAction, useViewGlide } from './motion.tsx';
import '@fontsource-variable/literata/opsz.css';
import './studio.css';

type Panel = null | 'filters' | 'sources' | 'help' | 'views' | 'workshop' | 'ai' | 'look' | 'palette' | 'friends' | 'alerts' | 'follows' | 'studio' | 'whatsnew' | 'routines' | 'onthisday' | 'report' | 'triage' | 'time';

/** Set inside the desktop app ('darwin', 'win32', 'linux'): the window chrome needs drag regions. */
const DESKTOP = typeof window !== 'undefined' ? (window.auroraDesktop?.platform.replace(/[^a-z0-9]/g, '') ?? '') : '';
type Act = 'save' | 'read' | 'archive';

function useIsPhone() {
  const q = '(max-width: 860px)';
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const t = localStorage.getItem('sr.theme');
      if (t === 'dark' || t === 'light') return t;
    } catch {
      /* ignore */
    }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0c0f' : '#f6f7f9');
    try {
      localStorage.setItem('sr.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  const r = useReader();
  const phone = useIsPhone();
  const [theme, setTheme] = useTheme();
  const [look, setLook] = useState<Look>(null);
  const loadLook = useCallback(() => {
    api.getSetting<Look>('ui.look').then((x) => setLook(x.value)).catch(() => {});
  }, []);
  useEffect(loadLook, [loadLook]);
  // A profile's own theme wins while it is active; otherwise the app-wide look applies.
  const profileLook = (r.profile?.look ?? null) as Look;
  // On Omarchy the desktop theme is offered as a live "Desktop" preset that follows theme changes.
  const [desktop, setDesktop] = useState<DesktopTheme | null>(null);
  const loadDesktop = useCallback(() => {
    api.desktopTheme().then((x) => { setDesktopPreset(x.theme); setDesktop(x.theme); }).catch(() => {});
  }, []);
  useEffect(loadDesktop, [loadDesktop]);
  const activeLook = profileLook ?? look;
  const followsDesktop = activeLook?.preset === 'desktop' && !!desktop;
  useEffect(() => {
    if (followsDesktop && desktop && desktop.mode !== theme) setTheme(desktop.mode);
  }, [followsDesktop, desktop, theme, setTheme]);
  // Saved studio themes register as presets; a studio draft paints over everything while it is open.
  const studio = useStudioThemes();
  const [draftLook, setDraftLook] = useState<Look>(null);
  useEffect(() => {
    // Presets without a light palette (Matte Black, Osaka Jade, Ristretto) always paint dark, so the
    // base tokens they do not override (warnings, platform hues, toasts) must come from dark too.
    const shown = draftLook ?? activeLook;
    const preset = shown?.preset ? THEME_PRESETS[shown.preset] : undefined;
    const mode = preset && !preset.light ? 'dark' : theme;
    document.documentElement.dataset.theme = mode;
    applyLook(shown, mode);
  }, [draftLook, activeLook, theme, desktop, studio.version]);
  useEffect(() => {
    const root = document.documentElement;
    if (r.profile) root.style.setProperty('--pc', r.profile.color);
    else root.style.removeProperty('--pc');
  }, [r.profile]);
  const pickLook = useCallback((preset: string) => {
    const next: Look = { preset, mode: look?.mode, tokens: {} };
    if (r.profile) {
      void api.updateProfile(r.profile.id, { look: next }).then(() => r.reload());
      return;
    }
    setLook(next);
    void api.putSetting('ui.look', next);
  }, [look, r]);
  const assignLook = useCallback(async (preset: string, target: string) => {
    const next: Look = { preset, mode: look?.mode, tokens: {} };
    if (target === ALL_PROFILE) {
      setLook(next);
      await api.putSetting('ui.look', next);
    } else {
      await api.updateProfile(target, { look: next });
      void r.reload();
    }
  }, [look, r]);
  const [profileSheet, setProfileSheet] = useState<null | 'new' | 'edit'>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try {
      return localStorage.getItem('sr.density') === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [whyId, setWhyId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [relatedId, setRelatedId] = useState<string | null>(null);
  const [login, setLogin] = useState<{ profile: string; url: string; label?: string; fromAgent?: boolean } | null>(null);
  const [draft, setDraft] = useState<{ text: string; send?: boolean; n: number } | null>(null);
  const agent = useAgentStatus(r);
  const [person, setPerson] = usePersonOpener();
  const ask = useCallback((text: string, send = true) => {
    setAgentOpen(true);
    setDraft({ text, send, n: Date.now() });
  }, []);

  // Share to follow: the PWA share target (?share-url / share-text / share-title) and plain
  // ?follow= links prefill the agent with "Follow this: …". Nothing is sent until the user does.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const keys = ['share-url', 'share-text', 'share-title', 'follow'];
    if (!keys.some((k) => q.has(k))) return;
    const text = [q.get('share-text'), q.get('share-title')].filter(Boolean).join(' ');
    const target = q.get('follow') || q.get('share-url') || /https?:\/\/\S+/.exec(text)?.[0] || text;
    for (const k of keys) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
    if (target.trim()) ask(`Follow this: ${target.trim().slice(0, 2000)}`, false);
  }, [ask]);

  // Desktop shell commands: the global palette shortcut, aurora:// follow links and the
  // morning-edition notification. The bridge exists only inside the desktop app.
  const openPostIdRef = useRef<(id: string) => void>(() => {});
  const shellRef = useRef({ ask, setPageId: r.setPageId, openPostId: (_id: string) => {} });
  shellRef.current = { ask, setPageId: r.setPageId, openPostId: (id: string) => openPostIdRef.current(id) };
  useEffect(() => {
    const desk = window.auroraDesktop;
    if (!desk) return;
    desk.onCommand((cmd, arg) => {
      if (cmd === 'palette') setPanel('palette');
      else if (cmd === 'follow' && arg) shellRef.current.ask(`Follow this: ${arg.slice(0, 2000)}`, false);
      else if (cmd === 'ask' && arg) shellRef.current.ask(arg.slice(0, 2000));
      else if (cmd === 'page' && arg) shellRef.current.setPageId(arg);
      else if (cmd === 'post' && arg) shellRef.current.openPostId(arg);
      else if (cmd === 'alerts') setPanel('alerts');
      else if (cmd === 'ambient') { setPanel(null); openAmbient({ fullscreen: true }); }
    });
  }, []);
  useEffect(() => {
    const desk = window.auroraDesktop;
    if (!desk) return;
    const tint = () => {
      const cs = getComputedStyle(document.documentElement);
      desk.setTitleBarColors(cs.getPropertyValue('--ground').trim(), cs.getPropertyValue('--ink-2').trim() || cs.getPropertyValue('--ink').trim());
    };
    tint();
    const mo = new MutationObserver(tint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('sr.density', density);
    } catch {
      /* ignore */
    }
  }, [density]);

  const seen = useLastSeen(r.profileId);
  const [newOnly, setNewOnly] = useState(false);
  // One author's chain of posts shows as one card (core/threads.ts); the set-aside list stays flat.
  const threads = useThreadGroups(r.lib?.items);
  const list: Evaluation[] = useMemo(() => {
    if (!r.result) return [];
    if (r.showHidden) return r.result.hidden;
    const vis = newOnly ? freshSince(r.result.visible, seen.since) : r.result.visible;
    return threads ? collapseThreads(vis, threads) : vis;
  }, [r.result, r.showHidden, newOnly, seen.since, threads]);

  const byId = useMemo(() => itemIndex(r.lib?.items ?? []), [r.lib?.items]);
  const threadsValue = useMemo(() => (threads ? { g: threads, get: (id: string) => byId.get(id) } : null), [threads, byId]);
  const selected = useMemo(() => {
    const id = r.selectedId;
    if (!id || !r.result) return null;
    return r.result.visible.find((e) => e.item.id === id) ?? r.result.hidden.find((e) => e.item.id === id) ?? null;
  }, [r.result, r.selectedId]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // Opening a post (expanding it, or selecting it) marks it read without leaving the feed.
  // A thread's card counts for all its posts.
  const markRead = useCallback(
    (ids: string[]) => {
      const all = threads ? [...new Set(ids.flatMap((id) => threadFor(threads, id) ?? [id]))] : ids;
      const items = all.map((id) => byId.get(id)).filter((i): i is Item => !!i && !i.state.read);
      if (!items.length) return;
      r.keepVisible(items.map((i) => i.id));
      void r.changeState(items, { read: true }, 'marked read', { silent: true });
    },
    [byId, r, threads],
  );

  const select = useCallback(
    (id: string, scroll = false) => {
      r.setSelectedId(id);
      if (scroll) {
        const el = document.getElementById(`post-${id}`);
        el?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        // Keyboard selection also moves focus, so screen readers announce the post and Tab reaches its actions.
        el?.focus({ preventScroll: true });
      }
    },
    [r],
  );

  const move = useCallback(
    (delta: number) => {
      if (!list.length) return;
      const idx = list.findIndex((e) => e.item.id === r.selectedId);
      const next = list[Math.max(0, Math.min(list.length - 1, idx === -1 ? 0 : idx + delta))];
      select(next.item.id, true);
    },
    [list, r.selectedId, select],
  );

  // A thread's card stands for all its posts: save, seen and hide apply to every one, locally.
  const withThread = useCallback((item: Item): Item[] => {
    const ids = threads ? threadFor(threads, item.id) : null;
    if (!ids) return [item];
    return [item, ...ids.filter((id) => id !== item.id).map((id) => byId.get(id)).filter((i): i is Item => !!i)];
  }, [threads, byId]);
  const act = useCallback(
    (kind: Act, item: Item | null | undefined) => {
      if (!item) return;
      const all = withThread(item);
      if (kind === 'save') void r.changeState(all, { saved: !item.state.saved }, item.state.saved ? 'removed from saved' : 'saved');
      if (kind === 'read') void r.changeState(all, { read: !item.state.read }, item.state.read ? 'marked unread' : 'marked read');
      if (kind === 'archive') {
        const idx = list.findIndex((e) => e.item.id === item.id);
        void r.changeState(all, { archived: !item.state.archived, read: true }, item.state.archived ? 'moved back from archive' : 'hidden from the feed (archived)');
        if (!item.state.archived && r.spec.archived === 'hide' && r.selectedId === item.id) {
          const next = list[idx + 1] ?? list[idx - 1];
          r.setSelectedId(next ? next.item.id : null);
        }
      }
    },
    [r, list, withThread],
  );

  // The shortcuts that act on one post, shared by the feed and by Columns.
  const postKey = useCallback(
    (key: string, item: Item): boolean => {
      switch (key) {
        case 'Enter': case 'o': {
          const thread = threads ? threadFor(threads, item.id) : null;
          if (thread) { openReader(thread[0]); markRead(thread); return true; }
          if (item.kind === 'article' && item.text) openReader(item.id); else toggleExpand(item.id); markRead([item.id]); return true;
        }
        case 'r': {
          const thread = threads ? threadFor(threads, item.id) : null;
          if (thread) { openReader(thread[0]); markRead(thread); } else if (readableLink(item)) { openReader(item.id); markRead([item.id]); }
          return true;
        }
        case 'l': void r.changeState([item], { collections: item.state.collections.includes(READ_LATER) ? item.state.collections.filter((c) => c !== READ_LATER) : [...item.state.collections, READ_LATER] }, item.state.collections.includes(READ_LATER) ? 'removed from Read later' : 'added to Read later'); return true;
        case 's': act('save', item); return true;
        case 'u': case 'm': act('read', item); return true;
        case 'e': act('archive', item); return true;
        case 'w': setWhyId((w) => (w === item.id ? null : item.id)); return true;
        case 'i': setRelatedId(item.id); return true;
        case 'v': window.open(item.url, '_blank', 'noopener,noreferrer'); return true;
        case 'P': if (item.kind === 'article' || readableLink(item)) listen.add(articleEntry(item)); return true;
      }
      return false;
    },
    [r, act, toggleExpand, markRead, threads],
  );

  // Columns: several views side by side (desktop widths only). Its keys win while it is showing.
  const columns = useColumnsLayout(r.rawLib);
  const page0 = r.pageId ? r.lib?.pages?.find((p) => p.id === r.pageId) ?? null : null;
  const columnsOn = columns.layout.on && !phone && !page0;
  const columnKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const toggleColumns = useCallback(() => {
    if (!columns.layout.on) r.setPageId(null);
    columns.toggle();
  }, [columns, r]);
  // From a source report card: add that source as a column and show Columns.
  const openSourceInColumns = useCallback((ref: string) => {
    setPanel(null);
    r.setPageId(null);
    columns.setLayout((l) => ({ on: true, cols: [...l.cols, { id: Math.random().toString(36).slice(2, 10), profile: r.profileId, kind: 'source' as const, ref }].slice(-8) }));
  }, [columns, r]);
  // Opening a view from the rail while in Columns means "show me this": back to one feed.
  const specAtColumns = useRef<unknown>(null);
  useEffect(() => {
    if (!columns.layout.on) return;
    if (specAtColumns.current === null) specAtColumns.current = { spec: r.spec, view: r.viewId };
    else if ((specAtColumns.current as { spec: unknown }).spec !== r.spec || (specAtColumns.current as { view: unknown }).view !== r.viewId) columns.toggle(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.layout.on, r.spec, r.viewId]);
  useEffect(() => {
    if (!columns.layout.on) specAtColumns.current = null;
  }, [columns.layout.on]);

  // Keyboard navigation. The listener is re-bound in a passive effect, so a key typed right after
  // Ctrl K can reach the old one before the palette's chunk loads; this ref knows at once.
  const paletteOpening = useRef(0);
  useEffect(() => {
    paletteOpening.current = 0;
  }, [panel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        paletteOpening.current = panel === 'palette' ? 0 : Date.now();
        setPanel((p) => (p === 'palette' ? null : 'palette'));
        return;
      }
      if (Date.now() - paletteOpening.current < 1500 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        if (person) setPerson(null);
        else if (panel) setPanel(null);
        else if (profileSheet) setProfileSheet(null);
        else if (agentOpen) setAgentOpen(false);
        else if (typing) (t as HTMLInputElement).blur();
        else if (whyId) setWhyId(null);
        else if (r.showHidden) r.setShowHidden(false);
        return;
      }
      // Alt+1-9 (Cmd+1-9 on a Mac, Ctrl+1-9 where the browser allows it): 1 is All, then each profile.
      if ((e.altKey || e.metaKey || e.ctrlKey) && !e.shiftKey && /^Digit[1-9]$/.test(e.code) && !(typing && e.altKey && !e.ctrlKey && !e.metaKey)) {
        const n = Number(e.code.slice(5));
        const target = n === 1 ? ALL_PROFILE : r.profiles[n - 2]?.id;
        if (target) {
          e.preventDefault();
          r.switchProfile(target);
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // Feed keys stay out of open sheets, including the ones that are not panels (profiles, More like this).
      if (panel !== 'help' && (panel || document.querySelector('[aria-modal="true"]'))) return;
      // Enter and Space belong to the focused button or link, not to the feed.
      if ((e.key === 'Enter' || e.key === ' ') && t.closest('button, a, [role="button"], summary')) return;
      if (e.key === ' ') return; // Space scrolls the feed
      if (e.key === 'c' && !phone) { toggleColumns(); e.preventDefault(); return; }
      if (columnsOn && !panel && columnKeys.current?.(e)) { e.preventDefault(); return; }
      const item = selected?.item;
      if (item && postKey(e.key, item)) { e.preventDefault(); return; }
      switch (e.key) {
        case 'j': case 'ArrowDown': if (e.key === 'ArrowDown' && !selected) return; move(1); break;
        case 'k': case 'ArrowUp': if (e.key === 'ArrowUp' && !selected) return; move(-1); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case 'f': setPanel('filters'); break;
        case 'h': r.setShowHidden(!r.showHidden); break;
        case 'z': void r.undo(); break;
        case 'x': r.setSpec({ ...DEFAULT_SPEC, sort: r.spec.sort }, 'clear all filters'); r.setViewId('everything'); break;
        case 'g': setPanel('sources'); break;
        case 't': setPanel('triage'); break;
        case '?': setPanel(panel === 'help' ? null : 'help'); break;
        case '.': setAgentOpen(true); break;
        case 'd': setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact')); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, selected, move, r, whyId, agentOpen, person, setPerson, postKey, phone, toggleColumns, columnsOn, profileSheet]);

  // Actions the AI asked the UI to take.
  useEffect(
    () =>
      r.subscribe((e: ServerEvent) => {
        if (e.type === 'library' && e.reason !== 'sync' && e.reason !== 'labels') loadLook();
        if (e.type !== 'ui') return;
        const a = e.action;
        if (a.kind === 'desktop-theme') return loadDesktop();
        if (a.kind === 'setSpec' && a.spec) {
          r.setSpec(normalizeSpec(a.spec), `AI: ${a.label ?? 'feed change'}`);
          r.setViewId(null);
          r.setShowHidden(false);
        } else if (a.kind === 'openView' && a.spec) {
          void r.reload().then(() => r.openView(String(a.id), normalizeSpec(a.spec), String(a.name ?? 'view')));
        } else if (a.kind === 'openPage') {
          void r.reload().then(() => r.setPageId(String(a.id)));
        } else if (a.kind === 'navigate') {
          const t = String(a.target);
          const v = BUILTIN_VIEWS.find((x) => x.id === t);
          if (v) r.openView(v.id, v.spec, v.name);
          else if (t === 'workshop') setPanel('workshop');
          else if (t === 'sources') setPanel('sources');
          else if (t === 'follows') setPanel('follows');
          else if (t === 'settings' || t === 'ai') setPanel('ai');
          else if (t === 'feed') r.setPageId(null);
        } else if (a.kind === 'login' && typeof a.profile === 'string' && typeof a.url === 'string') {
          setLogin({ profile: a.profile, url: a.url, label: typeof a.reason === 'string' ? a.reason : undefined, fromAgent: true });
        } else if (a.kind === 'profile' && typeof a.id === 'string') {
          void r.reload().then(() => r.switchProfile(a.id));
        } else if (a.kind === 'look' && a.profile) {
          void r.reload();
        } else if (a.kind === 'look') {
          setLook((a.look ?? null) as Look);
          if (a.look?.mode === 'dark' || a.look?.mode === 'light') setTheme(a.look.mode);
        }
      }),
    [r, setTheme, loadLook, loadDesktop],
  );

  // What the AI sees about the screen when you ask it something.
  const page = r.pageId ? r.lib?.pages?.find((p) => p.id === r.pageId) ?? null : null;
  const context = useCallback(() => {
    const view = BUILTIN_VIEWS.find((v) => v.id === r.viewId) ?? r.lib?.views.find((v) => v.id === r.viewId);
    const spec: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.spec)) if (JSON.stringify(v) !== JSON.stringify((DEFAULT_SPEC as any)[k])) spec[k] = v;
    return { profile: r.profileId, screen: page ? 'page' : r.showHidden ? 'set aside' : 'feed', viewName: view?.name ?? null, pageName: page?.name ?? null, pageId: page?.id ?? null, shown: list.length, spec, selectedPostId: r.selectedId };
  }, [r, page, list.length]);

  const openPost = useCallback(
    (it: Item) => {
      r.setPageId(null);
      if (!r.result?.visible.some((e) => e.item.id === it.id)) r.openView('everything', { ...DEFAULT_SPEC, archived: 'any', showDemo: true }, 'Everything');
      r.setSelectedId(it.id);
      setExpanded((s) => new Set([...s, it.id]));
      if (phone) setAgentOpen(false);
      setTimeout(() => document.getElementById(`post-${it.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
    },
    [r, phone],
  );

  // "More like this" (i, the Why panel, or the agent's UI) opens a sheet of related posts.
  useEffect(() => {
    const on = (e: Event) => setRelatedId(String((e as CustomEvent).detail));
    window.addEventListener('aurora:related', on);
    return () => window.removeEventListener('aurora:related', on);
  }, []);

  openPostIdRef.current = (id: string) => {
    const it = byId.get(id);
    if (it) openPost(it);
    else r.toast('That post is no longer in the library');
  };

  // Quick look (/?quick=1) in a browser hands its post or question to the Aurora tab used last,
  // or, with no tab open, opens /?post=<id> or /?ask=<text>. A question from a link is only put in
  // the agent box, never sent, so a link alone cannot spend anything.
  useEffect(() => serveQuickLook({ open: (id) => openPostIdRef.current(id), ask: (text) => shellRef.current.ask(text) }), []);
  const urlPost = useRef<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('post') && !q.has('ask')) return;
    urlPost.current = q.get('post');
    const text = q.get('ask')?.trim();
    q.delete('post');
    q.delete('ask');
    const rest = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
    if (text) ask(text.slice(0, 2000), false);
    const giveUp = setTimeout(() => (urlPost.current = null), 15_000);
    return () => clearTimeout(giveUp);
  }, [ask]);
  useEffect(() => {
    const id = urlPost.current;
    if (id && byId.has(id)) {
      urlPost.current = null;
      openPostIdRef.current(id);
    }
  }, [byId]);

  // Alerts: the bell's count, and a toast (plus a browser notification when Aurora is in the
  // background) when one fires. The desktop app shows its own native notification instead.
  const [alertUnseen, setAlertUnseen] = useState(0);
  const refreshAlerts = useCallback(() => void api.alerts().then((d) => setAlertUnseen(d.unseen), () => {}), []);
  useEffect(() => refreshAlerts(), [refreshAlerts]);
  useEffect(
    () =>
      r.subscribe((e: ServerEvent) => {
        if (e.type !== 'ui') return;
        const a = e.action as { kind?: string; quiet?: boolean; total?: number; hits?: { alertName: string; itemId: string; item: { author: string; text: string } | null }[] };
        if (a.kind === 'alerts-changed') return refreshAlerts();
        if (a.kind !== 'alert') return;
        refreshAlerts();
        const first = a.hits?.[0];
        if (!first) return;
        const total = a.total ?? a.hits!.length;
        const what = first.item ? `${first.item.author}: ${first.item.text}` : 'a new post';
        const names = [...new Set(a.hits!.map((h) => h.alertName))];
        const title = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} more`;
        r.toast(total > 1 ? `${title} · ${total} new matches` : `${title} · ${what.slice(0, 110)}`, {
          tone: 'alert',
          ms: 9000,
          action: total > 1 ? { label: 'See all', run: () => setPanel('alerts') } : { label: 'Open', run: () => openPostIdRef.current(first.itemId) },
        });
        if (window.auroraDesktop || a.quiet || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (!document.hidden && document.hasFocus()) return;
        try {
          const n = new Notification(title, { body: total > 1 ? `${total} new matches. ${what.slice(0, 120)}` : what.slice(0, 160), tag: 'aurora-alert', icon: '/icon.svg' });
          n.onclick = () => {
            window.focus();
            if (total > 1) setPanel('alerts');
            else openPostIdRef.current(first.itemId);
            n.close();
          };
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }),
    [r, refreshAlerts],
  );

  // Background AI paused by a monthly spending cap: a banner until dismissed, opening Spend.
  const [aiTab, setAiTab] = useState<AiTab>('setup');
  const [aiPaused, setAiPaused] = useState<string[]>([]);
  const refreshPaused = useCallback(() => {
    fetch('/api/ai/spend')
      .then((res) => (res.ok ? res.json() : null))
      .then((d: { capStates: { task: string; reached: boolean; localOnly: boolean }[]; tasks: { task: string; label: string }[] } | null) => {
        if (d) setAiPaused(d.capStates.filter((c) => c.reached && !c.localOnly).map((c) => d.tasks.find((t) => t.task === c.task)?.label ?? c.task));
      }, () => {});
  }, []);
  useEffect(() => refreshPaused(), [refreshPaused]);
  useEffect(
    () =>
      r.subscribe((e: ServerEvent) => {
        if (e.type !== 'ui') return;
        const a = e.action as { kind?: string; label?: string };
        if (a.kind === 'ai-paused' && a.label) setAiPaused((p) => (p.includes(a.label!) ? p : [...p, a.label!]));
      }),
    [r],
  );

  // Time well spent: active reading time per profile (web/src/timeWell.ts).
  useEffect(() => startTimeTracking(), []);
  useEffect(() => setTrackedProfile(r.profile?.id ?? ALL_PROFILE), [r.profile?.id]);

  // What's new: once per release, on a library that already has posts (a first run gets the
  // welcome instead), and only when nothing else is open.
  const hasItems = (r.lib?.items.length ?? 0) > 0 || (r.lib?.itemsTotal ?? 0) > 0;
  useEffect(() => {
    if (!hasItems || panel !== null || !shouldShowWhatsNew() || /[?&](ambient|week|post|ask|constellation|front)=/.test(window.location.search)) return;
    const t = window.setTimeout(() => setPanel((p) => p ?? 'whatsnew'), 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasItems]);
  const hasProfileRef = useRef(false);
  hasProfileRef.current = !!r.profile;
  const whatsNewGo = useCallback((to: WhatsNewGo) => {
    setPanel(null);
    switch (to) {
      case 'columns': if (!columns.layout.on) toggleColumns(); break;
      case 'week': openWeek(); break;
      case 'ambient': openAmbient({ fullscreen: true }); break;
      case 'search': window.setTimeout(() => searchRef.current?.focus(), 50); break;
      case 'profile': setProfileSheet('new'); break;
      case 'profile-hours': setProfileSheet(hasProfileRef.current ? 'edit' : 'new'); break;
      case 'read-later': openReadLater(); break;
      case 'listen': void listen.playReadLater(); break;
      case 'report': setPanel('report'); break;
      case 'quick': openQuickLook(); break;
      case 'constellation': openConstellation(); break;
      case 'front': openFrontPage(); break;
      case 'spend': setAiTab('spend'); setPanel('ai'); break;
      case 'ai-models': case 'lock': setAiTab('setup'); setPanel('ai'); break;
      default: setPanel(to);
    }
  }, [columns.layout.on, toggleColumns]);

  const paletteActions = useMemo<PaletteActions>(() => ({
    openPanel: (p) => setPanel(p),
    theme,
    toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    toggleDensity: () => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact')),
    pickLook,
    openPost,
    openPerson: (it) => setPerson(it),
    ask,
    signIn: (profile, url) => setLogin({ profile, url }),
    syncAll: () => {
      r.toast('Syncing all feeds…');
      api.syncAll().then(() => r.toast('Synced all feeds'), (e) => r.toast(`Sync failed: ${(e as Error).message}`, { tone: 'error' })).finally(() => void r.reload());
    },
    edition: () => {
      const id = editionId(r.profileId);
      if (r.lib?.pages?.some((p) => p.id === id)) { r.setPageId(id); return; }
      r.toast('Writing the morning edition…');
      api.buildEdition(r.profileId).then(async (res) => { await r.reload(); r.setPageId(res.pageId ?? id); }, (e) => r.toast((e as Error).message, { tone: 'error' }));
    },
    toggleColumns,
    columnsOn,
    newProfile: () => setProfileSheet('new'),
    editProfile: () => setProfileSheet('edit'),
  }), [theme, setTheme, pickLook, openPost, setPerson, ask, r, toggleColumns, columnsOn]);

  const renderPost = useCallback(
    (ev: Evaluation, compact: boolean) => (
      <Post
        key={ev.item.id} ev={ev} r={r} byId={byId} selected={ev.item.id === r.selectedId} showReasons={false}
        expanded={expanded.has(ev.item.id)} toggleExpand={toggleExpand} whyOpen={whyId === ev.item.id}
        setWhy={(on) => setWhyId(on ? ev.item.id : null)} select={(id) => r.setSelectedId(id)} act={act} markRead={markRead} openPanel={setPanel} compact={compact || density === 'compact'}
      />
    ),
    [r, byId, expanded, toggleExpand, whyId, act, markRead, density],
  );
  const columnPost = useCallback(
    (ev: Evaluation, colMarkRead: (ids: string[]) => void, full: boolean) => (
      <Post
        key={ev.item.id} ev={ev} r={r} byId={byId} selected={ev.item.id === r.selectedId} showReasons={false}
        expanded={expanded.has(ev.item.id)} toggleExpand={toggleExpand} whyOpen={whyId === ev.item.id}
        setWhy={(on) => setWhyId(on ? ev.item.id : null)} select={(id) => r.setSelectedId(id)} act={act} markRead={colMarkRead} openPanel={setPanel} compact={!full}
      />
    ),
    [r, byId, expanded, toggleExpand, whyId, act],
  );

  if (!r.lib) {
    return (
      <div className="boot" role="status">
        {r.loadError ? (
          <>
            <p className="boot-title">The local server is not answering.</p>
            <p className="boot-sub">{r.loadError}. Start it with <code>npm start</code>, then reload.</p>
            <button className="btn" onClick={() => void r.reload()}>Try again</button>
          </>
        ) : (
          <div className="boot-skel"><SkeletonCards count={3} label="Opening your library…" /></div>
        )}
      </div>
    );
  }

  return (
    <ThreadsContext.Provider value={threadsValue}>
    <div className={`app density-${density} ${phone ? 'is-phone' : ''}${columnsOn ? ' columns-on' : ''}${DESKTOP ? ` desktop platform-${DESKTOP}` : ''}`}>
      <a className="skip-link" href="#feed" onClick={(e) => { e.preventDefault(); const f = document.getElementById('feed'); f?.focus(); }}>Skip to the feed</a>
      {!phone && <Rail r={r} openPanel={setPanel} theme={theme} setTheme={setTheme} openAgent={() => setAgentOpen(true)} openProfile={setProfileSheet} alertUnseen={alertUnseen} columnsOn={columnsOn} toggleColumns={toggleColumns} />}
      {columnsOn ? (
        <Columns r={r} layout={columns.layout} setLayout={columns.setLayout} exit={() => columns.toggle(false)} renderPost={columnPost} postKey={postKey} keysRef={columnKeys} />
      ) : page ? (
        <PageView r={r} page={page} renderPost={renderPost} onAsk={(t) => ask(t, false)} onOpenPost={openPost} phone={phone} />
      ) : (
        <Feed
          r={r} list={list} byId={byId} openPanel={setPanel} searchRef={searchRef} phone={phone} density={density} setDensity={setDensity}
          expanded={expanded} toggleExpand={toggleExpand} whyId={whyId} setWhyId={setWhyId} select={select} act={act} markRead={markRead}
          ask={ask} openAgent={() => setAgentOpen(true)} openPost={openPost} catchUp={{ ...seen, newOnly, setNewOnly }} editProfile={() => setProfileSheet('edit')}
        />
      )}
      {page && !phone && !agentOpen && <div className="page-dock"><AskPill onAsk={(t) => ask(t)} onOpen={() => setAgentOpen(true)} /></div>}
      {!phone && !columnsOn && <RulesPane r={r} openPanel={setPanel} ask={ask} aiReady={!!agent.status?.ready} />}
      {phone && <TabBar r={r} panel={panel} openPanel={setPanel} agentOpen={agentOpen} openAgent={() => setAgentOpen(true)} />}
      {agentOpen && (
        <AgentPanel
          r={r} close={() => setAgentOpen(false)} status={agent.status} context={context} onOpenPost={openPost}
          openWorkshop={() => setPanel('workshop')} openSettings={() => setPanel('ai')} draft={draft} setDraft={() => setDraft(null)} phone={phone}
        />
      )}
      {relatedId && r.lib && (
        <RelatedSheet id={relatedId} byId={byId} sourceLabels={Object.fromEntries(r.lib.sources.map((s) => [s.id, s.label]))} profile={r.profileId} close={() => setRelatedId(null)} openPost={openPost} />
      )}
      {panel === 'filters' && <FilterSheet r={r} close={() => setPanel(null)} />}
      {panel === 'sources' && <Suspense fallback={<SheetSkeleton label="Sources" close={() => setPanel(null)} />}><SourcesPanel r={r} close={() => setPanel(null)} openFollows={() => setPanel('follows')} openInColumns={phone ? undefined : openSourceInColumns} /></Suspense>}
      {panel === 'report' && <Suspense fallback={<SheetSkeleton label="Sources" close={() => setPanel(null)} />}><SourcesPanel r={r} startTab="report" close={() => setPanel(null)} openFollows={() => setPanel('follows')} openInColumns={phone ? undefined : openSourceInColumns} /></Suspense>}
      {panel === 'follows' && r.lib && <Suspense fallback={<SheetSkeleton label="Bring your follows" close={() => setPanel(null)} />}><FollowsSheet close={() => { setPanel(null); void r.reload(); }} lib={r.lib} toast={r.toast} aiReady={!!agent.status?.ready} openSources={() => setPanel('sources')} /></Suspense>}
      {panel === 'alerts' && r.lib && <Suspense fallback={<SheetSkeleton label="Alerts" close={() => setPanel(null)} />}><AlertsSheet close={() => setPanel(null)} lib={r.lib} toast={r.toast} ask={ask} aiReady={!!agent.status?.ready} openPostId={(id) => openPostIdRef.current(id)} onSeen={refreshAlerts} /></Suspense>}
      {panel === 'routines' && r.lib && <Suspense fallback={<SheetSkeleton label="Routines" close={() => setPanel(null)} />}><RoutinesSheet close={() => setPanel(null)} lib={r.lib} toast={r.toast} subscribe={r.subscribe} openPostId={(id) => openPostIdRef.current(id)} openPage={(id) => r.setPageId(id)} /></Suspense>}
      {panel === 'time' && r.lib && <TimeSheet r={r} close={() => setPanel(null)} editProfile={() => { setPanel(null); setProfileSheet(r.profile ? 'edit' : 'new'); }} />}
      {panel === 'triage' && <Suspense fallback={null}><Triage r={r} items={(r.result?.visible ?? []).map((e) => e.item)} close={() => setPanel(null)} /></Suspense>}
      {panel === 'friends' && <FriendsSheet close={() => setPanel(null)} toast={r.toast} openWorkshop={() => setPanel('workshop')} />}
      {panel === 'views' && (
        <div className="sheet-backdrop" onClick={() => setPanel(null)}>
          <DialogDiv className="sheet views-sheet" role="dialog" aria-modal="true" aria-label="Views" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>Views</h2><button className="icon-btn" onClick={() => setPanel(null)} aria-label="Close"><Icon name="x" /></button></div>
            <div className="sheet-body">
              <ProfileSwitcher r={r} compact onNew={() => { setPanel(null); setProfileSheet('new'); }} onEdit={() => { setPanel(null); setProfileSheet('edit'); }} />
              <RailLists r={r} after={() => setPanel(null)} />
            </div>
            <div className="sheet-foot views-foot">
              <button className="btn ghost" onClick={() => setPanel('friends')}><Icon name="people" /> Friends</button>
              <button className="btn ghost" onClick={() => setPanel('alerts')}><Icon name="bell" /> Alerts{alertUnseen > 0 && <span className="alert-badge">{alertUnseen}</span>}</button>
              <button className="btn ghost" onClick={() => { setPanel(null); openWeek(); }}><Icon name="play" /> Your week</button>
              <button className="btn ghost" onClick={() => { setPanel(null); openAmbient({ fullscreen: true }); }}><Icon name="image" /> Ambient</button>
              <button className="btn ghost" onClick={() => setPanel('look')}><Icon name="star" /> Look</button>
              <button className="btn ghost" onClick={() => setPanel('workshop')}><Icon name="wrench" /> Workshop</button>
              <button className="btn ghost" onClick={() => setPanel('ai')}><Icon name="sparkle" /> AI</button>
            </div>
          </DialogDiv>
        </div>
      )}
      {panel === 'help' && <Help close={() => setPanel(null)} />}
      {panel === 'whatsnew' && <WhatsNew close={() => setPanel(null)} go={whatsNewGo} />}
      <ProfileHours r={r} />
      {panel === 'onthisday' && r.lib && <OnThisDaySheet r={r} close={() => setPanel(null)} openPost={openPost} />}
      {profileSheet && r.lib && (
        <ProfileSheet key={`${profileSheet}:${r.profileId}`} r={r} editing={profileSheet === 'edit' ? r.profile : null} close={() => setProfileSheet(null)} ask={ask} />
      )}
      <Suspense fallback={null}>
      {panel === 'palette' && r.lib && <Palette r={r} close={() => setPanel((p) => (p === 'palette' ? null : p))} a={paletteActions} />}
      {person && r.lib && <PersonSheet r={r} seed={person} close={() => setPerson(null)} ask={ask} openPost={openPost} />}
      {login && (
        <LoginSheet
          profile={login.profile} url={login.url} label={login.label}
          onDone={(res) => {
            r.toast(`Signed in to ${login.profile} in the app's own browser`);
            if (login.fromAgent) ask(`I signed in to ${login.profile} (${(res.sites ?? []).map((s) => s.site).slice(0, 4).join(', ') || 'session saved'}). Carry on.`);
          }}
          onClose={() => setLogin(null)}
        />
      )}
      {panel === 'workshop' && r.lib && <Suspense fallback={<SheetSkeleton label="Workshop" close={() => setPanel(null)} />}><Workshop close={() => { setPanel(null); void r.reload(); }} lib={r.lib} toast={r.toast} askAgent={(t) => ask(t, false)} /></Suspense>}
      {panel === 'ai' && <Suspense fallback={<SheetSkeleton label="AI settings" close={() => setPanel(null)} />}><AiSettings startTab={aiTab} close={() => { setPanel(null); setAiTab('setup'); refreshPaused(); void agent.refresh(); }} toast={r.toast} /></Suspense>}
      {aiPaused.length > 0 && panel !== 'ai' && (
        <div className="ai-paused-banner" role="alert">
          <Icon name="pause" size={14} />
          <span><b>{aiPaused.join(', ')} paused.</b> This month's AI spending cap is reached.</span>
          <button className="btn small" onClick={() => { setAiTab('spend'); setPanel('ai'); }}>See spend</button>
          <button className="icon-btn small" aria-label="Dismiss" onClick={() => setAiPaused([])}><Icon name="x" size={14} /></button>
        </div>
      )}
      </Suspense>
      {panel === 'look' && (
        <div className="sheet-backdrop" onClick={() => setPanel(null)}>
          <DialogDiv className="sheet look-sheet" role="dialog" aria-modal="true" aria-label="Look" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>Look</h2><button className="icon-btn" onClick={() => setPanel(null)} aria-label="Close"><Icon name="x" /></button></div>
            <div className="sheet-body">
              <div className="seg" role="radiogroup" aria-label="Mode">
                <button role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}><Icon name="moon" /> Dark</button>
                <button role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}><Icon name="sun" /> Light</button>
              </div>
              {r.profile && (
                <p className="look-hint">
                  Picking a theme for <b>{r.profile.name}</b>. It shows only while {r.profile.name} is on.{' '}
                  {r.profile.look && <button className="link-btn" onClick={() => void api.updateProfile(r.profile!.id, { look: null }).then(() => r.reload())}>Use All's theme</button>}
                </p>
              )}
              <ThemePicker key={`${theme}:${r.profileId}:${studio.version}`} current={(profileLook ?? look)?.preset ?? 'aurora'} onPick={pickLook} mode={theme} />
              <button className="studio-entry" onClick={() => setPanel('studio')}>
                <span className="studio-entry-art" aria-hidden />
                <span><b>Theme studio</b><small>Make one from a picture, a mood, or by hand</small></span>
                <Icon name="back" size={16} />
              </button>
              <p className="look-hint">Or ask for one: <button className="link-btn" onClick={() => { setPanel(null); ask('Make the theme feel like ', false); }}>“Make it feel like…”</button></p>
            </div>
          </DialogDiv>
        </div>
      )}
      {panel === 'studio' && r.lib && (
        <Suspense fallback={<SheetSkeleton label="Theme studio" close={() => setPanel(null)} />}>
          <ThemeStudio
            r={r} theme={theme} setTheme={setTheme} activeLook={activeLook} preview={setDraftLook} assign={assignLook}
            saved={studio.saved} saveList={studio.save} setDensity={setDensity} ask={ask} close={() => setPanel(null)}
          />
        </Suspense>
      )}
      <LongformHost r={r} phone={phone} ask={ask} />
      <WeekHost r={r} openPost={openPost} />
      <AmbientHost r={r} openPost={openPost} />
      <ConstellationHost r={r} />
      <FrontPageHost r={r} open={(it) => { if (readableLink(it)) { openReader(it.id); markRead([it.id]); } else openPost(it); }} />
      <ListenPlayer toast={r.toast} postText={(id) => r.lib?.items.find((i) => i.id === id)?.text} />
      <Toasts r={r} />
    </div>
    </ThreadsContext.Provider>
  );
}

// ------------------------------------------------------------------ rail

function hueVar(platform: string) {
  return `var(--hue-${platform}, var(--hue-import))`;
}

function Rail({ r, openPanel, theme, setTheme, openAgent, openProfile, alertUnseen, columnsOn, toggleColumns }: { r: Reader; openPanel: (p: Panel) => void; theme: string; setTheme: (t: 'dark' | 'light') => void; openAgent: () => void; openProfile: (k: 'new' | 'edit') => void; alertUnseen: number; columnsOn: boolean; toggleColumns: () => void }) {
  return (
    <nav className={`rail ${r.profile ? 'has-profile' : ''}`} aria-label="Library" style={r.profile ? ({ ['--pc' as string]: r.profile.color } as React.CSSProperties) : undefined}>
      <div className="brand">
        <span className="brand-name">Aurora</span>
        <span className="brand-note">local</span>
      </div>
      <ProfileSwitcher r={r} onNew={() => openProfile('new')} onEdit={() => openProfile('edit')} onTime={() => openPanel('time')} />
      <button className="rail-ask" onClick={openAgent}><span className="agent-orb small" aria-hidden /> Ask your feed <kbd>.</kbd></button>
      <button className="rail-search" onClick={() => openPanel('palette')}><Icon name="search" size={15} /> <span className="rail-search-l">Search everything</span> <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button>
      <RailLists r={r} />
      <div className="rail-foot">
        <button className="rail-btn" onClick={() => openPanel('sources')}><Icon name="layers" /> Sources &amp; imports</button>
        <FriendsRailButton open={() => openPanel('friends')} version={r.lib} />
        {/* Settings-like places sit in one row of icons, so the lists above keep the room. */}
        <div className="rail-tools" role="group" aria-label="Settings">
          <button className="rail-tool" onClick={() => openPanel('alerts')} aria-label={alertUnseen ? `Alerts, ${alertUnseen} new` : 'Alerts'} data-tip="Alerts"><Icon name="bell" size={17} />{alertUnseen > 0 && <span className="alert-badge">{alertUnseen > 99 ? '99+' : alertUnseen}</span>}</button>
          <button className={`rail-tool ${columnsOn ? 'on' : ''}`} onClick={toggleColumns} aria-pressed={columnsOn} aria-label="Columns, several views side by side" data-tip="Columns  c"><Icon name="columns" size={17} /></button>
          <button className="rail-tool" onClick={() => openPanel('routines')} aria-label="Routines" data-tip="Routines"><Icon name="sync" size={17} /></button>
          <button className="rail-tool" onClick={openConstellation} aria-label="Constellation, a map of your reading world" data-tip="Constellation"><Icon name="constellation" size={17} /></button>
          <button className="rail-tool" onClick={() => openAmbient({ fullscreen: true })} aria-label="Ambient, the feed as a slow full-screen display" data-tip="Ambient"><Icon name="image" size={17} /></button>
          <button className="rail-tool" onClick={() => openPanel('workshop')} aria-label="Workshop" data-tip="Workshop"><Icon name="wrench" size={17} /></button>
          <button className="rail-tool" onClick={() => openPanel('ai')} aria-label="AI settings" data-tip="AI settings"><Icon name="sparkle" size={17} /></button>
          <button className="rail-tool" onClick={() => openPanel('look')} aria-label="Look and themes" data-tip="Look & themes"><Icon name="star" size={17} /></button>
          <button className="rail-tool" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'} data-tip={theme === 'dark' ? 'Light mode' : 'Dark mode'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /></button>
          <button className="rail-tool" onClick={() => openPanel('help')} aria-label="Keyboard shortcuts" data-tip="Shortcuts  ?"><Icon name="keyboard" size={17} /></button>
        </div>
      </div>
    </nav>
  );
}

function EditionButton({ r, after }: { r: Reader; after?: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="rail-item edition-new" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const res = await api.buildEdition(r.profileId);
        await r.reload();
        r.setPageId(res.pageId ?? editionId(r.profileId));
        after?.();
      } catch (e) {
        r.toast((e as Error).message, { tone: 'error' });
      } finally {
        setBusy(false);
      }
    }}>
      {busy ? <span className="spin" aria-hidden /> : <Icon name="news" size={15} />} <span className="rail-label">{busy ? 'Writing your edition…' : 'Morning edition'}</span>
    </button>
  );
}

function RailLists({ r, after }: { r: Reader; after?: () => void }) {
  const lib = r.lib!;
  // One pass over the library for all three: this reruns every time a few posts are marked read.
  const { counts, unreadBySource, queued } = useMemo(() => {
    const counts: Record<string, number> = {};
    const unreadBySource: Record<string, number> = {};
    let queued = 0;
    for (const it of lib.items) {
      counts[it.sourceId] = (counts[it.sourceId] ?? 0) + 1;
      if (it.state.archived) continue;
      if (!it.state.read) unreadBySource[it.sourceId] = (unreadBySource[it.sourceId] ?? 0) + 1;
      if (it.state.collections.length && it.state.collections.includes(READ_LATER)) queued++;
    }
    return { counts, unreadBySource, queued };
  }, [lib.items]);
  const go = (id: string, spec: FilterSpec, name: string) => {
    r.openView(id, spec, name);
    after?.();
  };
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <div className="rail-lists">
      <section>
        <h3 className="eyebrow">Views</h3>
        {BUILTIN_VIEWS.map((v) => (
          <button key={v.id} className={`rail-item ${r.viewId === v.id && !r.pageId ? 'on' : ''}`} onClick={() => go(v.id, v.spec, v.name)} aria-current={r.viewId === v.id && !r.pageId ? 'page' : undefined}>
            <span>{v.name}</span>
          </button>
        ))}
        {lib.views.map((v) => (
          <div key={v.id} className={`rail-item-wrap ${r.viewId === v.id ? 'on' : ''}`}>
            <button className={`rail-item ${r.viewId === v.id ? 'on' : ''}`} onClick={() => go(v.id, v.spec, v.name)}>
              <span>{v.name}</span>
            </button>
            {confirmDelete === v.id ? (
              <button className="mini-btn danger" onClick={async () => { await api.deleteView(v.id); setConfirmDelete(null); if (r.viewId === v.id) r.setViewId(null); void r.reload(); r.toast(`Deleted view “${v.name}”`); }}>Delete?</button>
            ) : (
              <button className="mini-btn" aria-label={`Delete view ${v.name}`} onClick={() => setConfirmDelete(v.id)}><Icon name="x" size={14} /></button>
            )}
          </div>
        ))}
      </section>
      <section>
        <h3 className="eyebrow">Reading</h3>
        <button className="rail-item" onClick={() => { openReadLater(); after?.(); }}>
          <Icon name="inbox" size={15} /> <span className="rail-label">Read later</span>
          <span className="count">{queued || ''}</span>
        </button>
        <button className="rail-item" onClick={() => { openHighlights(); after?.(); }}>
          <Icon name="star" size={15} /> <span className="rail-label">Highlights</span>
        </button>
      </section>
      {lib.items.length > 0 && (
        <section>
          <h3 className="eyebrow">Pages</h3>
          {(lib.pages ?? []).map((p) => (
            <button key={p.id} className={`rail-item ${r.pageId === p.id ? 'on' : ''}`} aria-current={r.pageId === p.id ? 'page' : undefined} onClick={() => { r.setPageId(p.id); after?.(); }}>
              <Icon name={pageIcon(p)} size={15} /> <span className="rail-label">{p.name}</span>
            </button>
          ))}
          {!lib.pages?.some((p) => p.id === editionId(r.profileId)) && <EditionButton r={r} after={after} />}
        </section>
      )}
      {lib.sources.length > 0 && (
        <section>
          <h3 className="eyebrow">Sources</h3>
          {lib.sources.map((s) => {
            const on = r.spec.sources.length === 1 && r.spec.sources[0] === s.id;
            return (
              <button
                key={s.id}
                className={`rail-item ${on ? 'on' : ''} ${!s.enabled ? 'off' : ''}`}
                onClick={() => (on ? r.setSpec((x) => ({ ...x, sources: [] }), 'show all sources') : r.setSpec((x) => ({ ...x, sources: [s.id] }), `only ${s.label}`), after?.())}
                title={on ? 'Show all sources' : `Only ${s.label}`}
              >
                <span className={`mark ${s.isDemo ? 'demo' : ''}`} style={{ background: s.isDemo ? undefined : hueVar(s.platform) }} />
                <span className="rail-label">{s.label}</span>
                {s.status === 'error' || s.status === 'blocked' ? <span className="status-dot warn" title={s.statusDetail ?? s.status} /> : null}
                <span className="count" aria-label={unreadBySource[s.id] ? `${unreadBySource[s.id]} unread` : undefined} title={unreadBySource[s.id] ? `${unreadBySource[s.id]} unread of ${counts[s.id] ?? 0}` : undefined}>{unreadBySource[s.id] ? unreadBySource[s.id] : counts[s.id] ? '' : '0'}</span>
              </button>
            );
          })}
        </section>
      )}
      {lib.collections.length > 0 && (
        <section>
          <h3 className="eyebrow">Collections</h3>
          {lib.collections.map((c) => {
            const on = r.spec.collection === c;
            return (
              <button key={c} className={`rail-item ${on ? 'on' : ''}`} onClick={() => (go(`col:${c}`, { ...DEFAULT_SPEC, collection: c, archived: 'any' }, c))}>
                <Icon name="folder" size={15} /> <span className="rail-label">{c}</span>
              </button>
            );
          })}
        </section>
      )}
      {lib.topics.length > 0 && (
        <section>
          <h3 className="eyebrow">Topics</h3>
          {lib.topics.map((t) => {
            const on = r.spec.topics.length === 1 && r.spec.topics[0] === t.id;
            return (
              <button key={t.id} className={`rail-item ${on ? 'on' : ''}`} title={`Matches: ${t.terms.join(', ')}`} onClick={() => (on ? r.setSpec((x) => ({ ...x, topics: [] }), 'clear topic') : r.setSpec((x) => ({ ...x, topics: [t.id] }), `topic ${t.name}`), after?.())}>
                <Icon name="tag" size={15} /> <span className="rail-label">{t.name}</span>
              </button>
            );
          })}
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ feed

const PAGE = 30;

function Feed({
  r, list, byId, openPanel, searchRef, phone, density, setDensity, expanded, toggleExpand, whyId, setWhyId, select, act, markRead, ask, openAgent, openPost, catchUp, editProfile,
}: {
  r: Reader; list: Evaluation[]; byId: ItemIndex; openPanel: (p: Panel) => void;
  searchRef: React.RefObject<HTMLInputElement>; phone: boolean; density: string; setDensity: (d: 'comfortable' | 'compact') => void;
  expanded: ReadonlySet<string>; toggleExpand: (id: string) => void; whyId: string | null; setWhyId: (id: string | null) => void;
  select: (id: string, scroll?: boolean) => void; act: (k: Act, i: Item) => void; markRead: (ids: string[]) => void;
  ask: (text: string, send?: boolean) => void; openAgent: () => void; openPost: (it: Item) => void;
  catchUp: { since: string | null; markSeen: () => void; newOnly: boolean; setNewOnly: (on: boolean) => void };
  editProfile: () => void;
}) {
  const lib = r.lib!;
  const res = r.result!;
  const [limit, setLimit] = useState(PAGE);
  // A profile's soft daily limit ends the endless scroll with a card until you choose (TimeWell.tsx).
  const timeUp = useLimitDue(r.profile) && !r.showHidden;
  const [query, setQuery] = useState(r.spec.query);
  const scrollRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setQuery(r.spec.query);
  }, [r.spec.query]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (query !== r.spec.query) r.setSpec((s) => ({ ...s, query }), query ? `search “${query}”` : 'clear search');
    }, 160);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLimit(PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [r.spec, r.showHidden]);
  useViewGlide(scrollRef, '.posts', `${r.viewId}:${r.showHidden}`);
  const pullSync = useCallback(
    () => api.syncAll().then(() => r.toast('Synced all feeds'), (e) => r.toast(`Sync failed: ${(e as Error).message}`, { tone: 'error' })).finally(() => void r.reload()),
    [r],
  );

  // Keyboard selection beyond the loaded page loads more.
  useEffect(() => {
    const idx = list.findIndex((e) => e.item.id === r.selectedId);
    if (idx >= limit - 2) setLimit((l) => Math.max(l, idx + PAGE));
  }, [r.selectedId, list, limit]);

  // Endless feed: load the next page as the end comes into view.
  useEffect(() => {
    const el = moreRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
    }, { root, rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.length, limit]);

  // Posts you scroll past count as seen (read), like any feed. They stay until the filters change.
  const markRef = useRef(markRead);
  markRef.current = markRead;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || r.showHidden) return;
    const queue = new Set<string>();
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        const top = e.rootBounds?.top ?? 0;
        if (!e.isIntersecting && e.boundingClientRect.bottom <= top + 1) queue.add((e.target as HTMLElement).dataset.id!);
      }
    }, { root, threshold: 0 });
    root.querySelectorAll<HTMLElement>('.post[data-unread="1"]').forEach((el) => io.observe(el));
    const t = setInterval(() => {
      if (!queue.size) return;
      const ids = [...queue];
      queue.clear();
      markRef.current(ids);
    }, 1200);
    return () => {
      io.disconnect();
      clearInterval(t);
      if (queue.size) markRef.current([...queue]);
    };
  }, [list, limit, r.showHidden]);

  const view = BUILTIN_VIEWS.find((v) => v.id === r.viewId) ?? lib.views.find((v) => v.id === r.viewId);
  const modified = view ? !sameSpec(view.spec, r.spec) : true;
  const title = r.showHidden ? 'Set aside' : view ? view.name : r.spec.collection ?? 'Your feed';
  const chips = clauseChips(r);
  const hiddenCount = res.hidden.length;
  const noContent = lib.items.length === 0;
  const allDemo = lib.items.length > 0 && lib.items.every((i) => i.isDemo);
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState('');

  const saveView = async () => {
    const name = viewName.trim();
    if (!name) return;
    const userView = lib.views.find((v) => v.id === r.viewId);
    const saved = await api.saveView({ id: userView && userView.name === name ? userView.id : undefined, name, spec: r.spec });
    await r.reload();
    r.setViewId(saved.id);
    setSaving(false);
    setViewName('');
    r.toast(`Saved view “${name}”`);
  };

  const startNewView = () => {
    scrollRef.current?.scrollTo({ top: 0 });
    setSaving(true);
    setViewName('');
  };
  const latestSync = lib.sources.reduce<string | null>((m, s) => (s.lastSyncAt && (!m || s.lastSyncAt > m) ? s.lastSyncAt : m), null);

  const topHiders = (Object.entries(res.hiddenBy) as [keyof FilterSpec | 'duplicate', number][]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const shown = r.showHidden ? hiddenCount : list.length;
  const visibleIds = useMemo(() => new Set(list.map((e) => e.item.id)), [list]);
  const sourceLabels = useMemo(() => Object.fromEntries(lib.sources.map((s) => [s.id, s.label])), [lib.sources]);

  return (
    <main className="feed" id="feed" tabIndex={-1} aria-label="Feed" ref={scrollRef}>
      <PullToRefresh scroller={scrollRef} enabled={phone && !noContent} onRefresh={pullSync} />
      <header className="feed-bar">
        <div className="feed-bar-in">
          <h1 className="feed-title">
            <span>{title}</span>
            {!noContent && <span className="feed-count" aria-live="polite">{shown.toLocaleString()}</span>}
            {!noContent && (lib.itemsTotal ?? 0) > lib.items.length && <span className="feed-count-more" title={`Loading older posts (${lib.items.length.toLocaleString()} of ${lib.itemsTotal!.toLocaleString()})`}>loading older…</span>}
          </h1>
          {!noContent && (
            <label className="search">
              <Icon name="search" size={17} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={phone ? 'Search your feed' : 'Search, "phrase", -word, from:name'}
                aria-label="Search posts"
                spellCheck={false}
              />
              {query && <button className="icon-btn small" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="x" size={15} /></button>}
              {!phone && !query && <kbd>/</kbd>}
            </label>
          )}
          {!noContent && (
            <button className={`icon-btn filters-icon ${chips.length ? 'has' : ''}`} onClick={() => openPanel('filters')} aria-label={`Open filters${chips.length ? `, ${chips.length} active` : ''}`} title="Filters (f)">
              <Icon name="sliders" />{chips.length > 0 && <span className="badge">{chips.length}</span>}
            </button>
          )}
          {phone && <button className="icon-btn" onClick={() => openPanel('palette')} aria-label="Search everything"><Icon name="bolt" /></button>}
          {phone && <button className="icon-btn" onClick={() => openPanel('sources')} aria-label="Sources and imports"><Icon name="layers" /></button>}
        </div>
      </header>

      <div className="feed-col">
        {!noContent && (
          <div className="feed-intro">
            <p className="hero-kick">
              {partOfDay()}{r.profile ? <> · <span className="hero-profile">{r.profile.name}</span></> : null} · {plural(lib.sources.length, 'source')}{latestSync ? <> · synced {agoText(latestSync)}</> : null}
            </p>
            <h2 className="hero-title">
              <span className="hero-n">{shown.toLocaleString()}</span> {heroPhrase(r.showHidden, view?.id, view?.name, r.spec.collection)}
            </h2>
            <p className="count-sub">
              {r.showHidden ? (
                <>Posts your rules kept out of the feed, each with the rule that did it. <button className="link-btn" onClick={() => r.setShowHidden(false)}>Back to the feed</button></>
              ) : (
                <>
                  {plural(lib.items.length, 'post')} in your library
                  {hiddenCount > 0 && (
                    <>
                      {' · '}
                      <button className="link-btn" onClick={() => r.setShowHidden(true)}>{hiddenCount.toLocaleString()} set aside</button>
                    </>
                  )}
                  {modified && view && <>{' · '}<span className="modified">view edited</span></>}
                </>
              )}
            </p>
            {chips.length > 0 && (
              <div className="chip-row feed-chips" role="list" aria-label="Active filters">
                {chips.map((c) => (
                  <span key={c.key + c.label} className={`chip on ${c.negative ? 'neg' : ''}`} role="listitem">
                    {c.label}
                    <button aria-label={`Remove filter ${c.label}`} onClick={() => r.setSpec((s) => c.clear(s), `remove “${c.label}”`)}><Icon name="x" size={13} /></button>
                  </span>
                ))}
                <span role="listitem" className="chip-li"><button className="chip ghost" onClick={() => { r.setSpec({ ...DEFAULT_SPEC, sort: r.spec.sort }, 'clear all filters'); r.setViewId('everything'); }}>Clear all</button></span>
              </div>
            )}
            {(modified || saving) && !r.showHidden && (
              <div className="save-view">
                {saving ? (
                  <form onSubmit={(e) => { e.preventDefault(); void saveView(); }} className="save-view-form">
                    <input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Name this view" aria-label="View name" maxLength={80} />
                    <button className="btn small primary" type="submit" disabled={!viewName.trim()}>Save</button>
                    <button className="btn small ghost" type="button" onClick={() => setSaving(false)}>Cancel</button>
                  </form>
                ) : (
                  <button className="link-btn" onClick={() => { setSaving(true); setViewName(lib.views.find((v) => v.id === r.viewId)?.name ?? ''); }}>
                    Save this feed as a view
                  </button>
                )}
              </div>
            )}
            {allDemo && <p className="demo-banner"><span className="mark demo" /> You are looking at the fictional demo library. Connect a feed or import a file in Sources to see your own posts.</p>}
          </div>
        )}

        {!noContent && !r.showHidden && (
          <CatchUpCard
            r={r} visible={res.visible} since={catchUp.since} markSeen={() => { catchUp.markSeen(); catchUp.setNewOnly(false); }}
            newOnly={catchUp.newOnly} setNewOnly={catchUp.setNewOnly} openPost={openPost} triage={() => openPanel('triage')}
          />
        )}

        {!r.showHidden && <ScheduleHint r={r} />}
        {!noContent && !r.showHidden && !query.trim() && <OnThisDayCard r={r} openPost={openPost} openAll={() => openPanel('onthisday')} />}

        {/* Keyed to the typed text, not the debounced filter, so the ranked request runs while the feed filters. */}
        {!noContent && !r.showHidden && query.trim().length >= 2 && (
          <BestMatches query={query} byId={byId} visible={visibleIds} sourceLabels={sourceLabels} profile={r.profileId} openPost={openPost} />
        )}

        <div className="posts" aria-label={r.showHidden ? 'Posts set aside' : 'Posts'}>
          {noContent && r.profile ? (
            <div className="empty prof-empty">
              <p className="empty-title">{r.profile.name} has no sources yet.</p>
              <p>Pick some you already follow, or add new ones while {r.profile.name} is on and they land here.</p>
              <div className="why-actions">
                <button className="btn primary" onClick={editProfile}>Pick sources</button>
                <button className="btn" onClick={() => openPanel('sources')}>Add a source</button>
                <button className="btn ghost" onClick={() => ask(`Find sources for my ${r.profile!.name} profile`, false)}><Icon name="sparkle" size={15} /> Ask AI</button>
              </div>
            </div>
          ) : noContent ? (
            <FirstRun r={r} openPanel={openPanel} ask={ask} />
          ) : list.length === 0 ? (
            r.showHidden ? (
              <div className="empty"><p className="empty-title">Nothing is set aside.</p><p>Every post passes your rules.</p></div>
            ) : (
              <div className="empty">
                <p className="empty-title">No posts match these filters.</p>
                <p>{plural(lib.items.length, 'post')} in the library. These rules hide the most:</p>
                <ul className="hider-list">
                  {topHiders.map(([k, n]) => (
                    <li key={k}>
                      <span>{hiderLabel(k, r.spec)}</span>
                      <span className="hider-n">{n.toLocaleString()}</span>
                      <button className="btn small" onClick={() => r.setSpec((s) => clearClause(s, k), `clear ${hiderLabel(k, r.spec)}`)}>Clear</button>
                    </li>
                  ))}
                </ul>
                <div className="empty-actions">
                  <button className="btn" onClick={() => r.setShowHidden(true)}>See the {hiddenCount.toLocaleString()} set aside</button>
                  <button className="btn ghost" onClick={() => void r.undo()}><Icon name="undo" /> Undo last change</button>
                </div>
              </div>
            )
          ) : (
            <>
              {list.slice(0, limit).map((ev) => (
                <Post
                  key={ev.item.id} ev={ev} r={r} byId={byId} selected={ev.item.id === r.selectedId} showReasons={r.showHidden}
                  expanded={expanded.has(ev.item.id)} toggleExpand={toggleExpand} whyOpen={whyId === ev.item.id}
                  setWhy={(on) => setWhyId(on ? ev.item.id : null)} select={select} act={act} markRead={markRead} openPanel={openPanel} compact={density === 'compact'}
                />
              ))}
              {timeUp && <TimeUpCard r={r} />}
              {list.length > limit ? (
                !timeUp && <div ref={moreRef} className="feed-more" aria-hidden><SkeletonCards count={1} /></div>
              ) : !r.showHidden && !query.trim() ? (
                <EndCard res={res} lib={lib} viewName={title} seeHidden={() => r.setShowHidden(true)} ms={res.ms} />
              ) : (
                <div className="feed-end">
                  <span className="feed-end-mark" aria-hidden />
                  <p className="feed-end-title">That is everything your rules set aside.</p>
                  <p className="feed-end-sub"><button className="link-btn" onClick={() => r.setShowHidden(false)}>Back to the feed</button></p>
                </div>
              )}
            </>
          )}
        </div>
        {!phone && !noContent && (
          <div className="feed-tools">
            <select className="sort" value={r.spec.sort} onChange={(e) => r.setSpec((s) => ({ ...s, sort: e.target.value as FilterSpec['sort'] }), 'change sort')} aria-label="Sort">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="relevance">Best match</option>
              <option value="source">By source</option>
            </select>
            <button className="btn small ghost" onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} title="Density (d)">
              {density === 'compact' ? 'Show full posts' : 'Compact feed'}
            </button>
          </div>
        )}
      </div>
      {!phone && !noContent && <div className="dock-wrap"><LensDock r={r} shown={shown} onNew={startNewView} ask={ask} openAgent={openAgent} /></div>}
    </main>
  );
}

function partOfDay(now = new Date()): string {
  const day = now.toLocaleDateString(undefined, { weekday: 'long' });
  const h = now.getHours();
  return `${day} ${h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'}`;
}

function heroPhrase(showHidden: boolean, viewId: string | undefined, viewName: string | undefined, collection: string | null | undefined): string {
  if (showHidden) return 'set aside';
  if (viewId === 'worth') return 'worth reading';
  if (viewId === 'saved') return 'saved';
  if (viewId === 'everything') return 'in everything';
  if (viewId === 'archive') return 'in the archive';
  if (viewName) return `in ${viewName}`;
  if (collection) return `in ${collection}`;
  return 'in your feed';
}

/** Views as lenses over the same library: switch lens and the feed re-lights. */
function LensDock({ r, shown, onNew, ask, openAgent }: { r: Reader; shown: number; onNew: () => void; ask: (text: string) => void; openAgent: () => void }) {
  const lib = r.lib!;
  const items = useDeferredValue(lib.items);
  // Each lens keeps its last result, so marking a few posts read re-checks only those posts.
  const lastByLens = useRef(new Map<string, FilterResult>());
  const lenses = useMemo(
    () =>
      [...BUILTIN_VIEWS.filter((v) => v.id !== 'archive'), ...lib.views].map((v) => {
        const res = applyFilters(items, v.spec, { topics: lib.topics, sourceLabels: r.sourceLabels, ai: { rules: lib.aiRules, labels: lib.labels } }, lastByLens.current.get(v.id));
        lastByLens.current.set(v.id, res);
        return { id: v.id, name: v.name, spec: v.spec, n: res.visible.length };
      }),
    [items, lib.views, lib.topics, r.sourceLabels],
  );
  // In a narrow window the dock scrolls sideways; keep the active view in sight.
  const dockRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = dockRef.current?.querySelector<HTMLElement>('.lens.on');
    const dock = dockRef.current;
    if (!el || !dock || dock.scrollWidth <= dock.clientWidth) return;
    const l = el.offsetLeft, rgt = l + el.offsetWidth;
    if (l < dock.scrollLeft) dock.scrollLeft = l - 6;
    else if (rgt > dock.scrollLeft + dock.clientWidth) dock.scrollLeft = rgt - dock.clientWidth + 6;
  }, [r.viewId, r.showHidden, lenses.length]);
  return (
    <nav ref={dockRef} className="lens-dock" aria-label="Views">
      <AskPill onAsk={ask} onOpen={openAgent} />
      {lenses.map((l) => {
        const on = r.viewId === l.id && !r.showHidden;
        return (
          <button key={l.id} className={`lens ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => r.openView(l.id, l.spec, l.name)}>
            <b>{l.name}</b>
            <small>{(on ? shown : l.n).toLocaleString()}</small>
          </button>
        );
      })}
      <button className="lens add" onClick={onNew} aria-label="Save this feed as a new view" title="Save this feed as a new view"><Icon name="plus" /></button>
    </nav>
  );
}

function hiderLabel(k: string, spec: FilterSpec): string {
  switch (k) {
    case 'query': return `Search “${spec.query}”`;
    case 'include': return 'Keywords';
    case 'exclude': return 'Muted words';
    case 'read': return spec.read === 'unread' ? 'Unread only' : 'Read only';
    case 'saved': return spec.saved === 'saved' ? 'Saved only' : 'Not saved';
    case 'archived': return spec.archived === 'only' ? 'Archive only' : 'Archived hidden';
    case 'hideNoise': return 'Noise set aside';
    case 'duplicate': return 'Duplicates hidden';
    case 'sources': return 'Source selection';
    case 'excludeSources': return 'Muted sources';
    case 'authors': return 'Author selection';
    case 'excludeAuthors': return 'Muted authors';
    case 'platforms': return 'Platforms';
    case 'contentTypes': return 'Content type';
    case 'kinds': return 'Post kind';
    case 'langs': return 'Language';
    case 'topics': return 'Topics';
    case 'dateFrom': return 'Start date';
    case 'dateTo': return 'End date';
    case 'collection': return `Collection “${spec.collection}”`;
    case 'showDemo': return 'Demo hidden';
    default: return k;
  }
}

function initials(name: string): string {
  const parts = name.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

function Avatar({ it }: { it: Item }) {
  const [broken, setBroken] = useState(false);
  const style = { '--av': it.isDemo ? 'var(--hue-demo)' : hueVar(it.platform) } as React.CSSProperties;
  if (it.author.avatar && !broken) {
    return <img className="avatar" src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} />;
  }
  return <span className="avatar initials" style={style} data-initials={initials(it.author.name)} aria-hidden />;
}

function Body({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p, i) => codeBlock(p) !== null ? (
        <pre key={i} className="code-block" tabIndex={0} aria-label="Code"><code>{codeBlock(p)}</code></pre>
      ) : (
        <p key={i}>
          {tokens(p).map((t, j) =>
            t.t === 'url' ? (
              <a key={j} href={t.v} target="_blank" rel="noopener noreferrer">{hostOf(t.v)}{new URL(t.v).pathname.length > 1 ? new URL(t.v).pathname.slice(0, 24) + (new URL(t.v).pathname.length > 24 ? '…' : '') : ''}</a>
            ) : (
              <span key={j}>{t.v}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

const minutes = (text: string) => Math.max(1, Math.round(text.split(/\s+/).length / 230));

// Links the reader can open as an article (not social posts, players or files).
const NOT_ARTICLE = /(^|\.)(x\.com|twitter\.com|bsky\.app|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|threads\.net|reddit\.com|redd\.it|imgur\.com|t\.co|vimeo\.com|spotify\.com)$/i;
function articleLink(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !NOT_ARTICLE.test(u.hostname) && u.pathname.length > 1 && !/\.(png|jpe?g|gif|webp|mp4|webm|mp3|pdf|zip)$/i.test(u.pathname);
  } catch {
    return false;
  }
}
/** Whether a post can open in the reader: an article, or a post sharing an article link. */
function readableLink(it: Item): boolean {
  if (it.kind === 'article') return !!it.text || articleLink(it.url);
  if (it.kind === 'video') return false;
  return articleLink(it.media.find((m) => m.type === 'link')?.url ?? it.links.find((l) => l !== it.url));
}

function Post({
  ev, r, byId, selected, showReasons, expanded, toggleExpand, whyOpen, setWhy, select, act, markRead, openPanel, compact,
}: {
  ev: Evaluation; r: Reader; byId: ItemIndex; selected: boolean; showReasons: boolean; expanded: boolean; toggleExpand: (id: string) => void;
  whyOpen: boolean; setWhy: (on: boolean) => void; select: (id: string) => void; act: (k: Act, i: Item) => void; markRead: (ids: string[]) => void;
  openPanel: (p: Panel) => void; compact: boolean;
}) {
  const it = ev.item;
  const [colOpen, setColOpen] = useState(false);
  const [newCol, setNewCol] = useState('');
  const src: Source | undefined = r.lib!.sources.find((s) => s.id === it.sourceId);
  const handle = authorLine(it);
  const authorKey = it.author.handle ?? it.author.name;
  const muted = r.spec.excludeAuthors.some((a) => a.toLowerCase() === authorKey.toLowerCase());
  const images = it.media.filter((m) => m.type === 'image');
  const videos = it.media.filter((m) => m.type === 'video');
  const linkMedia = it.media.filter((m) => m.type === 'link');
  const isArticle = it.kind === 'article' && !!it.text;
  const long = !isArticle && (it.text.length > 520 || paragraphs(it.text).length > 5);
  const firstLink = !isArticle && it.kind !== 'video' ? linkMedia[0]?.url ?? it.links.find((l) => l !== it.url) : undefined;
  const label = it.isDemo ? `Demo ${platformLabel(it.platform)}` : src?.label ?? platformLabel(it.platform);
  // The card glows with colour from its own picture, or the poster's avatar when it has none.
  const auraSrc = compact ? undefined : images[0]?.thumb ?? images[0]?.url ?? videos[0]?.thumb ?? linkMedia[0]?.thumb ?? it.author.avatar;
  const lit = litBy(ev, it, label, r.spec.hideNoise);
  const open = () => {
    toggleExpand(it.id);
    if (!expanded) markRead([it.id]);
  };
  const read = () => {
    openReader(it.id);
    markRead([it.id]);
  };
  const canRead = readableLink(it);
  const queued = it.state.collections.includes(READ_LATER);
  // A thread shows as its first post with the next ones peeking below, and opens as one article.
  const thread = useThread(it.id);
  const threadRest = thread ? thread.filter((p) => p.id !== it.id) : [];
  const threadMin = thread ? minutes(thread.map((p) => p.text).join(' ')) : 0;
  const readThread = () => {
    if (!thread) return;
    openReader(thread[0].id);
    markRead(thread.map((p) => p.id));
  };
  // Clicks on the card select it; clicks on its controls and links do their own thing.
  const onCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, input, label, pre, .popover, .why-panel')) return;
    select(it.id);
  };

  return (
    <article
      id={`post-${it.id}`}
      data-id={it.id}
      data-unread={it.state.read ? undefined : '1'}
      className={`post ${selected ? 'sel' : ''} ${it.state.read ? 'read' : 'unread'} ${compact ? 'compact' : ''}`}
      aria-label={`${it.author.name}${it.title ? `: ${it.title}` : ''}`}
      tabIndex={-1}
      onClick={onCardClick}
      style={{ '--av': it.isDemo ? 'var(--hue-demo)' : hueVar(it.platform) } as React.CSSProperties}
    >
      {!compact && <div className={`post-aura ${auraSrc ? '' : 'plain'}`} aria-hidden style={auraSrc ? { backgroundImage: `url("${auraSrc}")` } : undefined} />}
      {showReasons && (
        <div className="post-reasons">
          {ev.hidden.map((h) => <span key={h.key + h.label} className="reason"><Icon name="eyeOff" size={13} /> {h.label}</span>)}
        </div>
      )}
      <div className="post-grid">
        <button className="avatar-btn" onClick={() => openPerson(it)} aria-label={`Everything from ${it.author.name}`}><Avatar it={it} /></button>
        <div className="post-main">
          <header className="post-head">
            <button className="post-name" onClick={() => openPerson(it)} title={`Everything from ${it.author.name}`}>{it.author.name}</button>
            {handle && handle !== it.author.name && <span className="post-handle">{handle}</span>}
            <span className="post-dot" aria-hidden>·</span>
            <time className="post-time" dateTime={it.publishedAt} title={fullTime(it.publishedAt)}>{relTime(it.publishedAt)}</time>
            {!it.state.read && <span className="new-dot" role="img" title="New" aria-label="New" />}
            {thread && <span className="thread-chip" title={`A thread of ${thread.length} posts`}><Icon name="thread" size={12} /> <span className="thread-chip-word">Thread · </span>{thread.length}</span>}
            <span className="post-src" title={`From ${label}`}>
              <span className={`mark ${it.isDemo ? 'demo' : ''}`} style={{ background: it.isDemo ? undefined : hueVar(it.platform) }} aria-hidden />
              <span className="post-src-label">{label === it.author.name ? platformLabel(it.platform) : label}</span>
            </span>
          </header>

          {!ev.visible && !showReasons && (
            <p className="hidden-note"><Icon name="eyeOff" size={14} /> Hidden by your filters: {ev.hidden.map((h) => h.label).join(' · ')}</p>
          )}
          {it.kind === 'repost' && !it.text && <p className="post-kind"><Icon name="sync" size={13} /> Reposted without comment</p>}

          {isArticle ? (
            <div className="post-article">
              {images[0] && !expanded && !compact && (
                <button className="article-hero" onClick={read} aria-label={`Read ${it.title ?? 'the article'}`}>
                  <img src={images[0].thumb ?? images[0].url} alt={images[0].alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
                </button>
              )}
              {it.title && <h2 className="post-title"><button onClick={read}>{it.title}</button></h2>}
              {expanded ? (
                <div className="post-body article-body"><Body text={it.text} /></div>
              ) : (
                !compact && <p className="post-excerpt">{previewText(it.text).slice(0, 360)}</p>
              )}
              <div className="read-row">
                <button className="read-more read-open" onClick={read}>
                  <Icon name="news" size={15} /> Read here{minutes(it.text) > 2 ? <> · {minutes(it.text)} min</> : null}
                </button>
                {expanded ? (
                  <button className="read-more" onClick={open} aria-expanded>Show less</button>
                ) : (
                  !compact && <button className="read-more subtle" onClick={open} aria-expanded={false}>Preview</button>
                )}
              </div>
            </div>
          ) : (
            <>
              {it.title && <h2 className="post-title">{it.title}</h2>}
              {it.text ? (
                <div className={`post-body ${long && !expanded ? 'clamped' : ''} ${compact && !expanded ? 'clamp-compact' : ''}`}><Body text={it.text} /></div>
              ) : it.kind !== 'repost' ? (
                <p className="post-empty">This copy has no text. The archive only recorded that you bookmarked it. Open the original to see it.</p>
              ) : null}
              {(long || compact) && it.text && <button className="read-more" onClick={open} aria-expanded={expanded}>{expanded ? 'Show less' : 'Show more'}</button>}
            </>
          )}

          {it.quoted && !compact && (
            <div className="quote-card">
              <p className="quote-author">{it.quoted.author.name}</p>
              <p className="quote-text">{it.quoted.text}</p>
              {it.quoted.url && <a href={it.quoted.url} target="_blank" rel="noopener noreferrer">Open quoted post</a>}
            </div>
          )}
          {!isArticle && images.length > 0 && !compact && (
            <div className={`media-grid n${Math.min(images.length, 4)}`}>
              {images.slice(0, 4).map((m) => (
                <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer" className="media">
                  <img src={m.thumb ?? m.url} alt={m.alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
          )}
          {isArticle && expanded && images.length > 1 && (
            <div className={`media-grid n${Math.min(images.length - 1, 4)}`}>
              {images.slice(1, 5).map((m) => (
                <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer" className="media">
                  <img src={m.thumb ?? m.url} alt={m.alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
          )}
          {!compact && videos.filter((m) => playable(m.url)).slice(0, 1).map((m) => <InlineVideo key={m.url} m={m} href={it.url} />)}
          {!compact && videos.filter((m) => !playable(m.url)).map((m) => (
            <a key={m.url} className="link-card video" href={m.url} target="_blank" rel="noopener noreferrer">
              {m.thumb && <img src={m.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              <span className="link-host"><Icon name="play" size={12} /> Video · {hostOf(m.url)}</span>
            </a>
          ))}
          {thread && (
            <div className={`thread-strip ${compact ? 'compact' : ''}`}>
              {!compact && (
                <ol className="thread-next" aria-label="Next in this thread">
                  {threadRest.slice(0, 2).map((p) => (
                    <li key={p.id}>
                      <span className="thread-knot" aria-hidden />
                      <span className="thread-text">{previewText(stripMarker(p.text)).slice(0, 180) || 'A picture'}</span>
                    </li>
                  ))}
                  {threadRest.length > 2 && <li className="thread-more"><span className="thread-knot" aria-hidden />{threadRest.length - 2} more</li>}
                </ol>
              )}
              <button className="read-more read-open thread-read" onClick={readThread}>
                <Icon name="news" size={15} /> Read the thread · {thread.length} posts{threadMin > 1 ? <> · {threadMin} min</> : null}
              </button>
            </div>
          )}
          {firstLink && !compact && canRead && (
            <button className="link-read" onClick={read}><Icon name="news" size={14} /> Read article here</button>
          )}
          {firstLink && !compact && (
            <a className="link-card" href={firstLink} target="_blank" rel="noopener noreferrer">
              {linkMedia[0]?.thumb && <img src={linkMedia[0].thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              <span className="link-host"><Icon name="link" size={13} /> {hostOf(firstLink)}</span>
              {linkMedia[0]?.alt ? <span className="link-title">{linkMedia[0].alt}</span> : <span className="link-path">{new URL(firstLink).pathname.length > 1 ? new URL(firstLink).pathname : ''}</span>}
            </a>
          )}

          {(ev.topics.length > 0 || ev.duplicates.length > 0 || (ev.noise.isNoise && !showReasons)) && !compact && (
            <div className="post-tags">
              {ev.topics.slice(0, 3).map((t) => <span key={t.topicId} className="tag topic">#{t.topicName.toLowerCase().replace(/\s+/g, '')}</span>)}
              {ev.duplicates.length > 0 && <span className="tag">also from {ev.duplicates.length === 1 ? '1 more source' : `${ev.duplicates.length} more sources`}</span>}
              {ev.noise.isNoise && !showReasons && <span className="tag noise">{ev.noise.signals[0]?.label ?? 'Noise'}</span>}
            </div>
          )}

          <div className="post-actions" onClickCapture={popAction}>
            <button className={`pa ${it.state.saved ? 'on' : ''}`} onClick={() => act('save', it)} aria-pressed={it.state.saved} title="Save (s)">
              <Icon name={it.state.saved ? 'bookmarkFill' : 'bookmark'} size={17} /> <span>{it.state.saved ? 'Saved' : 'Save'}</span>
            </button>
            {canRead && (
              <button
                className={`pa ${queued ? 'on' : ''}`} aria-pressed={queued} title="Read later (l)"
                onClick={() => void r.changeState([it], { collections: queued ? it.state.collections.filter((c) => c !== READ_LATER) : [...it.state.collections, READ_LATER] }, queued ? 'removed from Read later' : 'added to Read later')}
              >
                <Icon name="inbox" size={17} /> <span>{queued ? 'Queued' : 'Later'}</span>
              </button>
            )}
            <div className="col-wrap">
              <button className={`pa ${it.state.collections.length ? 'on' : ''}`} onClick={() => setColOpen(!colOpen)} aria-expanded={colOpen} title="Add to a collection">
                <Icon name="folder" size={17} /> <span>{it.state.collections.length ? it.state.collections.join(', ') : 'Collect'}</span>
              </button>
              {colOpen && (
                <div className="popover" role="dialog" aria-label="Collections">
                  {r.lib!.collections.map((c) => {
                    const on = it.state.collections.includes(c);
                    return (
                      <label key={c} className="check">
                        <input type="checkbox" checked={on} onChange={() => void r.changeState([it], { collections: on ? it.state.collections.filter((x) => x !== c) : [...it.state.collections, c] }, on ? `removed from ${c}` : `added to ${c}`)} />
                        {c}
                      </label>
                    );
                  })}
                  <form
                    className="pop-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const name = newCol.trim();
                      if (!name) return;
                      await r.changeState([it], { collections: [...it.state.collections, name] }, `added to ${name}`);
                      setNewCol('');
                      void r.reload();
                    }}
                  >
                    <input value={newCol} onChange={(e) => setNewCol(e.target.value)} placeholder="New collection" aria-label="New collection name" maxLength={60} />
                    <button className="btn small" type="submit" disabled={!newCol.trim()}>Add</button>
                  </form>
                </div>
              )}
            </div>
            <ShareToFriends item={it} toast={r.toast} />
            <button className="pa" onClick={() => act('archive', it)} title={it.state.archived ? 'Bring back (e)' : 'Hide from the feed (e)'}>
              <Icon name={it.state.archived ? 'undo' : 'eyeOff'} size={17} /> <span>{it.state.archived ? 'Bring back' : 'Hide'}</span>
            </button>
            <a className="pa open" href={it.url} target="_blank" rel="noopener noreferrer" title="Open the original (v)">
              <Icon name="external" size={16} /> <span>{originalLabel(it)}</span>
            </a>
            <button className={`lit ${whyOpen ? 'on' : ''}`} onClick={() => setWhy(!whyOpen)} aria-expanded={whyOpen} aria-label={`Why: ${lit.lead} ${lit.reason}${lit.extra ? `, ${lit.extra}` : ''}`} title="Why this is in your feed (w)">
              <span className="lit-lead">{lit.lead}</span> <b>{lit.reason}</b>{lit.extra && <span className="lit-extra"> · {lit.extra}</span>}
            </button>
          </div>

          {!compact && <FriendThread item={it} version={r.lib} toast={r.toast} />}

          {whyOpen && (
            <div className="why-panel" role="group" aria-label={`Why this post from ${it.author.name} is here`}>
              <ul>
                {ev.visible && ev.matched.map((m) => <li key={m.label}>{m.label}</li>)}
                {ev.visible && !ev.matched.length && <li>Passes every rule in this feed{r.spec.read === 'unread' && it.state.read ? '. Seen just now, so it stays until the rules change' : ''}.</li>}
                {ev.topics.length > 0 && <li>Topics: {ev.topics.map((t) => `${t.topicName} (“${t.term}”)`).join(', ')}</li>}
                {it.langGuessed && it.lang && <li>Language: guessed as {it.lang.toUpperCase()} from common words; the source gave none.</li>}
                <li>
                  Noise check: {ev.noise.signals.length ? ev.noise.signals.map((s) => `${s.label}, ${s.evidence}`).join('; ') : 'no signals'}
                  {ev.noise.overridden ? ' · your override applies' : ''}
                </li>
                {ev.duplicates.length > 0 && <li>Also arrived {ev.duplicates.length === 1 ? 'once more' : `${ev.duplicates.length} more times`}: {ev.duplicates.map((id) => { const d = byId.get(id); const s = r.lib!.sources.find((x) => x.id === d?.sourceId); return s?.label ?? d?.platform; }).join(', ')}. Showing the fullest copy.</li>}
                {ev.duplicateOf && <li>This is a duplicate. The fuller copy came from {r.lib!.sources.find((s) => s.id === byId.get(ev.duplicateOf!)?.sourceId)?.label ?? 'another source'}.</li>}
                <li>Source: {src?.label ?? 'unknown'} via {it.provenance.via === 'feed' ? 'its public feed' : it.provenance.via === 'api' ? 'the official API' : it.provenance.via === 'import' ? `an imported file${it.provenance.fileName ? ` (${it.provenance.fileName})` : ''}` : it.provenance.via === 'friend' ? 'an end-to-end encrypted share from a friend' : 'the demo library'}, fetched {agoText(it.ingestedAt)}. Posted {fullTime(it.publishedAt)}.</li>
              </ul>
              <div className="why-actions">
                <button className="btn small" onClick={() => void r.changeState([it], { noiseOverride: ev.noise.isNoise ? true : false }, ev.noise.isNoise ? 'marked not noise' : 'marked as noise')}>
                  {ev.noise.isNoise ? 'Not noise' : 'This is noise'}
                </button>
                {ev.noise.overridden && <button className="btn small ghost" onClick={() => void r.changeState([it], { noiseOverride: null }, 'cleared noise override')}>Use the rules again</button>}
                <button
                  className="btn small"
                  onClick={() =>
                    r.setSpec((s) => ({ ...s, excludeAuthors: muted ? s.excludeAuthors.filter((a) => a.toLowerCase() !== authorKey.toLowerCase()) : [...s.excludeAuthors, authorKey] }), muted ? `unmute ${it.author.name}` : `mute ${it.author.name}`)
                  }
                >
                  <Icon name="mute" size={15} /> {muted ? 'Unmute' : 'Mute'} {it.author.name}
                </button>
                <button className="btn small" onClick={() => r.setSpec((s) => ({ ...s, authors: [authorKey] }), `only ${it.author.name}`)}>Only this author</button>
                <button className="btn small" onClick={() => openRelated(it.id)} title="More like this (i)"><Icon name="sparkle" size={15} /> More like this</button>
                <button className="btn small ghost" onClick={() => act('read', it)}>{it.state.read ? 'Mark unseen' : 'Mark seen'}</button>
                {src && <button className="btn small ghost" onClick={() => openPanel('sources')}>Manage source</button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** One line on why a post is lit (in the feed) or set aside. The Why panel has the full story. */
function litBy(ev: Evaluation, it: Item, sourceLabel: string, hideNoise: boolean): { lead: string; reason: string; extra?: string } {
  if (!ev.visible) return { lead: 'set aside by', reason: ev.hidden[0]?.label ?? 'your rules' };
  const extra = ev.noise.overridden ? 'your call' : hideNoise && !ev.noise.isNoise ? 'no noise' : undefined;
  if (ev.matched[0]) return { lead: 'lit by', reason: ev.matched[0].label, extra };
  if (ev.topics[0]) return { lead: 'lit by', reason: `#${ev.topics[0].topicName.toLowerCase().replace(/\s+/g, '')}`, extra };
  return { lead: 'from', reason: sourceLabel === it.author.name ? platformLabel(it.platform) : sourceLabel, extra };
}

const FIRST_EXAMPLES = [
  { label: 'YouTube', text: 'MKBHD on YouTube', color: '#ff4e45' },
  { label: 'Instagram', text: '@natgeo on Instagram', color: '#e1306c' },
  { label: 'Bluesky', text: '@bsky.app on Bluesky', color: '#3b82f6' },
  { label: 'Reddit', text: 'r/LocalLLaMA', color: '#ff7a1a' },
  { label: 'Substack', text: 'Astral Codex Ten on Substack', color: '#ff8a3d' },
  { label: 'Blog', text: 'simonwillison.net', color: '#4fe0c6' },
];

function FirstRun({ r, openPanel, ask }: { r: Reader; openPanel: (p: Panel) => void; ask: (text: string, send?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState('');
  return (
    <div className="first-run">
      <div className="first-sky" aria-hidden><span /><span /><span /></div>
      <div className="first-hero">
        <img className="first-mark" src="/icon.svg" alt="" width={56} height={56} />
        <h1 className="first-title">Your feeds, <span className="first-lit">on your terms.</span></h1>
        <p className="first-sub">Tell Aurora who you follow, anywhere. The AI builds a connector for each one on this computer, then reads the noise so you don't have to.</p>
      </div>
      <form className="first-ask" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { ask(`Follow these: ${v.trim()}`); setV(''); } }}>
        <span className="agent-orb" aria-hidden />
        <textarea value={v} onChange={(e) => setV(e.target.value)} rows={2} placeholder="MKBHD on YouTube, @natgeo on Instagram, r/LocalLLaMA, a Substack…" aria-label="What to follow" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} />
        <button className="btn primary" type="submit" disabled={!v.trim()}>Follow</button>
      </form>
      <div className="first-chips" role="group" aria-label="Examples to add">
        {FIRST_EXAMPLES.map((x) => (
          <button key={x.text} type="button" className="first-chip" onClick={() => setV((cur) => (cur.trim() ? `${cur.trim().replace(/,$/, '')}, ${x.text}` : x.text))}>
            <span className="first-chip-dot" style={{ background: x.color }} />{x.label}
          </button>
        ))}
      </div>
      <div className="first-actions">
        <button className="first-card follows" onClick={() => openPanel('follows')}>
          <span className="first-card-title">Bring your follows</span>
          <span className="first-card-sub">Drop your YouTube, Instagram, TikTok, Mastodon or Reddit export, or type your Bluesky handle. Everyone you follow, in one move.</span>
        </button>
        <button className="first-card" onClick={() => openPanel('sources')}>
          <span className="first-card-title">Follow a feed or import a file</span>
          <span className="first-card-sub">A blog or newsletter feed, your X archive (tweets, likes, bookmarks), or browser bookmarks.</span>
        </button>
        <button
          className="first-card demo"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const out = await api.loadDemo();
              await r.reload();
              r.toast(`Loaded ${out.added} fictional demo posts. Remove them any time in Sources.`);
            } catch (e) {
              r.toast((e as Error).message, { tone: 'error' });
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="first-card-title"><span className="mark demo" /> Try the demo library</span>
          <span className="first-card-sub">36 made-up posts to try the filters on. Clearly marked, never mixed with yours.</span>
        </button>
      </div>
      <ul className="first-promises">
        <li><Icon name="home" size={14} /> Runs on this computer</li>
        <li><Icon name="check" size={14} /> Never likes, follows or posts for you</li>
        <li><Icon name="layers" size={14} /> Connectors run in a sandbox</li>
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ rules

/** Plain-English rules the AI applies post by post, with live labelling progress. */
function AiRulesCard({ r, ask }: { r: Reader; ask: (text: string, send?: boolean) => void }) {
  const lib = r.lib!;
  const rules = lib.aiRules ?? [];
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const rule of rules) out[rule.id] = Object.values(lib.labels?.[rule.id] ?? {}).filter((l) => l.match).length;
    return out;
  }, [rules, lib.labels]);
  const verb = { hide: 'Hides', only: 'Only', tag: 'Marks' } as const;
  return (
    <section className="rules-card ai-rules">
      <h3 className="eyebrow">AI rules{rules.length > 0 && !r.spec.aiRules ? ' · off in this view' : ''}</h3>
      {rules.length === 0 && <p className="ai-rules-empty">Say what you want gone or kept, in your own words. The AI reads each post.</p>}
      {rules.map((rule) => {
        const p = lib.aiProgress?.[rule.id];
        const pending = p && p.done < p.total;
        return (
          <div key={rule.id} className={`ai-rule ${rule.enabled ? '' : 'off'}`}>
            <label className="ai-rule-main">
              <span className="ai-rule-name">{rule.name}</span>
              <span className="ai-rule-sub">
                {verb[rule.action]} · {counts[rule.id] ?? 0} {rule.action === 'only' ? 'kept' : 'matched'}
                {pending && rule.enabled ? ` · reading ${p.done}/${p.total}` : ''}
              </span>
              <span className="switch"><input type="checkbox" checked={rule.enabled} onChange={async () => { await api.patchAiRule(rule.id, { enabled: !rule.enabled }); await r.reload(); }} aria-label={`Turn ${rule.enabled ? 'off' : 'on'} ${rule.name}`} /></span>
            </label>
            <button className="icon-btn small ai-rule-del" title="Delete rule" aria-label={`Delete ${rule.name}`} onClick={async () => { await api.deleteAiRule(rule.id); await r.reload(); r.toast(`Deleted rule “${rule.name}”`); }}><Icon name="trash" size={14} /></button>
          </div>
        );
      })}
      <button className="btn small ghost ai-rule-add" onClick={() => ask('Hide posts that are ', false)}><Icon name="sparkle" size={15} /> New rule in plain English</button>
    </section>
  );
}

function RulesPane({ r, openPanel, ask, aiReady }: { r: Reader; openPanel: (p: Panel) => void; ask: (text: string, send?: boolean) => void; aiReady: boolean }) {
  const lib = r.lib!;
  const res = r.result!;
  const chips = clauseChips(r);
  const toggle = (on: boolean, label: string, fn: (s: FilterSpec) => FilterSpec) => (
    <label className="rule-toggle">
      <span>{label}</span>
      <span className="switch"><input type="checkbox" checked={on} onChange={() => r.setSpec(fn, `${on ? 'turn off' : 'turn on'} “${label}”`)} /></span>
    </label>
  );
  const people = useMemo(() => {
    const seen = new Map<string, Item>();
    for (const ev of res.visible) {
      const it = ev.item;
      if (it.state.read || !it.author.avatar) continue;
      const k = it.author.handle ?? it.author.name;
      if (!seen.has(k)) seen.set(k, it);
      if (seen.size >= 12) break;
    }
    return [...seen.values()];
  }, [res.visible]);
  if (!lib.items.length) return <aside className="rules-pane" aria-label="Your rules" />;
  return (
    <aside className="rules-pane" aria-label="Your rules">
      <section className="rules-card">
        <h3 className="eyebrow">Your rules</h3>
        <p className="rules-lead">
          <strong>{res.visible.length.toLocaleString()}</strong> in the feed · <button className="link-btn" onClick={() => r.setShowHidden(!r.showHidden)}>{r.showHidden ? 'back to the feed' : `${res.hidden.length.toLocaleString()} set aside`}</button>
        </p>
        {toggle(r.spec.read === 'unread', 'Only posts I have not seen', (s) => ({ ...s, read: s.read === 'unread' ? 'any' : 'unread' }))}
        {toggle(r.spec.hideNoise, 'Set noise aside', (s) => ({ ...s, hideNoise: !s.hideNoise }))}
        {toggle(r.spec.hideDuplicates, 'One copy of each story', (s) => ({ ...s, hideDuplicates: !s.hideDuplicates }))}
        {chips.filter((c) => c.key !== 'read' && c.key !== 'hideNoise').length > 0 && (
          <div className="chip-row" role="list" aria-label="Other active rules">
            {chips.filter((c) => c.key !== 'read' && c.key !== 'hideNoise').map((c) => (
              <span key={c.key + c.label} className={`chip on ${c.negative ? 'neg' : ''}`} role="listitem">
                {c.label}
                <button aria-label={`Remove filter ${c.label}`} onClick={() => r.setSpec((s) => c.clear(s), `remove “${c.label}”`)}><Icon name="x" size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="rules-actions">
          <button className="btn small" onClick={() => openPanel('filters')}><Icon name="sliders" size={15} /> All filters</button>
          <button className="btn small ghost" onClick={() => void r.undo()} title="Undo (z)"><Icon name="undo" size={15} /> Undo</button>
        </div>
      </section>
      <AiRulesCard r={r} ask={ask} />
      <WeekCard r={r} />
      <TasteCard r={r} aiReady={aiReady} />
      <FriendsWeekCard open={() => openPanel('friends')} version={r.lib} />
      {people.length > 0 && (
        <section className="rules-card">
          <h3 className="eyebrow">New in this feed from</h3>
          <div className="people">
            {people.map((it) => (
              <button key={it.id} className="person" title={it.author.name} aria-label={`Everything from ${it.author.name}`} onClick={() => openPerson(it)}>
                <img src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="rules-card">
        <h3 className="eyebrow">Following</h3>
        <ul className="following">
          {lib.sources.slice(0, 8).map((s) => (
            <li key={s.id}>
              <span className={`mark ${s.isDemo ? 'demo' : ''}`} style={{ background: s.isDemo ? undefined : hueVar(s.platform) }} aria-hidden />
              <span className="following-name">{s.label}</span>
              <span className={`following-status ${s.status === 'error' || s.status === 'blocked' ? 'warn' : ''}`} title={s.statusDetail ?? undefined}>
                {s.status === 'syncing' ? 'syncing' : s.status === 'error' ? 'error' : s.status === 'blocked' ? 'needs you' : s.lastSyncAt ? agoText(s.lastSyncAt) : ''}
              </span>
            </li>
          ))}
        </ul>
        <button className="btn small ghost" onClick={() => openPanel('sources')}><Icon name="plus" size={15} /> Follow or import</button>
      </section>
      <p className="rules-foot">Everything here is local. Nothing you do likes, follows or unbookmarks anything on the original sites. <kbd>?</kbd> shortcuts</p>
    </aside>
  );
}

// ------------------------------------------------------------------ chrome

function TabBar({ r, panel, openPanel, agentOpen, openAgent }: { r: Reader; panel: Panel; openPanel: (p: Panel) => void; agentOpen: boolean; openAgent: () => void }) {
  const chips = clauseChips(r).length;
  return (
    <nav className="tabbar" aria-label="Main">
      <button className={!panel && !agentOpen ? 'on' : ''} onClick={() => openPanel(null)}><Icon name="inbox" /><span>Feed</span></button>
      <button className={`tab-ask ${agentOpen ? 'on' : ''}`} onClick={openAgent}><span className="agent-orb small" aria-hidden /><span>Ask</span></button>
      <button className={panel === 'views' ? 'on' : ''} onClick={() => openPanel('views')}><Icon name="layers" /><span>Views</span></button>
      <button className={panel === 'filters' ? 'on' : ''} onClick={() => openPanel('filters')}><Icon name="sliders" /><span>Rules{chips ? ` · ${chips}` : ''}</span></button>
      <button className={panel === 'sources' ? 'on' : ''} onClick={() => openPanel('sources')}><Icon name="sync" /><span>Sources</span></button>
    </nav>
  );
}

/**
 * Where toasts sit: just above whatever floats at the bottom (the lens dock, the phone tab bar,
 * the listen player), so a toast never covers them. null leaves it to the stylesheet (Ambient,
 * the reader and open sheets have their own placement).
 */
function useToastBottom(active: boolean) {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      if (document.documentElement.classList.contains('ambient-on') || document.querySelector('[aria-modal="true"]')) return setBottom(null);
      let top = Infinity;
      for (const el of document.querySelectorAll<HTMLElement>('.lens-dock, .tabbar, .page-dock, .lq')) {
        const b = el.getBoundingClientRect();
        if (b.height && b.width && b.top < window.innerHeight) top = Math.min(top, b.top);
      }
      setBottom(Number.isFinite(top) ? Math.max(20, Math.round(window.innerHeight - top + 10)) : null);
    };
    measure();
    const t = window.setInterval(measure, 500);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return bottom;
}

function Toasts({ r }: { r: Reader }) {
  const bottom = useToastBottom(r.toasts.length > 0);
  return (
    <div className="toasts" role="status" aria-live="polite" style={bottom == null ? undefined : { bottom }}>
      {r.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : t.tone === 'alert' ? 'alert-toast' : ''}`}>
          <span>{t.text}</span>
          {t.action && <button className="link-btn" onClick={() => { t.action!.run(); r.dismissToast(t.id); }}>{t.action.label}</button>}
          {t.undo && <button className="link-btn" onClick={() => { t.undo!(); r.dismissToast(t.id); }}>Undo</button>}
          <button className="icon-btn small" aria-label="Dismiss" onClick={() => r.dismissToast(t.id)}><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

function DialogDiv(props: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useDialog<HTMLDivElement>();
  return <div ref={ref} {...props} />;
}

const READER_KEYS: [string, string][] = [
  ['j / k', 'Scroll down / up'], ['g / G', 'Top / end'], ['h', 'Highlight the selected text'], ['l', 'Listen'],
  ['+ / -', 'Text size'], ['o', 'Open the original'], ['Esc', 'Close the reader'],
];

const COLUMN_KEYS: [string, string][] = [
  ['← / → or H / L', 'Previous / next column'], ['1–9', 'Go to column 1 to 9'], ['j / k', 'Next / previous post in the column'],
  ['[ / ]', 'Move the column left / right'], ['n', 'Add a column'], ['q', 'Close the column'], ['c', 'Back to one feed'],
];

function Help({ close }: { close: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const keys: [string, string][] = [
    ['j / k', 'Next / previous post'], ['Enter / o', 'Open the article, or expand the post'], ['r', 'Read in the reader'], ['l', 'Add to or remove from Read later'],
    ['s', 'Save or unsave'], ['w', 'Why this post is here'], ['i', 'More like this'], ['u / m', 'Toggle seen'], ['e', 'Hide from the feed'],
    ['v', 'Open the original'], ['/', 'Search'], ['f', 'Filters'], ['h', 'Show what is set aside'], ['z', 'Undo'],
    ['p', 'Play or pause listening'], ['Shift P', 'Add the post to the listen queue'],
    ['x', 'Clear all filters'], ['d', 'Compact feed'], ['c', 'Columns: several views side by side'], ['t', 'Triage: clear new posts one at a time'], ['g', 'Sources and imports'], ['.', 'Ask your feed'], ['⌘K / Ctrl K', 'Search everything'],
    ['⌘1–9 / Alt 1–9', 'Switch profile (1 is All)'], ['Tab', 'Move through the selected post’s actions'], ['?', 'This list'], ['Esc', 'Close or go back'],
  ];
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>Keyboard</h2><button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button></div>
        <dl className="keys">
          {keys.map(([k, v]) => (
            <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
          ))}
        </dl>
        <h3 className="help-sub">In Columns</h3>
        <dl className="keys">
          {COLUMN_KEYS.map(([k, v]) => (
            <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
          ))}
        </dl>
        <h3 className="help-sub">In the reader</h3>
        <dl className="keys">
          {READER_KEYS.map(([k, v]) => (
            <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
          ))}
        </dl>
        <p className="help-note">Search syntax: <code>"exact phrase"</code> <code>-word</code> <code>from:handle</code> <code>site:example.com</code></p>
      </div>
    </div>
  );
}

export { activeClauses };
