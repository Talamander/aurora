// Listen: reads the morning edition (or any digest) aloud with the browser's own speech engine.
// One shared speaker for the app, so starting a new reading stops the old one. Text is cleaned
// of citations, links and markdown first; nothing leaves the browser.

import { useSyncExternalStore } from 'react';
import type { PageBlock } from '../../core/types.ts';

export interface ListenPart {
  key: string;
  label: string;
  text: string;
}

type State = { status: 'idle' | 'playing' | 'paused'; key: string | null; label: string | null; scope: string | null };

export const canListen = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let state: State = { status: 'idle', key: null, label: null, scope: null };
let run = 0;
const subs = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const fn of subs) fn();
};

/** Plain speakable text: no [[post:..]] citations, markdown, list markers or raw links. */
export function speakable(text: string): string {
  return text
    .replace(/\[\[(?:post:)?[^\]\s]+\]\]/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*([-*•]|\d+\.)\s+/gm, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chrome stops long utterances part way, so speak in sentence-sized chunks. */
function chunks(text: string, max = 220): string[] {
  const out: string[] = [];
  let cur = '';
  for (const s of text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [text]) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const speaker = {
  play(parts: ListenPart[], scope: string) {
    if (!canListen) return;
    // The listen queue pauses itself when another reading takes the speaker.
    window.dispatchEvent(new Event('aurora:speak'));
    speechSynthesis.cancel();
    const id = ++run;
    const queue = parts.map((p) => ({ ...p, text: speakable(p.text) })).filter((p) => p.text);
    if (!queue.length) return;
    set({ status: 'playing', key: queue[0].key, label: queue[0].label, scope });
    queue.forEach((p, i) => {
      const bits = chunks(p.text);
      bits.forEach((bit, j) => {
        const u = new SpeechSynthesisUtterance(bit);
        u.rate = 1.02;
        if (j === 0) u.onstart = () => id === run && set({ key: p.key, label: p.label });
        if (i === queue.length - 1 && j === bits.length - 1) u.onend = () => id === run && set({ status: 'idle', key: null, label: null, scope: null });
        speechSynthesis.speak(u);
      });
    });
  },
  pause() {
    if (!canListen || state.status !== 'playing') return;
    speechSynthesis.pause();
    set({ status: 'paused' });
  },
  resume() {
    if (!canListen || state.status !== 'paused') return;
    speechSynthesis.resume();
    set({ status: 'playing' });
  },
  stop() {
    if (!canListen) return;
    run++;
    speechSynthesis.cancel();
    if (state.status !== 'idle') set({ status: 'idle', key: null, label: null, scope: null });
  },
};

export function useSpeaker(): State {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => state,
  );
}

/** What a page reads aloud: the hero, then each digest section, keyed by block index. */
export function pageParts(blocks: PageBlock[]): ListenPart[] {
  const parts: ListenPart[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'hero') parts.push({ key: String(i), label: b.title, text: [b.title, b.subtitle].filter(Boolean).join('. ') });
    else if (b.type === 'digest') parts.push({ key: String(i), label: b.title ?? 'Summary', text: [b.title, b.text].filter(Boolean).join('. ') });
  });
  return parts;
}
