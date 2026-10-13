// The library on the phone: synced in chunks and kept on disk (librarySync.ts), kept fresh by the
// event stream, filtered on the phone by the same engine the desktop uses (core/filter.ts).
// With no connection the phone shows what it had and queues read, save and hide changes, which
// reach the computer in order once it is back.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { applyFilters, DEFAULT_SPEC, type Evaluation, type FilterResult } from '../../core/filter.ts';
import { ALL_PROFILE, scopeLibrary } from '../../core/profiles.ts';
import { groupThreads, threadFor, type ThreadGroups } from '../../core/threads.ts';
import type { FilterSpec, Item, ItemState, Library, Profile } from '../../core/types.ts';
import { api, isOffline, openEvents, type ServerEvent } from './api';
import { readCache, writeCache } from './cache';
import * as haptics from './haptics';
import { imgProxyReady, resetImgProxy } from './images';
import { librarySavedAt, loadCachedLibrary, resetLibrarySync, syncLibrary } from './librarySync';
import { setSettings, useSettings } from './settings';

export interface Lens {
  id: string;
  name: string;
  spec: FilterSpec;
}

/** The desktop's built-in views, minus Archive, then the user's saved views. */
export const BUILTIN_LENSES: Lens[] = [
  { id: 'worth', name: 'Worth reading', spec: { ...DEFAULT_SPEC, read: 'unread', hideNoise: true } },
  { id: 'saved', name: 'Saved', spec: { ...DEFAULT_SPEC, saved: 'saved', archived: 'any' } },
  { id: 'everything', name: 'Everything', spec: { ...DEFAULT_SPEC } },
];

export interface Receipt {
  id: number;
  text: string;
  undo?: () => void;
}

interface Store {
  /** The library as the active profile sees it. */
  lib: Library | null;
  /** Every profile, the active one (null for All) and a switch that the phone remembers. */
  profiles: Profile[];
  profile: Profile | null;
  profileId: string;
  setProfile: (id: string) => void;
  /** Unread, not set aside, per profile id (and "all"), for the switcher. */
  profileCounts: Record<string, number>;
  error: string | null;
  loading: boolean;
  /** The computer cannot be reached; the phone shows the library it saved. */
  offline: boolean;
  /** When the saved library was last brought up to date (ISO), or null. */
  savedAt: string | null;
  /** Read, save and hide changes waiting for the computer. */
  queued: number;
  refresh: () => Promise<void>;
  sourceLabels: Record<string, string>;
  lenses: (Lens & { n: number })[];
  lensId: string;
  setLens: (id: string) => void;
  result: FilterResult | null;
  byId: Map<string, Item>;
  /** One author's chains of posts, read as one card and one article (core/threads.ts). */
  threads: ThreadGroups | null;
  evaluate: (spec: FilterSpec) => FilterResult | null;
  save: (item: Item) => void;
  hide: (item: Item) => void;
  markRead: (item: Item) => void;
  /** Adds the post to Read later, or takes it out. */
  later: (item: Item) => void;
  /** A quiet local state change (Triage): no receipt, the caller shows its own undo. */
  setItemState: (ids: string[], patch: Partial<ItemState>) => void;
  receipt: Receipt | null;
  dismissReceipt: () => void;
  notify: (text: string) => void;
  subscribe: (f: (e: ServerEvent) => void) => () => void;
}

/** A state change made while offline, waiting to be sent. */
interface Pending {
  ids: string[];
  patch: Partial<ItemState>;
}

/** The library with the changes the computer has not heard about yet laid over it. */
function withPending(lib: Library, pending: Pending[]): Library {
  if (!pending.length) return lib;
  const byId = new Map<string, Partial<ItemState>>();
  for (const e of pending) for (const id of e.ids) byId.set(id, { ...byId.get(id), ...e.patch });
  return { ...lib, items: lib.items.map((i) => (byId.has(i.id) ? { ...i, state: { ...i.state, ...byId.get(i.id) } } : i)) };
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside LibraryProvider');
  return s;
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [full, setLib] = useState<Library | null>(null);
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lensId, setLensId] = useState('worth');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [offline, setOffline] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const pending = useRef<Pending[]>([]);
  const flushing = useRef(false);
  const offlineNow = useRef(false);
  const booted = useRef<Promise<void> | null>(null);
  const listeners = useRef(new Set<(e: ServerEvent) => void>());
  const inflight = useRef<Promise<void> | null>(null);
  const keepRead = useRef(new Set<string>());
  // A new pairing (this provider is keyed by connection) asks its own computer about the proxy.
  const fresh = useRef(true);
  if (fresh.current) { resetImgProxy(); resetLibrarySync(); fresh.current = false; }

  const goOffline = useCallback((on: boolean) => {
    offlineNow.current = on;
    setOffline(on);
  }, []);

  /** Sends queued changes in order. Stops at the first one the network cannot carry. */
  const flush = useCallback(async () => {
    if (flushing.current || !pending.current.length) return;
    flushing.current = true;
    let refused = 0;
    try {
      while (pending.current.length) {
        const e = pending.current[0];
        try {
          await api.setState(e.ids, e.patch);
        } catch (err) {
          if (isOffline(err)) { goOffline(true); break; }
          refused++; // the computer said no (the post is gone, say): drop it rather than retry forever
        }
        pending.current = pending.current.slice(1);
        writeCache('pending', pending.current);
        setQueued(pending.current.length);
      }
    } finally {
      flushing.current = false;
    }
    if (refused) setReceipt({ id: Date.now(), text: `${refused} ${refused === 1 ? 'change' : 'changes'} made offline could not be saved on your computer` });
  }, [goOffline]);

  // What the phone saved last time: shown at once, before the network answers.
  const boot = useCallback(() => {
    booted.current ??= (async () => {
      const [cached, queue] = await Promise.all([loadCachedLibrary(), readCache<Pending[]>('pending')]);
      pending.current = Array.isArray(queue) ? queue : [];
      setQueued(pending.current.length);
      if (cached) {
        // Image proxy settings first, so no picture loads directly before the phone knows to proxy it.
        // They are kept on the phone too, so this does not wait for the network when they were saved.
        await imgProxyReady();
        setLib((l) => l ?? withPending(cached, pending.current));
        setSavedAt(librarySavedAt());
      }
    })().catch(() => {});
    return booted.current;
  }, []);

  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    setLoading(true);
    inflight.current = boot()
      .then(() => imgProxyReady())
      .then(() => syncLibrary())
      .then(({ lib: l, changed }) => {
        setLib((prev) => (changed || !prev ? withPending(l, pending.current) : prev));
        setSavedAt(librarySavedAt());
        setError(null);
        goOffline(false);
        void flush();
      })
      .catch((e: Error) => {
        if (isOffline(e)) goOffline(true);
        setError(e.message);
      })
      .finally(() => { setLoading(false); inflight.current = null; });
    return inflight.current;
  }, [boot, flush, goOffline]);

  // Offline: look for the computer again every half minute.
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [offline, refresh]);

  // Live updates: the server says "library changed", the phone refetches (debounced).
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let close = openEvents((e) => {
      if (e.type === 'library') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 400);
      }
      listeners.current.forEach((f) => f(e));
    });
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void refresh();
        close();
        close = openEvents((e) => {
          if (e.type === 'library') void refresh();
          listeners.current.forEach((f) => f(e));
        });
      }
    });
    return () => { close(); sub.remove(); if (timer) clearTimeout(timer); };
  }, [refresh]);

  // Profiles: the phone remembers its own choice; until it makes one it follows the computer.
  const profiles = full?.profiles ?? [];
  const known = (id: string | null | undefined) => (id === ALL_PROFILE || profiles.some((x) => x.id === id) ? id! : null);
  const profileId = known(settings.profile) ?? known(full?.activeProfile) ?? ALL_PROFILE;
  const profile = profiles.find((x) => x.id === profileId) ?? null;
  const lib = useMemo(() => (full ? scopeLibrary(full, profileId) : null), [full, profileId]);
  const profileCounts = useMemo(() => {
    const out: Record<string, number> = { [ALL_PROFILE]: 0 };
    const fresh = (full?.items ?? []).filter((i) => !i.state.read && !i.state.archived);
    out[ALL_PROFILE] = fresh.length;
    for (const pr of full?.profiles ?? []) {
      const ids = new Set(pr.sourceIds);
      out[pr.id] = fresh.filter((i) => ids.has(i.sourceId)).length;
    }
    return out;
  }, [full?.items, full?.profiles]);
  const setProfile = useCallback((id: string) => {
    keepRead.current = new Set();
    setSettings({ profile: id });
    haptics.tick();
  }, []);

  const sourceLabels = useMemo(() => Object.fromEntries((lib?.sources ?? []).map((s) => [s.id, s.label])), [lib?.sources]);
  const byId = useMemo(() => new Map((lib?.items ?? []).map((i) => [i.id, i])), [lib?.items]);
  const threads = useMemo(() => (lib ? groupThreads(lib.items) : null), [lib?.items]);
  // A thread's card stands for all its posts.
  const idsOf = useCallback((item: Item) => (threads ? threadFor(threads, item.id) : null) ?? [item.id], [threads]);

  const evaluate = useCallback(
    (spec: FilterSpec) =>
      lib ? applyFilters(lib.items, spec, { topics: lib.topics, sourceLabels, keepRead: keepRead.current, ai: { rules: lib.aiRules, labels: lib.labels } }) : null,
    [lib, sourceLabels],
  );

  const allLenses = useMemo<Lens[]>(() => [...BUILTIN_LENSES, ...(lib?.views ?? []).map((v) => ({ id: v.id, name: v.name, spec: { ...DEFAULT_SPEC, ...v.spec } }))], [lib?.views]);
  const lenses = useMemo(() => allLenses.map((l) => ({ ...l, n: evaluate(l.spec)?.visible.length ?? 0 })), [allLenses, evaluate]);
  const lens = allLenses.find((l) => l.id === lensId) ?? allLenses[0];
  const result = useMemo(() => evaluate(lens.spec), [evaluate, lens]);

  const setLens = useCallback((id: string) => {
    keepRead.current = new Set();
    setLensId(id);
    haptics.tick();
  }, []);

  /**
   * Optimistic: change the item locally at once, then tell the server; roll back when the server
   * refuses. With no connection the change waits in a queue on the phone and is sent later.
   */
  const patch = useCallback(
    (ids: string[], p: Partial<ItemState>) => {
      const enqueue = () => {
        pending.current = [...pending.current, { ids, patch: p }];
        writeCache('pending', pending.current);
        setQueued(pending.current.length);
      };
      const before = new Map<string, ItemState>();
      setLib((l) => {
        if (!l) return l;
        return {
          ...l,
          items: l.items.map((i) => {
            if (!ids.includes(i.id)) return i;
            before.set(i.id, i.state);
            return { ...i, state: { ...i.state, ...p } };
          }),
        };
      });
      // Keep the order: while anything is queued, new changes queue behind it.
      if (offlineNow.current || pending.current.length) {
        enqueue();
        void flush();
        return;
      }
      api.setState(ids, p).catch((e: Error) => {
        if (isOffline(e)) {
          enqueue();
          goOffline(true);
          return;
        }
        setLib((l) => (l ? { ...l, items: l.items.map((i) => (before.has(i.id) ? { ...i, state: before.get(i.id)! } : i)) } : l));
        haptics.reject();
        setReceipt({ id: Date.now(), text: `Not saved on your computer: ${e.message}` });
      });
    },
    [flush, goOffline],
  );

  const save = useCallback((item: Item) => {
    const saved = !item.state.saved;
    patch(idsOf(item), { saved, savedAt: saved ? new Date().toISOString() : null });
    haptics.confirm();
  }, [patch, idsOf]);

  const hide = useCallback((item: Item) => {
    const ids = idsOf(item);
    patch(ids, { archived: true });
    haptics.confirm();
    const who = item.author.name || 'this post';
    setReceipt({
      id: Date.now(),
      text: ids.length > 1 ? `A thread set aside from ${who}` : `1 set aside from ${who}`,
      undo: () => { patch(ids, { archived: false }); haptics.tick(); setReceipt(null); },
    });
  }, [patch, idsOf]);

  const markRead = useCallback((item: Item) => {
    if (item.state.read) return;
    const ids = idsOf(item);
    for (const id of ids) keepRead.current.add(id);
    patch(ids, { read: true, readAt: new Date().toISOString() });
  }, [patch, idsOf]);

  const later = useCallback((item: Item) => {
    const on = item.state.collections.includes(READ_LATER);
    patch([item.id], { collections: on ? item.state.collections.filter((c) => c !== READ_LATER) : [...item.state.collections, READ_LATER] });
    haptics.confirm();
    setReceipt({ id: Date.now(), text: on ? 'Taken out of Read later' : 'Added to Read later' });
  }, [patch]);

  const subscribe = useCallback((f: (e: ServerEvent) => void) => {
    listeners.current.add(f);
    return () => { listeners.current.delete(f); };
  }, []);

  const notify = useCallback((text: string) => setReceipt({ id: Date.now(), text }), []);

  const value: Store = {
    lib, profiles, profile, profileId, setProfile, profileCounts, error, loading, offline, savedAt, queued, refresh, sourceLabels, lenses, lensId: lens.id, setLens, result, byId, threads, evaluate,
    save, hide, markRead, later, setItemState: patch, receipt, dismissReceipt: () => setReceipt(null), notify, subscribe,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Pull to refresh: brings the library up to date from the computer, with a tick when it starts. */
export function usePull(): { on: boolean; run: () => void } {
  const st = useStore();
  const [on, setOn] = useState(false);
  const run = useCallback(() => {
    setOn(true);
    haptics.tick();
    void st.refresh().finally(() => setOn(false));
  }, [st.refresh]);
  return { on, run };
}

// ---------------------------------------------------------------- explanations

/** Why a post is on screen, in the desktop's words. */
export function litBy(ev: Evaluation, sourceLabels: Record<string, string>): string {
  if (!ev.visible && ev.hidden[0]) return `set aside by ${ev.hidden[0].label}`;
  if (ev.matched[0]) return `lit by ${ev.matched[0].label}`;
  if (ev.topics[0]) return `lit by #${ev.topics[0].topicName.toLowerCase().replace(/\s+/g, '')}`;
  return `from ${sourceLabels[ev.item.sourceId] ?? ev.item.platform}`;
}

/** "3h", "2d", "Mar 4": short and exact. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Minutes to read at 230 words a minute. */
export function readMinutes(text: string): number {
  return Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 230));
}

/** A person key matches the desktop's (web/src/Person.tsx): handle, else name, lowercased. */
export function personKey(item: Item): string {
  return (item.author.handle ?? item.author.name).toLowerCase();
}

/** Strip [[post:ID]] citations for speech and plain display. */
export function stripCitations(text: string): string {
  return text.replace(/\[\[post:[^\]]+\]\]/g, '').replace(/[ \t]+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ');
}

/** Long-form: articles open in the reader screen; so can posts that share an article link (the
 *  server says whether it can fetch one). */
export function isArticle(item: Item): boolean {
  return item.kind === 'article';
}
export function sharesLink(item: Item): boolean {
  return item.kind !== 'video' && item.media.some((m) => m.type === 'link');
}

/** A post a friend shared with you (the friends source, origin "friend"). */
export function isFriendShare(item: Item): boolean {
  return item.provenance?.connector === 'friends';
}

export const READ_LATER = 'Read later';

export function firstImage(item: Item): string | null {
  const m = item.media.find((x) => x.type === 'image') ?? item.media.find((x) => x.thumb);
  return m ? m.thumb || m.url : null;
}
