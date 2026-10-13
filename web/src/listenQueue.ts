// The listen queue: articles (and pages such as the morning edition) read aloud back to back, like
// a podcast queue. One paragraph is spoken at a time with the browser's own speech engine, so
// prev/next paragraph, speed and voice changes take effect at once. Nothing leaves the browser
// except the usual local API calls (load or extract an article, save the reading position, mark
// it read when finished).
//
// Media keys: the queue publishes a Media Session (title, author, artwork, play/pause/next/prev),
// which Chromium and Electron hand to the desktop as an MPRIS player, so playerctl and the
// keyboard's media keys drive it. Chromium only treats a page as a media player while a media
// element is playing, and speech synthesis is not one, so a tiny silent looping <audio> plays
// while Aurora speaks.

import { useSyncExternalStore } from 'react';
import { blockText } from '../../core/longform.ts';
import type { PageBlock } from '../../core/types.ts';
import { canListen, speakable, speaker } from './Listen.tsx';
import { proxied } from './imgProxy.ts';
import { lf, READ_LATER } from './longform.ts';
import { publishListen, type NowPlaying } from './quickBus.ts';

export interface ListenEntry {
  /** 'a:<itemId>' for an article, 'p:<pageId>' for a page. */
  key: string;
  kind: 'article' | 'page';
  id: string;
  title: string;
  /** Author or source, shown under the title and as the media session's artist. */
  by: string;
  image?: string | null;
  /** Page entries carry their speakable parts with them. */
  parts?: { block: number; text: string }[];
}

/** The post's own text (a feed summary, say), spoken when the full article cannot be fetched. */
let postText: (id: string) => string | undefined = () => undefined;

interface Para {
  block: number;
  text: string;
}

export type ListenStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface ListenState {
  entries: ListenEntry[];
  index: number;
  status: ListenStatus;
  /** Paragraph being read, and how many the current entry has. */
  para: number;
  paras: number;
  rate: number;
  voice: string | null;
  error: string | null;
  /** Whether the queue panel is expanded in the player. */
  open: boolean;
}

const LS_RATE = 'aurora.listen.rate';
const LS_VOICE = 'aurora.listen.voice';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private window */
  }
};

export const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];

let state: ListenState = {
  entries: [],
  index: 0,
  status: 'idle',
  para: 0,
  paras: 0,
  rate: Number(read(LS_RATE)) || 1,
  voice: read(LS_VOICE),
  error: null,
  open: false,
};
const subs = new Set<() => void>();
const toQuickLook = publishListen(nowPlaying, () => listen.toggle());
function set(next: Partial<ListenState>) {
  state = { ...state, ...next };
  for (const fn of subs) fn();
  syncMediaSession();
  toQuickLook(nowPlaying());
}

/** The one line Quick look shows (web/src/QuickLook.tsx). */
function nowPlaying(): NowPlaying | null {
  const e = state.entries[state.index];
  if (!e || state.status === 'idle') return null;
  return { title: e.title, by: e.by, status: state.status };
}

export function useListenQueue(): ListenState {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => state,
  );
}
export const listenState = () => state;

// ------------------------------------------------------------------ loading text

let paras: Para[] = [];
/** Blocks in the current article, for the saved reading progress. */
let blockCount = 0;
let run = 0;

async function loadEntry(e: ListenEntry): Promise<{ paras: Para[]; start: number; blocks: number }> {
  if (e.kind === 'page') {
    const ps = (e.parts ?? []).map((p) => ({ block: p.block, text: speakable(p.text) })).filter((p) => p.text);
    return { paras: ps, start: 0, blocks: ps.length };
  }
  let rec = await lf.article(e.id);
  // Articles never opened have no text yet: fetch and extract them now (the server checks the
  // URL like any other fetch; no AI is involved).
  if (rec.status !== 'ok' && rec.canExtract) rec = { ...(await lf.extract(e.id)), canExtract: false };
  const art = rec.article;
  if (rec.status !== 'ok' || !art) {
    const own = postText(e.id);
    if (!own?.trim()) throw new Error(rec.error || 'This article could not be fetched for reading.');
    const ps = [e.title, ...own.split(/\n\s*\n/)].map((t, i) => ({ block: i - 1, text: speakable(t) })).filter((p) => p.text);
    return { paras: ps, start: 0, blocks: 0 };
  }
  const out: Para[] = [];
  art.blocks.forEach((b, i) => {
    if (b.t === 'img' || b.t === 'hr' || b.t === 'code') return;
    const text = speakable(blockText(b));
    if (text) out.push({ block: i, text });
  });
  const intro = speakable(`${art.title}.${art.byline ? ` By ${art.byline}.` : ''}`);
  // Pick up where the reader (or an earlier listen) left off; the title only on a fresh start.
  const pos = rec.progress > 0 && rec.progress < 0.98 ? rec.position : 0;
  let start = pos > 0 ? out.findIndex((p) => p.block >= pos) : 0;
  if (start < 0) start = 0;
  if (start === 0 && intro) out.unshift({ block: -1, text: intro });
  return { paras: out, start, blocks: art.blocks.length };
}

// ------------------------------------------------------------------ speaking

/** Chrome stops long utterances part way, so speak in sentence-sized chunks. */
export function chunk(text: string, max = 220): string[] {
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

function voiceFor(uri: string | null): SpeechSynthesisVoice | null {
  if (!uri || !canListen) return null;
  return speechSynthesis.getVoices().find((v) => v.voiceURI === uri) ?? null;
}

function cancelSpeech() {
  if (canListen) speechSynthesis.cancel();
}

function speakPara(i: number) {
  const id = ++run;
  cancelSpeech();
  const p = paras[i];
  if (!p) return finishEntry();
  set({ para: i, paras: paras.length, status: 'playing', error: null });
  savePosition(p.block);
  const bits = chunk(p.text);
  const voice = voiceFor(state.voice);
  let j = 0;
  const next = () => {
    if (id !== run) return;
    if (j >= bits.length) return speakPara(i + 1);
    const u = new SpeechSynthesisUtterance(bits[j++]);
    u.rate = state.rate;
    if (voice) {
      try {
        u.voice = voice;
      } catch {
        // A voice that went away between lookups: speak with the default.
      }
      u.lang = voice.lang;
    }
    u.onend = next;
    // An error from our own cancel is expected; any other error skips the chunk rather than
    // stalling the queue.
    u.onerror = (ev) => {
      if (id !== run || ev.error === 'interrupted' || ev.error === 'canceled') return;
      next();
    };
    speechSynthesis.speak(u);
  };
  next();
}

let lastSaved = 0;
function savePosition(block: number) {
  const e = state.entries[state.index];
  if (!e || e.kind !== 'article' || block < 0 || !blockCount) return;
  const now = Date.now();
  if (now - lastSaved < 4000) return;
  lastSaved = now;
  void lf.reading(e.id, Math.min(0.97, block / blockCount), block).catch(() => {});
}

function finishEntry() {
  const e = state.entries[state.index];
  if (e?.kind === 'article') {
    void lf.reading(e.id, 1, 0).catch(() => {});
    // Listening to the end counts as reading it, the same as finishing it in the reader.
    void fetch('/api/items/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [e.id], patch: { read: true } }) }).catch(() => {});
  }
  if (state.index + 1 < state.entries.length) void startEntry(state.index + 1);
  else stopAll(true);
}

async function startEntry(index: number, fromPara?: number) {
  const e = state.entries[index];
  if (!e) return stopAll(true);
  const id = ++run;
  cancelSpeech();
  speaker.stop();
  set({ index, status: 'loading', para: 0, paras: 0, error: null });
  silence.play();
  try {
    const loaded = await loadEntry(e);
    if (id !== run) return;
    paras = loaded.paras;
    blockCount = loaded.blocks;
    lastSaved = 0;
    if (!paras.length) throw new Error('Nothing to read aloud in this one.');
    speakPara(fromPara ?? loaded.start);
  } catch (err) {
    if (id !== run) return;
    // Skip what cannot be read and carry on with the rest of the queue.
    const msg = `Skipped “${e.title.slice(0, 60)}”: ${(err as Error).message}`;
    if (index + 1 < state.entries.length) {
      await startEntry(index + 1);
      set({ error: msg });
    } else {
      stopAll(false);
      set({ error: msg });
    }
  }
}

function stopAll(done: boolean) {
  run++;
  cancelSpeech();
  silence.stop();
  set({ status: done ? 'idle' : 'paused', ...(done ? { para: 0, paras: 0 } : {}) });
}

// Another reading (the reader's or a page's own Listen button) takes the speaker: pause here.
if (typeof window !== 'undefined') {
  window.addEventListener('aurora:speak', () => {
    if (state.status === 'playing' || state.status === 'loading') {
      run++;
      silence.stop();
      set({ status: 'paused' });
    }
  });
}

// ------------------------------------------------------------------ silent audio for media keys

/** 1 s of 8 kHz 8-bit mono silence as a WAV blob: URL (the app's CSP allows blob: media, not data:). */
function silentWav(): string {
  const n = 8000;
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, 'data');
  dv.setUint32(40, n, true);
  buf.fill(128, 44);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const silence = (() => {
  let el: HTMLAudioElement | null = null;
  return {
    play() {
      if (typeof Audio === 'undefined') return;
      el ??= Object.assign(new Audio(silentWav()), { loop: true });
      // Autoplay rules may refuse without a click; speech still works, only media keys are lost.
      void el.play().catch(() => {});
    },
    stop() {
      el?.pause();
    },
  };
})();

// ------------------------------------------------------------------ media session

let artworkFor = '';
function syncMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const e = state.entries[state.index];
  if (!e || state.status === 'idle') {
    ms.playbackState = 'none';
    ms.metadata = null;
    artworkFor = '';
    return;
  }
  ms.playbackState = state.status === 'paused' ? 'paused' : 'playing';
  if (artworkFor !== e.key && typeof MediaMetadata !== 'undefined') {
    artworkFor = e.key;
    // Artwork only through the local image proxy (or Aurora's own icon), so the desktop's media
    // widget never fetches from the post's host.
    const img = e.image ? proxied(e.image) : undefined;
    const art = img && img.startsWith('/api/img') ? [{ src: new URL(img, location.href).href, sizes: '512x512' }] : [];
    ms.metadata = new MediaMetadata({
      title: e.title,
      artist: e.by,
      album: 'Aurora',
      artwork: [...art, { src: new URL('/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  }
}

function bindMediaKeys() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const on = (a: MediaSessionAction, fn: () => void) => {
    try {
      navigator.mediaSession.setActionHandler(a, fn);
    } catch {
      /* this action is not supported here */
    }
  };
  on('play', () => listen.play());
  on('pause', () => listen.pause());
  on('stop', () => listen.stop());
  on('nexttrack', () => listen.nextEntry());
  on('previoustrack', () => listen.prevEntry());
  on('seekforward', () => listen.nextPara());
  on('seekbackward', () => listen.prevPara());
}
bindMediaKeys();

// ------------------------------------------------------------------ public API

const toast = (text: string) => window.dispatchEvent(new CustomEvent('aurora:toast', { detail: text }));

export const listen = {
  /** Replace the queue and start at the first entry. */
  playAll(entries: ListenEntry[]) {
    if (!canListen) return toast('This browser cannot read aloud.');
    if (!entries.length) return toast('Nothing to listen to.');
    set({ entries, index: 0 });
    void startEntry(0);
  },
  /** Plays every unread article in Read later, in the queue's order. */
  async playReadLater() {
    if (!canListen) return toast('This browser cannot read aloud.');
    try {
      const { queue } = await lf.queue();
      const entries = queue.filter((q) => !q.read).map(fromQueueEntry);
      if (!entries.length) return toast(`Nothing unread in ${READ_LATER}.`);
      listen.playAll(entries);
    } catch (e) {
      toast((e as Error).message);
    }
  },
  /** Adds to the end of the queue (or plays at once when nothing is queued). */
  add(e: ListenEntry) {
    if (state.entries.some((x) => x.key === e.key)) return toast('Already in the listen queue.');
    const entries = [...state.entries, e];
    if (state.status === 'idle' && !state.entries.length) {
      set({ entries, index: 0 });
      void startEntry(0);
      return;
    }
    set({ entries });
    toast(`Added to the listen queue (${entries.length - state.index - 1} ahead)`.replace('(0 ahead)', '(up next)'));
  },
  play() {
    if (state.status === 'playing' || state.status === 'loading') return;
    if (!state.entries.length) return void listen.playReadLater();
    if (state.status === 'paused' && paras.length && state.paras) {
      silence.play();
      speaker.stop();
      return speakPara(state.para);
    }
    void startEntry(Math.min(state.index, state.entries.length - 1));
  },
  pause() {
    if (state.status !== 'playing' && state.status !== 'loading') return;
    run++;
    cancelSpeech();
    silence.stop();
    set({ status: 'paused' });
  },
  toggle() {
    if (state.status === 'playing' || state.status === 'loading') listen.pause();
    else listen.play();
  },
  stop() {
    stopAll(true);
    set({ entries: [], index: 0, open: false, error: null });
    paras = [];
  },
  nextPara() {
    if (!paras.length) return;
    if (state.para + 1 >= paras.length) return finishEntry();
    silence.play();
    speakPara(state.para + 1);
  },
  prevPara() {
    if (!paras.length) return;
    silence.play();
    speakPara(Math.max(0, state.para - 1));
  },
  nextEntry() {
    if (state.index + 1 < state.entries.length) void startEntry(state.index + 1);
    else listen.stop();
  },
  /** Back to the start of this one, or to the previous entry when already near the start. */
  prevEntry() {
    if (state.para > 1 || state.index === 0) {
      silence.play();
      return paras.length ? speakPara(0) : void startEntry(state.index, 0);
    }
    void startEntry(state.index - 1, 0);
  },
  jump(index: number) {
    if (index >= 0 && index < state.entries.length) void startEntry(index);
  },
  remove(index: number) {
    const entries = state.entries.filter((_, i) => i !== index);
    if (index === state.index) {
      if (!entries.length) return listen.stop();
      set({ entries, index: Math.min(index, entries.length - 1) });
      if (state.status === 'playing' || state.status === 'loading') void startEntry(state.index);
      else paras = [];
      return;
    }
    set({ entries, index: index < state.index ? state.index - 1 : state.index });
  },
  move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= state.entries.length) return;
    const entries = [...state.entries];
    [entries[index], entries[to]] = [entries[to], entries[index]];
    const cur = state.index === index ? to : state.index === to ? index : state.index;
    set({ entries, index: cur });
  },
  setRate(rate: number) {
    write(LS_RATE, String(rate));
    set({ rate });
    // Restart the paragraph so the new speed is heard now.
    if (state.status === 'playing') speakPara(state.para);
  },
  setVoice(voice: string | null) {
    write(LS_VOICE, voice);
    set({ voice });
    if (state.status === 'playing') speakPara(state.para);
  },
  setOpen(open: boolean) {
    set({ open });
  },
  /** The app tells the queue how to find a post's own text, for the fallback above. */
  setPostText(fn: (id: string) => string | undefined) {
    postText = fn;
  },
};

export function fromQueueEntry(q: { id: string; title: string; author: string; source: string; image: string | null }): ListenEntry {
  return { key: `a:${q.id}`, kind: 'article', id: q.id, title: q.title || 'Untitled', by: q.author || q.source, image: q.image };
}

export function articleEntry(it: { id: string; title?: string; text: string; author: { name: string }; media?: { type: string; url: string; thumb?: string }[] }): ListenEntry {
  const img = it.media?.find((m) => m.type === 'image');
  return { key: `a:${it.id}`, kind: 'article', id: it.id, title: it.title || it.text.slice(0, 80) || 'Untitled', by: it.author.name, image: img ? img.url : null };
}

/** A page (the morning edition, a digest) as one queue entry: its hero and digest sections. */
export function pageEntry(page: { id: string; name: string; blocks: PageBlock[] }): ListenEntry {
  const parts: { block: number; text: string }[] = [];
  page.blocks.forEach((b, i) => {
    if (b.type === 'hero') parts.push({ block: i, text: [b.title, b.subtitle].filter(Boolean).join('. ') });
    else if (b.type === 'digest') parts.push({ block: i, text: [b.title, b.text].filter(Boolean).join('. ') });
  });
  return { key: `p:${page.id}`, kind: 'page', id: page.id, title: page.name, by: 'Aurora', parts };
}
