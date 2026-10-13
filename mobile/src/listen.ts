// Listen: reads an edition, a post or the Read later list aloud with the phone's own speech engine
// (expo-speech). One shared speaker, so starting a new reading stops the old one. Nothing leaves
// the phone. There are no lock-screen controls: expo-speech has no media session, and adding one
// needs a native module the app does not ship yet.
import { useSyncExternalStore } from 'react';
import * as Speech from 'expo-speech';

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

/** Engines cap utterance length (Android: about 4000 characters), so speak in chunks. */
function chunks(text: string, max = 1200): string[] {
  const out: string[] = [];
  let cur = '';
  for (const s of text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [text]) {
    if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** One piece in a back-to-back reading (Read later). Its text is fetched when its turn comes. */
export interface Track {
  id: string;
  title: string;
  load: () => Promise<string | null>;
}

/** Where a back-to-back reading is: which piece of how many, and its title. */
export interface QueueNow {
  key: string;
  index: number;
  total: number;
  title: string;
  loading: boolean;
}

let playing: string | null = null;
let queueNow: QueueNow | null = null;
let queue: { key: string; tracks: Track[] } | null = null;
let run = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (k: string | null) => { playing = k; emit(); };
const setQueue = (q: QueueNow | null) => { queueNow = q; emit(); };

/** Reads track `i` and then the ones after it, until the list ends or something else plays. */
async function startAt(i: number) {
  const q = queue;
  if (!q) return;
  void Speech.stop();
  const id = ++run;
  const t = q.tracks[i];
  if (!t) { queue = null; setQueue(null); set(null); return; }
  setQueue({ key: q.key, index: i, total: q.tracks.length, title: t.title, loading: true });
  let text: string | null = null;
  try { text = await t.load(); } catch { text = null; }
  if (id !== run) return;
  const bits = text ? chunks(speakable(`${t.title}.\n\n${text}`)) : [];
  // A piece that cannot be loaded (offline and never saved) is skipped, not fatal.
  if (!bits.length) { void startAt(i + 1); return; }
  setQueue({ key: q.key, index: i, total: q.tracks.length, title: t.title, loading: false });
  let moved = false;
  const next = () => { if (id === run && !moved) { moved = true; void startAt(i + 1); } };
  bits.forEach((bit, j) => Speech.speak(bit, { rate: 1.0, onDone: j === bits.length - 1 ? next : undefined, onError: next }));
}

export const speaker = {
  play(key: string, text: string) {
    queue = null;
    if (queueNow) setQueue(null);
    void Speech.stop();
    const id = ++run;
    const bits = chunks(speakable(text));
    if (!bits.length) return;
    set(key);
    bits.forEach((bit, i) =>
      Speech.speak(bit, {
        rate: 1.0,
        onDone: i === bits.length - 1 ? () => { if (id === run) set(null); } : undefined,
        onError: () => { if (id === run) set(null); },
      }),
    );
  },
  /** Reads the tracks one after another, like a podcast queue. */
  playQueue(key: string, tracks: Track[]) {
    if (!tracks.length) return;
    queue = { key, tracks };
    set(key);
    void startAt(0);
  },
  /** Jumps to the next piece of a back-to-back reading. */
  skip() {
    if (queue && queueNow) void startAt(queueNow.index + 1);
  },
  stop() {
    run++;
    queue = null;
    void Speech.stop();
    queueNow = null;
    set(null);
  },
  toggle(key: string, text: string) {
    if (playing === key) this.stop();
    else this.play(key, text);
  },
};

/** The key that is being read aloud now, or null. */
export function usePlaying(): string | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => playing, () => playing);
}

/** The back-to-back reading in progress, or null. */
export function useQueueNow(): QueueNow | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => queueNow, () => queueNow);
}
