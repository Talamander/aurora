// `aurora pick`: choose a post from a launcher (Walker, fuzzel, wofi, rofi, choose on macOS, or
// fzf) and open it.
// Built for an Omarchy keybinding: one key, type a few letters, Enter, and the post opens in the
// browser and is marked read in Aurora. Nothing is written anywhere except that local read mark.

import { spawn, spawnSync } from 'node:child_process';
import { applyFilters, DEFAULT_SPEC, normalizeSpec } from '../core/filter.ts';
import { ALL_PROFILE, findProfile, scopeLibrary } from '../core/profiles.ts';
import type { Item, Library } from '../core/types.ts';
import { oneLine } from './sanitize.ts';

export type PickList = 'worth' | 'saved' | 'later';

/** The posts to offer, newest first, for one profile. */
export function pickItems(lib: Library, list: PickList, profile?: string, limit = 300): Item[] {
  const id = (profile && (profile === ALL_PROFILE ? ALL_PROFILE : findProfile(lib.profiles, profile)?.id)) || lib.activeProfile || ALL_PROFILE;
  const l = scopeLibrary(lib, id);
  if (list === 'saved') return l.items.filter((i) => i.state.saved && !i.state.archived).slice(0, limit);
  // Read later is a collection named "Read later" (web/src/longform.ts).
  if (list === 'later') return l.items.filter((i) => i.state.collections.includes('Read later') && !i.state.read && !i.state.archived).slice(0, limit);
  const ctx = { topics: l.topics, sourceLabels: Object.fromEntries(l.sources.map((s) => [s.id, s.label])), ai: { rules: l.aiRules, labels: l.labels } };
  return applyFilters(l.items, normalizeSpec({ ...DEFAULT_SPEC, read: 'unread', hideNoise: true }), ctx).visible.slice(0, limit).map((e) => e.item);
}

/**
 * One launcher row per post: "12  Author · Source: text". Post text is untrusted, so it is folded
 * to one line with every terminal control removed; the number at the front is how the choice is
 * read back, so nothing in a post can pick a different post or inject a command.
 */
export function pickRows(items: Item[], sourceLabel: (id: string) => string): string[] {
  return items.map((it, i) => {
    const text = oneLine(it.title || it.text).slice(0, 120) || '(no text)';
    return `${i + 1}  ${oneLine(it.author.name).slice(0, 32)} · ${oneLine(sourceLabel(it.sourceId)).slice(0, 24)}: ${text}`;
  });
}

/** Reads the chosen row back to its post. Only the leading number counts. */
export function chosen(items: Item[], row: string): Item | null {
  const m = /^\s*(\d+)\s/.exec(row);
  if (!m) return null;
  return items[Number(m[1]) - 1] ?? null;
}

const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

/** The launcher to use: AURORA_MENU (run by sh), else the first one installed. */
export function menuCommand(platform: NodeJS.Platform = process.platform, hasBin: (bin: string) => boolean = has, tty = !!process.stdin.isTTY): { cmd: string; args: string[] } | null {
  const env = process.env.AURORA_MENU?.trim();
  if (env) return { cmd: 'sh', args: ['-c', env] };
  const prompt = 'Aurora';
  // macOS: choose (brew install choose-gui) is a small dmenu-style picker that reads rows on stdin.
  if (platform === 'darwin' && hasBin('choose')) return { cmd: 'choose', args: [] };
  if (hasBin('walker')) return { cmd: 'walker', args: ['--dmenu', '--placeholder', prompt] };
  if (hasBin('fuzzel')) return { cmd: 'fuzzel', args: ['--dmenu', '--prompt', `${prompt} `] };
  if (hasBin('wofi')) return { cmd: 'wofi', args: ['--dmenu', '--prompt', prompt] };
  if (hasBin('rofi')) return { cmd: 'rofi', args: ['-dmenu', '-i', '-p', prompt] };
  if (tty && hasBin('fzf')) return { cmd: 'fzf', args: ['--prompt', `${prompt} > `, '--no-sort'] };
  return null;
}

export function runMenu(menu: { cmd: string; args: string[] }, rows: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(menu.cmd, menu.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.split('\n')[0] : null));
    child.stdin.on('error', () => {});
    child.stdin.end(rows.join('\n') + '\n');
  });
}

export function openInBrowser(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const [cmd, args] = process.env.BROWSER
    ? [process.env.BROWSER, [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
