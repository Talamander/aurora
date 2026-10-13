// `aurora status`: a one-shot count of what is worth reading, for status bars (Waybar) and
// scripts. It reads the library over the local API and never writes anything.

import { applyFilters, DEFAULT_SPEC, normalizeSpec } from '../core/filter.ts';
import { ALL_PROFILE, findProfile, scopeLibrary } from '../core/profiles.ts';
import type { Library } from '../core/types.ts';
import { oneLine } from './sanitize.ts';

export interface StatusSummary {
  profile: string;
  worth: number;
  saved: number;
  newest: { author: string; text: string }[];
  /** Alert hits nobody has looked at yet, newest first. */
  alerts?: { unseen: number; hits: { alert: string; author: string; text: string }[] };
}

/** What `GET /api/alerts/hits` returns, as far as the status bar cares. */
export interface AlertFeed {
  unseen: number;
  hits: { alertName: string; seen: boolean; item: { author: string; text: string } | null }[];
}

export function summarize(lib: Library, profile?: string, alertFeed?: AlertFeed | null): StatusSummary {
  const id = (profile && (profile === ALL_PROFILE ? ALL_PROFILE : findProfile(lib.profiles, profile)?.id)) || lib.activeProfile || ALL_PROFILE;
  const l = scopeLibrary(lib, id);
  const ctx = { topics: l.topics, sourceLabels: Object.fromEntries(l.sources.map((s) => [s.id, s.label])), ai: { rules: l.aiRules, labels: l.labels } };
  const worth = applyFilters(l.items, normalizeSpec({ ...DEFAULT_SPEC, read: 'unread', hideNoise: true }), ctx).visible;
  const saved = l.items.filter((i) => i.state.saved && !i.state.archived).length;
  const name = id === ALL_PROFILE ? 'All' : (findProfile(lib.profiles, id)?.name ?? 'All');
  return {
    profile: name,
    worth: worth.length,
    saved,
    // Post text is untrusted: flatten it and strip control sequences before it reaches a bar.
    newest: worth.slice(0, 5).map((e) => ({ author: oneLine(e.item.author.name).slice(0, 40), text: oneLine(e.item.title || e.item.text).slice(0, 90) })),
    alerts: {
      unseen: Math.max(0, Number(alertFeed?.unseen) || 0),
      hits: (alertFeed?.hits ?? [])
        .filter((h) => !h.seen && h.item)
        .slice(0, 5)
        .map((h) => ({ alert: oneLine(h.alertName).slice(0, 40), author: oneLine(h.item!.author).slice(0, 40), text: oneLine(h.item!.text).slice(0, 90) })),
    },
  };
}

/** Waybar custom-module JSON: {"text","tooltip","class","alt"}. Pango markup is escaped. */
export function waybar(s: StatusSummary): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const a = s.alerts ?? { unseen: 0, hits: [] };
  const alertLines = a.unseen ? [`<b>${a.unseen} alert${a.unseen === 1 ? '' : 's'}</b>`, ...a.hits.map((h) => `${esc(h.alert)} · ${esc(h.author)}: ${esc(h.text)}`), ''] : [];
  const lines = [...alertLines, `<b>${esc(s.profile)}</b>: ${s.worth} worth reading, ${s.saved} saved`, ...s.newest.map((n) => `${esc(n.author)}: ${esc(n.text)}`)];
  const text = `${s.worth ? `◆ ${s.worth}` : '◆'}${a.unseen ? ` ⚑ ${a.unseen}` : ''}`;
  return JSON.stringify({ text, tooltip: lines.join('\n'), class: a.unseen ? 'alert' : s.worth ? 'unread' : 'clear', alt: s.profile });
}
