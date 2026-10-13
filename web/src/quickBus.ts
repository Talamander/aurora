// The line between Quick look (/?quick=1) and the main Aurora window, on a same-origin
// BroadcastChannel. It carries the Listen queue's now-playing line to Quick look, and in a browser
// it carries "open this post" and "ask this" to the Aurora tab you used last. The desktop app sends
// those two over its own IPC instead (desktop/preload.cjs), so this file only ever talks to pages
// from the same Aurora server. Messages are still checked field by field before anything acts.

const CHANNEL = 'aurora.quick';

export interface NowPlaying {
  title: string;
  by: string;
  status: 'loading' | 'playing' | 'paused';
}

type Msg =
  | { t: 'who'; n: string }
  | { t: 'here'; n: string; tab: string; at: number }
  | { t: 'open'; to: string; id: string }
  | { t: 'ask'; to: string; text: string }
  | { t: 'listen?' }
  | { t: 'listen'; now: NowPlaying | null }
  | { t: 'listen-toggle' };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

function channel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const ch = new BroadcastChannel(CHANNEL);
    // Node (the test runner) has BroadcastChannel too; never let it hold the process open.
    (ch as { unref?: () => void }).unref?.();
    return ch;
  } catch {
    return null;
  }
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** Opens Quick look: the desktop app's own window, or a small popup in a browser. */
export function openQuickLook() {
  const d = window.auroraDesktop;
  if (d?.showQuick) return d.showQuick();
  window.open('/?quick=1', 'aurora-quick', 'popup,width=620,height=560');
}

// ------------------------------------------------------------------ the main window's side

/**
 * Mounted by the app. Answers Quick look's "who is there?" with when this tab was last focused,
 * and runs open and ask messages addressed to this tab only, so two open tabs never both act.
 */
export function serveQuickLook(on: { open: (id: string) => void; ask: (text: string) => void }): () => void {
  const ch = channel();
  if (!ch) return () => {};
  const tab = rand();
  let at = document.hasFocus() ? Date.now() : 0;
  const focused = () => (at = Date.now());
  addEventListener('focus', focused);
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as Partial<Msg> | null;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'who') {
      const n = str(m.n, 20);
      if (n) ch.postMessage({ t: 'here', n, tab, at } satisfies Msg);
    } else if (m.t === 'open' && m.to === tab) {
      const id = str(m.id, 300);
      if (id) {
        window.focus();
        on.open(id);
      }
    } else if (m.t === 'ask' && m.to === tab) {
      const text = str(m.text, 2000)?.trim();
      if (text) {
        window.focus();
        on.ask(text);
      }
    }
  };
  return () => {
    removeEventListener('focus', focused);
    ch.close();
  };
}

/** Used by the Listen queue: publishes what is playing and takes play/pause from Quick look. */
export function publishListen(now: () => NowPlaying | null, toggle: () => void): (n: NowPlaying | null) => void {
  const ch = channel();
  if (!ch) return () => {};
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as Partial<Msg> | null;
    if (m?.t === 'listen?') ch.postMessage({ t: 'listen', now: now() } satisfies Msg);
    else if (m?.t === 'listen-toggle') toggle();
  };
  let last = '';
  return (n) => {
    const key = JSON.stringify(n);
    if (key === last) return;
    last = key;
    ch.postMessage({ t: 'listen', now: n } satisfies Msg);
  };
}

// ------------------------------------------------------------------ Quick look's side

function cleanNow(v: unknown): NowPlaying | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = str(o.title, 200);
  const status = o.status === 'loading' || o.status === 'playing' || o.status === 'paused' ? o.status : null;
  if (!title || !status) return null;
  return { title, by: str(o.by, 80) ?? '', status };
}

export interface QuickBus {
  /** The Aurora tab focused most recently, if any answers within a moment. */
  findMain(): Promise<string | null>;
  open(tab: string, id: string): void;
  ask(tab: string, text: string): void;
  toggleListen(): void;
  close(): void;
}

export function quickBus(onListen: (now: NowPlaying | null) => void): QuickBus {
  const ch = channel();
  const waiting = new Map<string, { tab: string; at: number }[]>();
  if (ch) {
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data as Partial<Msg> | null;
      if (!m || typeof m !== 'object') return;
      if (m.t === 'listen') onListen(cleanNow(m.now));
      else if (m.t === 'here' && typeof m.n === 'string' && typeof m.tab === 'string') waiting.get(m.n)?.push({ tab: m.tab, at: Number(m.at) || 0 });
    };
    ch.postMessage({ t: 'listen?' } satisfies Msg);
  }
  return {
    async findMain() {
      if (!ch) return null;
      const n = rand();
      const answers: { tab: string; at: number }[] = [];
      waiting.set(n, answers);
      ch.postMessage({ t: 'who', n } satisfies Msg);
      await new Promise((r) => setTimeout(r, 180));
      waiting.delete(n);
      return answers.sort((a, b) => b.at - a.at)[0]?.tab ?? null;
    },
    open: (tab, id) => ch?.postMessage({ t: 'open', to: tab, id } satisfies Msg),
    ask: (tab, text) => ch?.postMessage({ t: 'ask', to: tab, text } satisfies Msg),
    toggleListen: () => ch?.postMessage({ t: 'listen-toggle' } satisfies Msg),
    close: () => ch?.close(),
  };
}
