// Phone-only preferences. They never leave the phone.
import { useSyncExternalStore } from 'react';
import { getItem, setItem } from './secure';

export interface Settings {
  theme: 'dark' | 'light' | 'auto';
  haptics: boolean;
  reduceMotion: boolean;
  autoplay: boolean;
  /** The profile this phone reads in, or null for the computer's active profile. */
  profile: string | null;
  /** The local day (YYYY-MM-DD) the On this day card was hidden for, or null. */
  onThisDayHidden: string | null;
}

const DEFAULTS: Settings = { theme: 'auto', haptics: true, reduceMotion: false, autoplay: true, profile: null, onThisDayHidden: null };
const KEY = 'aurora.settings';
let current: Settings = DEFAULTS;
const subs = new Set<() => void>();

export async function loadSettings() {
  try {
    const raw = await getItem(KEY);
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  subs.forEach((f) => f());
}

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  subs.forEach((f) => f());
  void setItem(KEY, JSON.stringify(current));
}

export function getSettings(): Settings {
  return current;
}

export function useSettings(): Settings {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current, () => current);
}
