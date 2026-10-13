import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyFilters, DEFAULT_SPEC, normalizeSpec, type FilterResult } from '../../core/filter.ts';
import { ALL_PROFILE, findProfile, scopeLibrary, slug } from '../../core/profiles.ts';
import type { FilterSpec, Item, ItemState, Library, Profile } from '../../core/types.ts';
import { api } from './api.ts';
import { loadLibrary } from './libraryLoader.ts';

export type ServerEvent =
  | { type: 'library'; reason?: string }
  | { type: 'agent'; threadId: string; event: { id: number; type: string; data: any; at: string } }
  | { type: 'thread'; threadId: string; status: string; kind?: string; title?: string | null; parentId?: string | null }
  | { type: 'delta'; threadId: string; text: string }
  | { type: 'ui'; action: { kind: string; [k: string]: any } };

export interface BuiltinView {
  id: string;
  name: string;
  hint: string;
  spec: FilterSpec;
}

export const BUILTIN_VIEWS: BuiltinView[] = [
  { id: 'worth', name: 'Worth reading', hint: 'Unread, noise set aside', spec: { ...DEFAULT_SPEC, read: 'unread', hideNoise: true } },
  { id: 'saved', name: 'Saved', hint: 'Everything you kept', spec: { ...DEFAULT_SPEC, saved: 'saved', archived: 'any' } },
  { id: 'everything', name: 'Everything', hint: 'No filters except archive', spec: { ...DEFAULT_SPEC } },
  { id: 'archive', name: 'Archive', hint: 'Things you put away', spec: { ...DEFAULT_SPEC, archived: 'only' } },
];

export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  tone?: 'info' | 'error' | 'alert';
  action?: { label: string; run: () => void };
}

type Undoable = { label: string; run: () => void | Promise<void> };

const LS_SPEC = 'sr.spec.v1';
const LS_VIEW = 'sr.view.v1';
const LS_PAGE = 'sr.page.v1';
const LS_PROFILE = 'sr.profile';

/** Per-profile storage key. "All" keeps the original keys, so nothing moves for people without profiles. */
export function profileKey(base: string, profileId: string) {
  return profileId === ALL_PROFILE ? base : `${base}.${profileId}`;
}

/** ?p= in the address wins (a link or bookmark to a profile), then the last one used here. */
function initialProfile(): string {
  try {
    const q = new URLSearchParams(location.search).get('p');
    if (q) return q;
  } catch {
    /* no location */
  }
  return loadLocal<string>(LS_PROFILE) ?? ALL_PROFILE;
}

function loadLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function saveLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export function sameSpec(a: FilterSpec, b: FilterSpec) {
  return JSON.stringify(normalizeSpec(a)) === JSON.stringify(normalizeSpec(b));
}

export function useReader() {
  const [rawLib, setLib] = useState<Library | null>(null);
  // The active profile. It may start as a name from ?p= until the library arrives to resolve it.
  const [profileId, setProfileId] = useState<string>(initialProfile);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpecRaw] = useState<FilterSpec>(() => normalizeSpec(loadLocal<FilterSpec>(profileKey(LS_SPEC, profileId)) ?? BUILTIN_VIEWS[0].spec));
  const [viewId, setViewId] = useState<string | null>(() => loadLocal<string>(profileKey(LS_VIEW, profileId)) ?? 'worth');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const undoStack = useRef<Undoable[]>([]);
  const toastSeq = useRef(0);

  // The library syncs in week-sized chunks and only changed ones are fetched (libraryLoader.ts).
  // Pictures are routed through the image proxy chunk by chunk, as proxyLibrary does for a whole
  // library. On a cold start the newest posts arrive first.
  const reload = useCallback(async () => {
    try {
      const l = await loadLibrary((first) => setLib(first));
      setLoadError(null);
      if (!l) return rawLibRef.current;
      setLib(l);
      return l;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, []);

  // Live updates: one event stream from the server. Library changes refresh the library; agent
  // progress and UI actions go to whoever subscribed. A slow poll stays as a safety net.
  const listeners = useRef(new Set<(e: ServerEvent) => void>());
  const subscribe = useCallback((fn: (e: ServerEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let opened = false;
    es.onopen = () => {
      setLive(true);
      if (opened) void reload(); // reconnected after a server restart
      opened = true;
    };
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      let evt: ServerEvent;
      try {
        evt = JSON.parse(m.data);
      } catch {
        return;
      }
      if (evt.type === 'library') void reload();
      for (const fn of listeners.current) fn(evt);
    };
    return () => es.close();
  }, [reload]);
  const profiles = rawLib?.profiles ?? [];
  const profile: Profile | null = profileId === ALL_PROFILE ? null : profiles.find((p) => p.id === profileId) ?? null;
  // Scoping is a cheap Set lookup per item, done here so switching profiles needs no round trip.
  const lib = useMemo(() => (rawLib ? scopeLibrary(rawLib, profile ? profile.id : ALL_PROFILE) : null), [rawLib, profile]);

  const anySyncing = lib?.sources.some((s) => s.status === 'syncing') ?? false;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, anySyncing && !live ? 3000 : live ? 300_000 : 60_000);
    return () => clearInterval(t);
  }, [reload, anySyncing, live]);
  const [pageId, setPageIdRaw] = useState<string | null>(() => loadLocal<string>(profileKey(LS_PAGE, profileId)));
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  const setPageId = useCallback((id: string | null) => {
    setPageIdRaw(id);
    saveLocal(profileKey(LS_PAGE, profileRef.current), id);
  }, []);

  /** Switch profile: each one remembers its own filter, view and page. */
  const switchProfile = useCallback((key: string, opts: { quiet?: boolean } = {}) => {
    // An id not in the library yet (a profile made a moment ago) is trusted; the effect below
    // falls back to All once the library arrives if it really does not exist.
    const next = key === ALL_PROFILE ? ALL_PROFILE : findProfile(rawLibRef.current?.profiles, key)?.id ?? key;
    if (next !== profileRef.current) {
      profileRef.current = next;
      setProfileId(next);
      setSpecRaw(normalizeSpec(loadLocal<FilterSpec>(profileKey(LS_SPEC, next)) ?? BUILTIN_VIEWS[0].spec));
      setViewId(loadLocal<string>(profileKey(LS_VIEW, next)) ?? 'worth');
      setPageIdRaw(loadLocal<string>(profileKey(LS_PAGE, next)));
      setSelectedId(null);
      setShowHidden(false);
      undoStack.current = [];
    }
    saveLocal(LS_PROFILE, next);
    try {
      const url = new URL(location.href);
      const p = findProfile(rawLibRef.current?.profiles, next);
      if (next === ALL_PROFILE) url.searchParams.delete('p');
      else url.searchParams.set('p', p ? slug(p.name) || p.id : next);
      history.replaceState(history.state, '', url);
    } catch {
      /* no history */
    }
    if (!opts.quiet || rawLibRef.current?.activeProfile !== next) void api.setActiveProfile(next).catch(() => {});
  }, []);
  const rawLibRef = useRef(rawLib);
  rawLibRef.current = rawLib;

  // Once the library arrives: resolve ?p= names, drop a deleted profile, and tell the server.
  useEffect(() => {
    if (!rawLib) return;
    const known = profileId === ALL_PROFILE || rawLib.profiles?.some((p) => p.id === profileId);
    if (!known) switchProfile(findProfile(rawLib.profiles, profileId)?.id ?? ALL_PROFILE, { quiet: true });
    else if ((rawLib.activeProfile ?? ALL_PROFILE) !== profileId && !activeSynced.current) void api.setActiveProfile(profileId).catch(() => {});
    activeSynced.current = true;
  }, [rawLib, profileId, switchProfile]);
  const activeSynced = useRef(false);

  useEffect(() => {
    void reload();
    // Server copy of the filter wins on first load if this browser has none.
    if (!loadLocal(profileKey(LS_SPEC, profileId))) {
      api.getSetting<{ spec: FilterSpec; viewId: string | null }>(profileKey('ui.current', profileId)).then((r) => {
        if (r.value?.spec) {
          setSpecRaw(normalizeSpec(r.value.spec));
          setViewId(r.value.viewId ?? null);
        }
      }).catch(() => {});
    }
  }, [reload]);

  // Persist the current filter locally and on the server (debounced), per profile.
  useEffect(() => {
    if (profileId !== ALL_PROFILE && !profiles.some((p) => p.id === profileId)) return; // not resolved yet
    saveLocal(profileKey(LS_SPEC, profileId), spec);
    saveLocal(profileKey(LS_VIEW, profileId), viewId);
    const t = setTimeout(() => void api.putSetting(profileKey('ui.current', profileId), { spec, viewId }).catch(() => {}), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, viewId, profileId, profiles.length]);

  const toast = useCallback((text: string, opts: { undo?: () => void; tone?: 'info' | 'error' | 'alert'; ms?: number; action?: { label: string; run: () => void } } = {}) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts.slice(-2), { id, text, undo: opts.undo, tone: opts.tone, action: opts.action }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), opts.ms ?? (opts.undo ? 6500 : 4000));
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const pushUndo = useCallback((u: Undoable) => {
    undoStack.current.push(u);
    if (undoStack.current.length > 50) undoStack.current.shift();
  }, []);

  const undo = useCallback(async () => {
    const u = undoStack.current.pop();
    if (!u) {
      toast('Nothing to undo');
      return;
    }
    await u.run();
    toast(`Undid: ${u.label}`);
  }, [toast]);

  /** Change the filter. Every change is undoable. */
  const setSpec = useCallback(
    (next: FilterSpec | ((s: FilterSpec) => FilterSpec), label = 'filter change', keepView = false) => {
      setSpecRaw((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        if (sameSpec(prev, value)) return prev;
        const prevView = viewIdRef.current;
        pushUndo({
          label,
          run: () => {
            setSpecRaw(prev);
            setViewId(prevView);
          },
        });
        return value;
      });
      setPageId(null);
      if (!keepView) setViewId((v) => v);
    },
    [pushUndo, setPageId],
  );
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  const openView = useCallback(
    (id: string, s: FilterSpec, name: string) => {
      setSpec(normalizeSpec(s), `open “${name}”`);
      setViewId(id);
      setShowHidden(false);
      setPageId(null);
    },
    [setSpec, setPageId],
  );

  const sourceLabels = useMemo(() => Object.fromEntries((lib?.sources ?? []).map((s) => [s.id, s.label])), [lib?.sources]);

  // Posts read during this visit stay put, so the list does not jump under the reader.
  const [keepRead, setKeepRead] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setKeepRead(new Set());
  }, [spec]);
  const keepVisible = useCallback((ids: string[]) => setKeepRead((k) => new Set([...k, ...ids])), []);

  // The previous result lets a few changed posts (marked read while scrolling) be re-checked
  // alone instead of filtering the whole library again.
  const lastResult = useRef<FilterResult | null>(null);
  const result: FilterResult | null = useMemo(() => {
    if (!lib) return null;
    return (lastResult.current = applyFilters(lib.items, spec, { topics: lib.topics, sourceLabels, keepRead, ai: { rules: lib.aiRules, labels: lib.labels } }, lastResult.current));
  }, [lib, spec, sourceLabels, keepRead]);

  /** Optimistic local-state change on items, with undo. Never touches the source platform. */
  const changeState = useCallback(
    async (items: Item[], patch: Partial<ItemState>, label: string, opts: { silent?: boolean; quiet?: boolean } = {}): Promise<(() => void) | undefined> => {
      if (!items.length || !lib) return;
      const before = new Map(items.map((i) => [i.id, i.state]));
      const apply = (fn: (i: Item) => ItemState) =>
        setLib((l) => (l ? { ...l, items: l.items.map((i) => (before.has(i.id) ? { ...i, state: fn(i) } : i)) } : l));
      apply((i) => ({ ...i.state, ...patch }));
      try {
        await api.setState(items.map((i) => i.id), patch);
      } catch (e) {
        apply((i) => before.get(i.id)!);
        toast(`Could not save: ${(e as Error).message}`, { tone: 'error' });
        return;
      }
      const revert = async () => {
        apply((i) => before.get(i.id)!);
        // Restore each item's previous state exactly.
        const groups = new Map<string, string[]>();
        for (const [id, st] of before) {
          const key = JSON.stringify(st);
          groups.set(key, [...(groups.get(key) ?? []), id]);
        }
        for (const [key, ids] of groups) {
          const st = JSON.parse(key) as ItemState;
          await api.setState(ids, { read: st.read, saved: st.saved, archived: st.archived, collections: st.collections, noiseOverride: st.noiseOverride ?? null });
        }
      };
      const entry: Undoable = { label, run: revert };
      const undoThis = () => {
        const i = undoStack.current.lastIndexOf(entry);
        if (i >= 0) undoStack.current.splice(i, 1);
        void revert();
      };
      // Opening a post marks it read silently; that is not a change worth undoing with z.
      if (!opts.silent) pushUndo(entry);
      // Quiet changes (Triage) are undoable with z but show no toast; the caller gets the undo.
      if (!opts.silent && !opts.quiet) toast(label.charAt(0).toUpperCase() + label.slice(1), { undo: undoThis });
      return undoThis;
    },
    [lib, pushUndo, toast],
  );

  return {
    lib, setLib, loadError, reload, keepVisible,
    spec, setSpec, viewId, setViewId, openView,
    selectedId, setSelectedId,
    showHidden, setShowHidden,
    result, sourceLabels,
    changeState, undo, pushUndo,
    toasts, toast, dismissToast,
    subscribe, live, pageId, setPageId,
    rawLib, profiles, profile, profileId: profile ? profile.id : ALL_PROFILE, switchProfile,
  };
}

export type Reader = ReturnType<typeof useReader>;
