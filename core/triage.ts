// Triage: clear new posts one card at a time. Keep (save), Read later, Hide (archive) or Skip
// (mark seen). This file is the pure part: which posts make the deck, what each choice writes to
// the item's local state, how a swipe maps to a choice, and the tally for the finish screen.
// Every choice is local: nothing here ever touches the source platform.

import type { Item, ItemState } from './types.ts';

export type TriageAction = 'keep' | 'later' | 'hide' | 'skip';

export const TRIAGE_ACTIONS: TriageAction[] = ['keep', 'later', 'hide', 'skip'];

/** The Read later collection's name (shared with web/src/longform.ts and cli/pick.ts). */
export const READ_LATER = 'Read later';

/**
 * The deck: posts from the current feed, in feed order, that still need a decision. Read,
 * archived and already-queued posts are left out, and so is anything listed twice.
 */
export function triageDeck(items: readonly Item[], limit = 200): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (out.length >= limit) break;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const s = it.state;
    if (s.read || s.archived || s.collections.includes(READ_LATER)) continue;
    out.push(it);
  }
  return out;
}

/** What a choice writes to the post's local state. Every choice also takes it out of "new". */
export function triagePatch(action: TriageAction, item: Item): Partial<ItemState> {
  switch (action) {
    case 'keep':
      return { saved: true, read: true };
    case 'later':
      // Read later lists unread posts, so a queued post stays unread until it is read there.
      return { collections: item.state.collections.includes(READ_LATER) ? item.state.collections : [...item.state.collections, READ_LATER] };
    case 'hide':
      return { archived: true, read: true };
    case 'skip':
      return { read: true };
  }
}

/** The words for each choice, used on buttons, the live region and the undo toast. */
export const TRIAGE_LABEL: Record<TriageAction, { verb: string; past: string }> = {
  keep: { verb: 'Keep', past: 'kept' },
  later: { verb: 'Later', past: 'saved for later' },
  hide: { verb: 'Hide', past: 'hidden' },
  skip: { verb: 'Skip', past: 'skipped' },
};

/**
 * Maps a drag to a choice: right keeps, left hides, up is Read later, down skips. A drag must go
 * far enough (a fifth of the card's width, at least 72 px) and mostly in one direction, so a
 * scroll or a wobble never decides anything.
 */
export function swipeAction(dx: number, dy: number, width: number): TriageAction | null {
  const far = Math.max(72, width * 0.2);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= far && ax > ay * 1.4) return dx > 0 ? 'keep' : 'hide';
  if (ay >= far && ay > ax * 1.4) return dy < 0 ? 'later' : 'skip';
  return null;
}

/** How far along a drag is toward its choice, 0 to 1, for the edge glow while dragging. */
export function swipeProgress(dx: number, dy: number, width: number): { action: TriageAction | null; amount: number } {
  const far = Math.max(72, width * 0.2);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 8 && ay < 8) return { action: null, amount: 0 };
  const action: TriageAction = ax >= ay ? (dx > 0 ? 'keep' : 'hide') : dy < 0 ? 'later' : 'skip';
  return { action, amount: Math.min(1, Math.max(ax, ay) / far) };
}

export interface TriageTally {
  cleared: number;
  kept: number;
  later: number;
  hidden: number;
  skipped: number;
}

export function triageTally(history: readonly { action: TriageAction }[]): TriageTally {
  const t: TriageTally = { cleared: history.length, kept: 0, later: 0, hidden: 0, skipped: 0 };
  for (const h of history) {
    if (h.action === 'keep') t.kept++;
    else if (h.action === 'later') t.later++;
    else if (h.action === 'hide') t.hidden++;
    else t.skipped++;
  }
  return t;
}

/** "Cleared 42 · kept 5 · later 3", leaving out the zeros after the first number. */
export function tallyLine(t: TriageTally): string {
  const parts = [`Cleared ${t.cleared}`];
  if (t.kept) parts.push(`kept ${t.kept}`);
  if (t.later) parts.push(`later ${t.later}`);
  if (t.hidden) parts.push(`hid ${t.hidden}`);
  return parts.join(' · ');
}
