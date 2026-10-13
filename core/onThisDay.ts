// On this day: posts you saved or highlighted on today's date in an earlier month or year.
// Purely local: it reads timestamps the library already has and never calls the AI.

import type { Item } from './types.ts';

export interface Memory {
  item: Item;
  /** What happened on that day. */
  kind: 'saved' | 'highlighted';
  at: Date;
  /** Whole months between then and now (1 = a month ago, 12 = a year ago). */
  monthsAgo: number;
  /** The first highlighted quote, when it was a highlight. */
  quote?: string;
}

export interface HighlightLite {
  itemId: string;
  quote: string;
  createdAt: string;
}

const sameDayOfMonth = (a: Date, b: Date) => a.getDate() === b.getDate();
const monthsBetween = (then: Date, now: Date) => (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();

/**
 * Every memory for `now`, the oldest first within years and the biggest anniversaries first
 * overall (a year ago before a month ago). Posts in the archive are skipped. One memory per post.
 */
export function onThisDay(items: Item[], highlights: HighlightLite[] = [], now = new Date()): Memory[] {
  const out = new Map<string, Memory>();
  const consider = (item: Item, kind: Memory['kind'], iso: string | null | undefined, quote?: string) => {
    if (!iso) return;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || !sameDayOfMonth(at, now)) return;
    const monthsAgo = monthsBetween(at, now);
    if (monthsAgo < 1) return;
    const prev = out.get(item.id);
    // A highlight says more than a save; keep the older one when both are the same kind.
    if (prev && (prev.kind === 'highlighted' || kind === 'saved') && prev.monthsAgo >= monthsAgo) return;
    out.set(item.id, { item, kind, at, monthsAgo, quote });
  };
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const it of items) if (it.state.saved && !it.state.archived) consider(it, 'saved', it.state.savedAt);
  for (const h of highlights) {
    const it = byId.get(h.itemId);
    if (it && !it.state.archived) consider(it, 'highlighted', h.createdAt, h.quote);
  }
  return [...out.values()].sort((a, b) => b.monthsAgo - a.monthsAgo || a.at.getTime() - b.at.getTime());
}

/** "A year ago", "2 years ago", "A month ago", "5 months ago", "14 months ago". */
export function agoLabel(monthsAgo: number): string {
  if (monthsAgo >= 12 && monthsAgo % 12 === 0) {
    const y = monthsAgo / 12;
    return y === 1 ? 'A year ago' : `${y} years ago`;
  }
  return monthsAgo === 1 ? 'A month ago' : `${monthsAgo} months ago`;
}
