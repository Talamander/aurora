// "Match my desktop": on Omarchy, read the active desktop theme's colours so Aurora can wear them,
// and tell open windows when the theme changes (omarchy-theme-set). Read-only: it reads one small
// TOML file of hex colours and the theme name, nothing else in the home folder. Off in cloud mode.

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DesktopTheme {
  source: 'omarchy';
  name: string;
  mode: 'dark' | 'light';
  colors: Record<string, string>;
}

const KEYS = new Set([
  'accent', 'selection', 'muted', 'background', 'dark_background', 'darker_background', 'lighter_background',
  'foreground', 'dark_foreground', 'light_foreground', 'bright_foreground',
  'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta',
]);

const stateDir = () => process.env.OMARCHY_STATE_DIR ?? join(homedir(), '.local', 'state', 'omarchy', 'current');

export function parseColors(toml: string): { mode: 'dark' | 'light'; colors: Record<string, string> } {
  const colors: Record<string, string> = {};
  let mode: 'dark' | 'light' = 'dark';
  for (const line of toml.split('\n')) {
    const m = /^\s*([a-z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'mode') mode = m[2] === 'light' ? 'light' : 'dark';
    else if (KEYS.has(m[1]) && /^#[0-9a-f]{6}$/i.test(m[2])) colors[m[1]] = m[2].toLowerCase();
  }
  return { mode, colors };
}

export function readDesktopTheme(): DesktopTheme | null {
  if (process.env.SR_CLOUD === '1') return null;
  const dir = stateDir();
  const file = join(dir, 'theme', 'colors.toml');
  if (!existsSync(file)) return null;
  try {
    const { mode, colors } = parseColors(readFileSync(file, 'utf8').slice(0, 20_000));
    if (!colors.background || !colors.foreground || !colors.accent) return null;
    let name = 'desktop';
    try {
      name = readFileSync(join(dir, 'theme.name'), 'utf8').trim().slice(0, 60).replace(/[^\w .-]/g, '') || name;
    } catch {
      /* the name is cosmetic */
    }
    return { source: 'omarchy', name, mode, colors };
  } catch {
    return null;
  }
}

/** Calls back (debounced) when the desktop theme changes. Returns a stop function. */
export function watchDesktopTheme(onChange: () => void): () => void {
  if (process.env.SR_CLOUD === '1' || !existsSync(stateDir())) return () => {};
  let timer: NodeJS.Timeout | null = null;
  let w: FSWatcher | null = null;
  try {
    w = watch(stateDir(), () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 400);
    });
    w.unref();
  } catch {
    return () => {};
  }
  return () => w?.close();
}
