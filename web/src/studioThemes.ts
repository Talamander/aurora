// Saved studio themes live in the ui.themes setting as seeds. They are registered as presets on
// load, so the picker, profile looks and the agent can all refer to them by id like any other.

import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { normalizeSeed, registerSaved, type SavedTheme } from './themeStudio.ts';

export const MAX_SAVED = 24;

export function clean(v: unknown): SavedTheme[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => t && typeof t.id === 'string' && /^studio-[a-z0-9]{4,16}$/.test(t.id))
    .slice(0, MAX_SAVED)
    .map((t) => ({ id: t.id as string, seed: normalizeSeed(t.seed) }));
}

export function useStudioThemes() {
  const [saved, setSaved] = useState<SavedTheme[]>([]);
  // Bumped whenever presets are (re)registered, so anything painted from THEME_PRESETS repaints.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.getSetting<SavedTheme[]>('ui.themes').then((x) => {
      const list = clean(x.value);
      registerSaved(list);
      setSaved(list);
      setVersion((n) => n + 1);
    }).catch(() => {});
  }, []);
  const save = useCallback((list: SavedTheme[]) => {
    const next = clean(list);
    registerSaved(next);
    setSaved(next);
    setVersion((n) => n + 1);
    return api.putSetting('ui.themes', next);
  }, []);
  return { saved, version, save };
}
