// Threads in the web app: the on/off setting (ui.threads, on by default) and the grouping for the
// current library, shared by the feed and Columns through a context. Grouping is core/threads.ts.

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { groupThreads, threadFor, type ThreadGroups } from '../../core/threads.ts';
import type { Item } from '../../core/types.ts';
import { api } from './api.ts';

export const THREADS_SETTING = 'ui.threads';

let enabled = true;
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());

/** Whether threads collapse into one card. Loads once from the server setting. */
export function useThreadsEnabled(): boolean {
  useEffect(() => {
    loaded ??= api.getSetting<boolean>(THREADS_SETTING).then((x) => {
      if (x.value === false) {
        enabled = false;
        emit();
      }
    }, () => {});
  }, []);
  return useSyncExternalStore((fn) => (subs.add(fn), () => void subs.delete(fn)), () => enabled);
}

export async function setThreadsEnabled(on: boolean) {
  await api.putSetting(THREADS_SETTING, on);
  enabled = on;
  emit();
}

/** The library's threads, or null when the setting is off. */
export function useThreadGroups(items: readonly Item[] | undefined): ThreadGroups | null {
  const on = useThreadsEnabled();
  return useMemo(() => (on && items ? groupThreads(items) : null), [on, items]);
}

export interface ThreadsValue {
  g: ThreadGroups;
  get: (id: string) => Item | undefined;
}
export const ThreadsContext = createContext<ThreadsValue | null>(null);

/** The posts of the thread this post is in, oldest first, or null when it stands alone. */
export function useThread(id: string): Item[] | null {
  const t = useContext(ThreadsContext);
  const ids = t ? threadFor(t.g, id) : null;
  if (!t || !ids) return null;
  const items = ids.map((id) => t.get(id)).filter((i): i is Item => !!i);
  return items.length > 1 ? items : null;
}
