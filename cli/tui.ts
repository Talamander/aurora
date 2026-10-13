// Aurora in the terminal: a keyboard-driven reader over the local Aurora server. It filters the
// library client-side with the same engine as the web app, so views, profiles and the search
// syntax behave identically. Every string that came from a post, an article or the agent goes
// through sanitize() before it is printed.

import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { applyFilters, DEFAULT_SPEC, normalizeSpec, type Evaluation } from '../core/filter.ts';
import { ALL_PROFILE, findProfile, scopeLibrary } from '../core/profiles.ts';
import type { ArticleBlock, ArticleRecord } from '../core/longform.ts';
import { spansText } from '../core/longform.ts';
import type { FilterSpec, Item, Library, Profile } from '../core/types.ts';
import type { Client, StreamEvent } from './api.ts';
import { oneLine, sanitize } from './sanitize.ts';
import { ACCENT, AURORA, ago, colorDepth, makePaint, pad, truncate, width, wrap, type Paint } from './term.ts';

interface ViewDef {
  id: string;
  name: string;
  spec: FilterSpec;
}

// The same four built-in views as the web app (web/src/state.ts).
const BUILTIN: ViewDef[] = [
  { id: 'worth', name: 'Worth reading', spec: { ...DEFAULT_SPEC, read: 'unread', hideNoise: true } },
  { id: 'saved', name: 'Saved', spec: { ...DEFAULT_SPEC, saved: 'saved', archived: 'any' } },
  { id: 'everything', name: 'Everything', spec: { ...DEFAULT_SPEC } },
  { id: 'archive', name: 'Archive', spec: { ...DEFAULT_SPEC, archived: 'only' } },
];

type Seg = { t: string; fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; raw?: string };
type Row = Seg[];
type Mode = 'list' | 'reader' | 'ask' | 'help' | 'pick-view' | 'pick-profile';

interface ChatMsg {
  role: 'you' | 'aurora' | 'tool' | 'error';
  text: string;
  ok?: boolean;
}

export interface TuiOptions {
  client: Client;
  profile?: string;
  view?: string;
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const api = opts.client;
  const P: Paint = makePaint(colorDepth(process.env, !!out.isTTY));
  const colored = colorDepth(process.env, !!out.isTTY) !== 0;

  let lib: Library = await api.library();
  let profileId = (opts.profile && (opts.profile === ALL_PROFILE ? ALL_PROFILE : findProfile(lib.profiles, opts.profile)?.id)) || lib.activeProfile || ALL_PROFILE;
  if (profileId !== ALL_PROFILE && !findProfile(lib.profiles, profileId)) profileId = ALL_PROFILE;
  let viewId = opts.view ?? 'worth';
  let query = '';
  let keepRead = new Set<string>();
  let list: Evaluation[] = [];
  let sel = 0;
  let top = 0;
  let mode: Mode = 'list';
  let prevMode: Mode = 'list';
  let pickIdx = 0;
  let pendingG = false;
  let toast: { text: string; tone: 'info' | 'error'; until: number } | null = null;
  let live = false;
  // Line input (search or ask). While set, keys edit it.
  let editing: { kind: 'search' | 'ask'; text: string; before: string } | null = null;
  // Reader
  let readerId: string | null = null;
  let readerScroll = 0;
  let article: (ArticleRecord & { canExtract?: boolean }) | null = null;
  let articleBusy = false;
  // Agent
  let threadId: string | null = null;
  const chat: ChatMsg[] = [];
  let liveReply = '';
  let asking = false;
  let chatScroll = 0; // lines from the bottom
  const undo: { label: string; ids: string[]; patch: Record<string, unknown> }[] = [];
  let frameQueued = false;

  const scoped = () => scopeLibrary(lib, profileId);
  const profile = (): Profile | null => (profileId === ALL_PROFILE ? null : findProfile(lib.profiles, profileId));
  const views = (): ViewDef[] => [...BUILTIN, ...scoped().views.map((v) => ({ id: v.id, name: v.name, spec: v.spec }))];
  const view = () => views().find((v) => v.id === viewId) ?? BUILTIN[0];
  const labels = () => Object.fromEntries(lib.sources.map((s) => [s.id, s.label]));
  const current = (): Item | null => list[sel]?.item ?? null;
  const byId = (id: string) => lib.items.find((i) => i.id === id) ?? null;

  function refilter(keepSelection = true) {
    const was = current()?.id;
    const l = scoped();
    const spec = normalizeSpec({ ...view().spec, query: query || view().spec.query });
    list = applyFilters(l.items, spec, { topics: l.topics, sourceLabels: labels(), keepRead, ai: { rules: l.aiRules, labels: l.labels } }).visible;
    if (keepSelection && was) {
      const i = list.findIndex((e) => e.item.id === was);
      if (i >= 0) sel = i;
    }
    sel = Math.max(0, Math.min(sel, list.length - 1));
  }

  function say(text: string, tone: 'info' | 'error' = 'info') {
    toast = { text, tone, until: Date.now() + 3500 };
    render();
    setTimeout(() => render(), 3600);
  }

  // ── Terminal setup and teardown ──────────────────────────────────────────────────────────
  let closed = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  const streamAbort = new AbortController();
  function restore() {
    if (closed) return;
    closed = true;
    streamAbort.abort();
    try {
      if (input.isTTY) input.setRawMode(false);
    } catch {
      /* already closed */
    }
    out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
  function quit() {
    restore();
    input.pause();
    resolveDone();
  }
  process.once('exit', restore);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.once(sig, () => (quit(), process.exit(0)));
  for (const ev of ['uncaughtException', 'unhandledRejection'] as const)
    process.once(ev, (e) => {
      restore();
      console.error(e);
      process.exit(1);
    });
  out.on('resize', () => render());
  process.on('SIGWINCH', () => render());

  out.write('\x1b[?1049h\x1b[?25l');
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.resume();

  // ── Live updates ────────────────────────────────────────────────────────────────────────
  let reloadTimer: NodeJS.Timeout | null = null;
  async function reload() {
    try {
      lib = await api.library();
      refilter();
      render();
    } catch (e) {
      say(`Could not reload: ${(e as Error).message}`, 'error');
    }
  }
  function onEvent(e: StreamEvent) {
    if (e.type === 'library') {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void reload(), 150);
      return;
    }
    if (!threadId || e.threadId !== threadId) return;
    if (e.type === 'delta') {
      liveReply += String(e.text ?? '');
    } else if (e.type === 'agent') {
      const ev = e.event ?? {};
      if (ev.type === 'assistant') {
        chat.push({ role: 'aurora', text: String(ev.data?.text ?? liveReply) });
        liveReply = '';
      } else if (ev.type === 'tool_call') {
        chat.push({ role: 'tool', text: String(ev.data?.label ?? ev.data?.name ?? 'tool') });
      } else if (ev.type === 'tool_result') {
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i].role === 'tool' && chat[i].ok === undefined) { chat[i].ok = !!ev.data?.ok; break; }
      } else if (ev.type === 'done') {
        if (liveReply.trim()) chat.push({ role: 'aurora', text: liveReply });
        liveReply = '';
        asking = false;
      } else if (ev.type === 'error') {
        chat.push({ role: 'error', text: String(ev.data?.text ?? 'The agent failed') });
        liveReply = '';
        asking = false;
      }
    }
    if (mode === 'ask') render();
  }
  (async function connect() {
    while (!closed) {
      try {
        live = true;
        render();
        await api.stream(onEvent, streamAbort.signal);
      } catch {
        /* reconnect below */
      }
      live = false;
      if (closed) return;
      render();
      await new Promise((r) => setTimeout(r, 2000));
      if (!closed) void reload();
    }
  })();

  // ── Actions ─────────────────────────────────────────────────────────────────────────────
  async function patchState(ids: string[], patch: Record<string, unknown>, label: string, record = true) {
    const before = ids.map((id) => byId(id)).filter((x): x is Item => !!x);
    if (record && before.length) {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(patch)) prev[k] = (before[0].state as any)[k];
      undo.push({ label, ids, patch: prev });
      if (undo.length > 50) undo.shift();
    }
    // Optimistic: the next server event brings the truth.
    lib = { ...lib, items: lib.items.map((it) => (ids.includes(it.id) ? { ...it, state: { ...it.state, ...patch } } : it)) };
    refilter();
    render();
    try {
      await api.setState(ids, patch);
    } catch (e) {
      say(`${label} failed: ${(e as Error).message}`, 'error');
      void reload();
    }
  }
  function openUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return say('That post has no web link', 'error');
    const [cmd, args] = process.env.BROWSER
      ? [process.env.BROWSER, [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // not cmd /c start: cmd would interpret & in the URL
          : ['xdg-open', [url]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => say(`Could not run ${cmd}`, 'error'));
      child.unref();
      say(`Opened ${truncate(oneLine(new URL(url).host), 40)}`);
    } catch {
      say(`Could not run ${cmd}`, 'error');
    }
  }
  async function openReader(it: Item) {
    readerId = it.id;
    readerScroll = 0;
    article = null;
    mode = 'reader';
    if (!it.state.read) {
      keepRead.add(it.id);
      void patchState([it.id], { read: true }, 'Mark read', false);
    }
    render();
    if (it.kind === 'article' || /https?:\/\//.test(it.url)) {
      try {
        article = await api.article(it.id);
        if (article.status !== 'ok' && it.kind === 'article' && article.canExtract) await fetchArticle(it, false);
      } catch {
        article = null;
      }
      if (readerId === it.id) render();
    }
  }
  async function fetchArticle(it: Item, force: boolean) {
    if (articleBusy) return;
    articleBusy = true;
    render();
    try {
      const rec = await api.extract(it.id);
      if (readerId === it.id) article = { ...rec, canExtract: true };
      if (force && rec.status !== 'ok') say(rec.error ? `No article: ${oneLine(rec.error)}` : 'No article text found', 'error');
    } catch (e) {
      if (force) say(`Could not fetch the article: ${(e as Error).message}`, 'error');
    } finally {
      articleBusy = false;
      render();
    }
  }
  async function ask(text: string) {
    try {
      const st = await api.agentStatus();
      if (!st.ready) {
        chat.push({ role: 'error', text: st.reason ?? 'The AI is not set up yet. Open AI settings in the app.' });
        return render();
      }
      if (!threadId) threadId = (await api.newThread('From the terminal')).id;
      chat.push({ role: 'you', text });
      asking = true;
      chatScroll = 0;
      render();
      const it = current();
      await api.ask(threadId, text, { profile: profileId, screen: 'terminal', viewName: view().name, shown: list.length, spec: query ? { query } : {}, selectedPostId: it?.id ?? null });
    } catch (e) {
      asking = false;
      chat.push({ role: 'error', text: (e as Error).message });
      render();
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────────────────
  function paintRow(segs: Row, cols: number, bg: string = AURORA.sky): string {
    let s = colored ? P.bg(bg) : '';
    let w = 0;
    for (const seg of segs) {
      if (w >= cols) break;
      const room = cols - w;
      const tw = width(seg.t);
      const fits = tw <= room;
      const text = fits ? seg.t : truncate(seg.t, room);
      const style = (seg.fg ? P.fg(seg.fg) : '') + (seg.bg ? P.bg(seg.bg) : '') + (seg.b ? P.bold : '') + (seg.d ? P.dim : '') + (seg.i ? P.italic : '');
      s += style + (fits && seg.raw && colored ? seg.raw : text) + (colored ? `\x1b[22;23;39m${seg.bg ? P.bg(bg) : ''}` : '');
      w += width(text);
    }
    return s + ' '.repeat(Math.max(0, cols - w)) + P.reset;
  }

  function header(cols: number): Row {
    const pr = profile();
    const left: Row = [
      { t: ' ' },
      { t: '◆ aurora', raw: P.gradient('◆ aurora', ACCENT), b: true },
      { t: '  ' },
      { t: '● ', fg: pr?.color ?? AURORA.violet },
      { t: pr ? oneLine(pr.name) : 'All', fg: AURORA.text },
      { t: '  /  ', fg: AURORA.faint },
      { t: mode === 'ask' ? 'Ask your feed' : oneLine(view().name), fg: AURORA.text, b: true },
      { t: mode === 'ask' ? '' : `  ${list.length}`, fg: AURORA.faint },
    ];
    const right: Row = [];
    if (query) right.push({ t: `/${oneLine(query)}  `, fg: AURORA.teal });
    right.push({ t: live ? '● live ' : '○ offline ', fg: live ? AURORA.green : AURORA.red });
    const lw = left.reduce((n, s) => n + width(s.t), 0);
    const rw = right.reduce((n, s) => n + width(s.t), 0);
    return [...left, { t: ' '.repeat(Math.max(1, cols - lw - rw)) }, ...right];
  }

  function footer(cols: number): Row {
    if (editing) {
      const label = editing.kind === 'search' ? ' / ' : ' ask › ';
      const shown = truncate(editing.text, Math.max(4, cols - width(label) - 2));
      return [{ t: label, fg: editing.kind === 'search' ? AURORA.teal : AURORA.pink, b: true }, { t: shown, fg: AURORA.text }, { t: '█', fg: AURORA.amber }];
    }
    if (toast && toast.until > Date.now()) return [{ t: ` ${toast.tone === 'error' ? '✕' : '✓'} `, fg: toast.tone === 'error' ? AURORA.red : AURORA.green, b: true }, { t: oneLine(toast.text), fg: AURORA.text }];
    const keys: [string, string][] =
      mode === 'reader'
        ? [['j/k', 'scroll'], ['n/N', 'next'], ['o', 'open'], ['s', 'save'], ['a', 'archive'], ['f', 'full article'], ['esc', 'back']]
        : mode === 'ask'
          ? [['.', 'ask'], ['j/k', 'scroll'], ['esc', 'back']]
          : [['j/k', 'move'], ['⏎', 'open'], ['s', 'save'], ['a', 'archive'], ['r', 'mark read'], ['/', 'search'], ['v', 'views'], ['p', 'profiles'], ['.', 'ask'], ['?', 'help']];
    const row: Row = [{ t: ' ' }];
    for (const [k, v] of keys) row.push({ t: k, fg: AURORA.amber, b: true }, { t: ` ${v}   `, fg: AURORA.faint });
    return row;
  }

  function listRows(cols: number, height: number): string[] {
    const per = 2;
    const fit = Math.max(1, Math.floor(height / per));
    if (sel < top) top = sel;
    if (sel >= top + fit) top = sel - fit + 1;
    top = Math.max(0, Math.min(top, Math.max(0, list.length - fit)));
    const lines: string[] = [];
    if (!list.length) {
      const msg = query ? `Nothing matches /${oneLine(query)}` : view().id === 'worth' ? 'You are caught up.' : 'Nothing here yet.';
      const pad0 = Math.floor(height / 2) - 1;
      for (let i = 0; i < height; i++) {
        if (i === pad0) lines.push(paintRow([{ t: ' '.repeat(Math.max(0, Math.floor((cols - width(msg)) / 2))) }, { t: msg, raw: P.gradient(msg, ACCENT), b: true }], cols));
        else if (i === pad0 + 1 && !query && view().id === 'worth') {
          const sub = 'v for views · p for profiles';
          lines.push(paintRow([{ t: ' '.repeat(Math.max(0, Math.floor((cols - width(sub)) / 2))) }, { t: sub, fg: AURORA.faint }], cols));
        } else lines.push(paintRow([], cols));
      }
      return lines;
    }
    const lbl = labels();
    for (let i = top; i < Math.min(list.length, top + fit); i++) {
      const it = list[i].item;
      const on = i === sel;
      const bg = on ? AURORA.sel : AURORA.sky;
      const bar: Seg = on ? { t: '▌', fg: AURORA.pink } : { t: ' ' };
      const dot: Seg = it.state.read ? { t: '  ' } : { t: '● ', fg: AURORA.amber };
      const when = ago(it.publishedAt);
      const src = oneLine(lbl[it.sourceId] ?? it.platform);
      const marks = `${it.state.saved ? '★ ' : ''}${it.kind === 'article' ? '¶ ' : ''}${it.media.some((m) => m.type === 'video') ? '▶ ' : it.media.length ? '▣ ' : ''}`;
      const right = `${marks}${when} `;
      const author = oneLine(it.author.name) || oneLine(it.author.handle) || 'Unknown';
      const handle = it.author.handle && oneLine(it.author.handle) !== author ? ` ${oneLine(it.author.handle).replace(/^@?/, '@')}` : '';
      const leftW = cols - width(right) - 1;
      const meta = truncate(`${author}`, Math.max(6, Math.floor(leftW * 0.45)));
      const rest = truncate(`${handle} · ${src}`, Math.max(0, leftW - 3 - width(meta)));
      const l1: Row = [bar, dot, { t: meta, fg: on ? AURORA.text : it.state.read ? AURORA.soft : AURORA.text, b: !it.state.read }, { t: rest, fg: AURORA.faint }];
      const l1w = l1.reduce((n, s) => n + width(s.t), 0);
      l1.push({ t: ' '.repeat(Math.max(1, cols - l1w - width(right))) }, { t: marks, fg: AURORA.amber }, { t: `${when} `, fg: AURORA.faint });
      const title = oneLine(it.title ?? '');
      const body = oneLine(it.text);
      const l2: Row = [bar, { t: '  ' }];
      if (title) l2.push({ t: title, fg: on ? AURORA.amber : AURORA.text, b: true }, { t: body && body !== title ? `  ${body}` : '', fg: AURORA.faint });
      else l2.push({ t: body || oneLine(it.url), fg: on ? AURORA.text : AURORA.soft });
      lines.push(paintRow(l1, cols, bg), paintRow(l2, cols, bg));
    }
    while (lines.length < height) lines.push(paintRow([], cols));
    return lines;
  }

  function citations(text: string): string {
    return text.replace(/\[\[(post|highlight):([^\]\s]+)\]\]/g, (_m, kind, id) => {
      if (kind === 'highlight') return '‹highlight›';
      const it = byId(id);
      return it ? `‹${oneLine(it.author.name)}: ${truncate(oneLine(it.title || it.text), 48)}›` : '';
    });
  }

  function blockRows(b: ArticleBlock, w: number): Row[] {
    const rows: Row[] = [];
    const para = (text: string, fg: string, prefix: Seg | null = null, extra: Partial<Seg> = {}) => {
      const pw = prefix ? width(prefix.t) : 0;
      for (const line of wrap(sanitize(text), w - pw)) rows.push([...(prefix ? [prefix] : []), { t: line, fg, ...extra }]);
    };
    switch (b.t) {
      case 'h':
        rows.push([]);
        para(b.text, AURORA.amber, null, { b: true });
        break;
      case 'p':
        para(spansText(b.spans), AURORA.text);
        break;
      case 'ul':
      case 'ol':
        b.items.forEach((spans, i) => {
          const mark = b.t === 'ul' ? '• ' : `${i + 1}. `;
          const lines = wrap(sanitize(spansText(spans)), w - width(mark));
          lines.forEach((l, j) => rows.push([{ t: j ? ' '.repeat(width(mark)) : mark, fg: AURORA.pink }, { t: l, fg: AURORA.text }]));
        });
        break;
      case 'quote':
        para(spansText(b.spans), AURORA.soft, { t: '│ ', fg: AURORA.violet }, { i: true });
        break;
      case 'code':
        for (const l of sanitize(b.text).split('\n')) rows.push([{ t: '  ' }, { t: truncate(l.replace(/\t/g, '  '), w - 2), fg: AURORA.teal }]);
        break;
      case 'img':
        rows.push([{ t: `▣ ${oneLine(b.alt || b.caption || 'image')}`, fg: AURORA.faint, i: true }]);
        break;
      case 'hr':
        rows.push([{ t: '─'.repeat(Math.min(w, 24)), fg: AURORA.line }]);
        break;
    }
    rows.push([]);
    return rows;
  }

  function postRows(it: Item, w: number, full: boolean): Row[] {
    const rows: Row[] = [];
    const lbl = labels();
    const pr = (text: string, fg: string, extra: Partial<Seg> = {}) => {
      for (const line of wrap(sanitize(text), w)) rows.push([{ t: line, fg, ...extra }]);
    };
    rows.push([
      { t: oneLine(it.author.name) || 'Unknown', fg: AURORA.text, b: true },
      { t: it.author.handle ? `  ${oneLine(it.author.handle).replace(/^@?/, '@')}` : '', fg: AURORA.faint },
    ]);
    rows.push([
      { t: oneLine(lbl[it.sourceId] ?? it.platform), fg: AURORA.violet },
      { t: `  ·  ${ago(it.publishedAt)}${it.state.saved ? '  ·  ★ saved' : ''}${it.state.archived ? '  ·  archived' : ''}`, fg: AURORA.faint },
    ]);
    rows.push([]);
    const art = full && article?.status === 'ok' && article.article && article.article.blocks.length ? article.article : null;
    const title = oneLine(art?.title || it.title || '');
    if (title) {
      for (const line of wrap(title, w)) rows.push([{ t: line, raw: P.gradient(line, ACCENT), b: true }]);
      if (art) rows.push([{ t: [art.byline, art.siteName, `${art.minutes} min`].filter(Boolean).map((x) => oneLine(x)).join('  ·  '), fg: AURORA.faint }]);
      rows.push([]);
    }
    if (art) {
      for (const b of art.blocks) rows.push(...blockRows(b, w));
    } else {
      const text = sanitize(it.text).trim();
      if (text && text !== title) {
        pr(text, AURORA.text);
        rows.push([]);
      }
      if (it.quoted) {
        rows.push([{ t: '│ ', fg: AURORA.violet }, { t: oneLine(it.quoted.author.name), fg: AURORA.soft, b: true }]);
        for (const line of wrap(sanitize(it.quoted.text), w - 2)) rows.push([{ t: '│ ', fg: AURORA.violet }, { t: line, fg: AURORA.soft }]);
        rows.push([]);
      }
      if (full) {
        if (articleBusy) rows.push([{ t: '⟡ fetching the full article…', fg: AURORA.pink, i: true }], []);
        else if (article?.status === 'error') rows.push([{ t: `No full article: ${oneLine(article.error ?? 'unknown error')}`, fg: AURORA.faint, i: true }], []);
        else if (article?.canExtract && article.status !== 'ok') rows.push([{ t: 'f', fg: AURORA.amber, b: true }, { t: ' fetch the full article', fg: AURORA.faint }], []);
      }
    }
    const media = it.media.filter((m) => m.url);
    if (media.length) {
      for (const m of media.slice(0, 6)) rows.push([{ t: `${m.type === 'video' ? '▶' : '▣'} ${m.type}  `, fg: AURORA.faint }, { t: truncate(oneLine(m.url), w - 10), fg: AURORA.faint, d: true }]);
      rows.push([]);
    }
    const links = it.links.filter((l) => l !== it.url).slice(0, 6);
    for (const l of links) rows.push([{ t: '↗ ', fg: AURORA.teal }, { t: truncate(oneLine(l), w - 2), fg: AURORA.teal }]);
    if (it.url) rows.push([{ t: 'o ', fg: AURORA.amber, b: true }, { t: truncate(oneLine(it.url), w - 2), fg: AURORA.faint, d: true }]);
    return rows;
  }

  function readerLines(it: Item, cols: number, height: number, full: boolean, scroll: number): { lines: string[]; max: number } {
    const w = Math.max(20, Math.min(cols - 4, 84));
    const margin = full ? Math.max(2, Math.floor((cols - w) / 2)) : 2;
    const rows = postRows(it, full ? w : cols - 4, full);
    const max = Math.max(0, rows.length - height);
    const s = Math.min(scroll, max);
    const lines = rows.slice(s, s + height).map((r) => paintRow([{ t: ' '.repeat(margin) }, ...r], cols));
    while (lines.length < height) lines.push(paintRow([], cols));
    if (full && max > 0) {
      // A thin progress rail on the right edge.
      const pos = Math.round((s / max) * (height - 1));
      lines[pos] = lines[pos].replace(/ (\x1b\[0m)?$/, (m, r) => `${P.fg(AURORA.pink)}┃${r ?? ''}`);
    }
    return { lines, max };
  }

  function chatLines(cols: number, height: number): string[] {
    const w = Math.max(20, Math.min(cols - 6, 92));
    const margin = Math.max(2, Math.floor((cols - w) / 2));
    const rows: Row[] = [];
    if (!chat.length && !liveReply) {
      rows.push([{ t: 'Ask your feed anything.', raw: P.gradient('Ask your feed anything.', ACCENT), b: true }], []);
      for (const ex of ['what did people say about local models today?', 'make a view for long reads from blogs', 'summarize the post I have selected']) rows.push([{ t: '  · ', fg: AURORA.faint }, { t: ex, fg: AURORA.soft, i: true }]);
    }
    const msgs: ChatMsg[] = liveReply ? [...chat, { role: 'aurora', text: liveReply }] : chat;
    for (const m of msgs) {
      if (m.role === 'tool') {
        rows.push([{ t: m.ok === undefined ? '  ⟡ ' : m.ok ? '  ✓ ' : '  ✕ ', fg: m.ok === false ? AURORA.red : AURORA.violet }, { t: oneLine(m.text), fg: AURORA.faint }]);
        continue;
      }
      const who = m.role === 'you' ? 'you' : m.role === 'error' ? 'error' : 'aurora';
      rows.push([]);
      rows.push(who === 'aurora' ? [{ t: '◆ aurora', raw: P.gradient('◆ aurora', ACCENT), b: true }] : [{ t: who, fg: who === 'error' ? AURORA.red : AURORA.amber, b: true }]);
      for (const line of wrap(citations(sanitize(m.text)).trim(), w)) rows.push([{ t: line, fg: m.role === 'you' ? AURORA.soft : AURORA.text }]);
    }
    if (asking && !liveReply) rows.push([], [{ t: '⟡ thinking…', fg: AURORA.pink, i: true }]);
    const max = Math.max(0, rows.length - height);
    chatScroll = Math.min(chatScroll, max);
    const start = max - chatScroll;
    const lines = rows.slice(start, start + height).map((r) => paintRow([{ t: ' '.repeat(margin) }, ...r], cols));
    while (lines.length < height) lines.push(paintRow([], cols));
    return lines;
  }

  function overlay(lines: string[], cols: number, height: number, title: string, items: { label: string; hint?: string; color?: string; on?: boolean }[], idx: number) {
    const w = Math.min(cols - 4, 52);
    const h = Math.min(height - 2, items.length + 4);
    const x = Math.floor((cols - w) / 2);
    const y = Math.max(0, Math.floor((height - h) / 3));
    const box: string[] = [];
    const edge = (l: string, r: string, mid: string) => P.fg(AURORA.line) + P.bg(AURORA.panel) + l + mid + r + P.reset;
    box.push(edge('╭', '╮', `─ ${title} `.padEnd(w - 2, '─').slice(0, w - 2)));
    const visible = h - 4;
    const first = Math.max(0, Math.min(idx - visible + 1, items.length - visible));
    box.push(P.bg(AURORA.panel) + P.fg(AURORA.line) + '│' + paintRow([], w - 2, AURORA.panel) + P.bg(AURORA.panel) + P.fg(AURORA.line) + '│' + P.reset);
    for (let i = first; i < Math.min(items.length, first + visible); i++) {
      const it = items[i];
      const on = i === idx;
      const row: Row = [
        { t: on ? ' ▶ ' : '   ', fg: AURORA.pink },
        { t: it.color ? '● ' : '', fg: it.color },
        { t: it.label, fg: on ? AURORA.amber : AURORA.text, b: on },
        { t: it.on ? '  ✓' : '', fg: AURORA.green },
      ];
      const lw = row.reduce((n, s) => n + width(s.t), 0);
      if (it.hint) row.push({ t: ' '.repeat(Math.max(1, w - 2 - lw - width(it.hint) - 2)) }, { t: it.hint, fg: AURORA.faint });
      box.push(P.bg(AURORA.panel) + P.fg(AURORA.line) + '│' + paintRow(row, w - 2, on ? AURORA.sel : AURORA.panel) + P.bg(AURORA.panel) + P.fg(AURORA.line) + '│' + P.reset);
    }
    box.push(edge('╰', '╯', '─'.repeat(w - 2)));
    // Splice the box over the body lines. Each line is rebuilt from the left part, the box and padding.
    box.forEach((b, i) => {
      const li = y + i;
      if (li >= lines.length) return;
      lines[li] = paintRow([{ t: ' '.repeat(x) }], x) + b + paintRow([], Math.max(0, cols - x - w));
    });
  }

  function helpItems() {
    return [
      ['j / k  ↓ / ↑', 'move'],
      ['gg / G', 'top / bottom'],
      ['ctrl-d / ctrl-u', 'half page'],
      ['⏎ or l', 'read the post'],
      ['n / N', 'next / previous while reading'],
      ['f', 'fetch the full article'],
      ['s / a / r', 'save, archive, read (local only)'],
      ['u', 'undo the last change'],
      ['o', 'open the original in the browser'],
      ['/', 'search: "phrase" -word from:name'],
      ['v  or 1-9', 'switch view'],
      ['p', 'switch profile'],
      ['.', 'ask your feed (the agent)'],
      ['ctrl-r', 'reload'],
      ['q', 'quit'],
    ].map(([k, v]) => ({ label: k, hint: v }));
  }

  function render() {
    if (closed || frameQueued) return;
    frameQueued = true;
    queueMicrotask(() => {
      frameQueued = false;
      if (closed) return;
      draw();
    });
  }

  function draw() {
    const cols = Math.max(20, out.columns || 80);
    const rows = Math.max(6, out.rows || 24);
    const bodyH = rows - 3;
    let body: string[] = [];
    const it = mode === 'reader' && readerId ? byId(readerId) : null;
    if (mode === 'reader' && it) {
      const r = readerLines(it, cols, bodyH, true, readerScroll);
      readerScroll = Math.min(readerScroll, r.max);
      body = r.lines;
    } else if (mode === 'ask') {
      body = chatLines(cols, bodyH);
    } else {
      // Wide terminals get a live preview of the selected post beside the list.
      if (cols >= 110 && current()) {
        const lw = Math.floor(cols * 0.47);
        const pw = cols - lw - 1;
        const left = listRows(lw, bodyH);
        const right = readerLines(current()!, pw, bodyH, false, 0).lines;
        body = left.map((l, i) => l + P.bg(AURORA.sky) + P.fg(AURORA.line) + '│' + P.reset + right[i]);
      } else body = listRows(cols, bodyH);
      if (mode === 'pick-view') overlay(body, cols, bodyH, 'Views', views().map((v, i) => ({ label: oneLine(v.name), hint: i < 9 ? String(i + 1) : '', on: v.id === viewId })), pickIdx);
      if (mode === 'pick-profile')
        overlay(
          body,
          cols,
          bodyH,
          'Profiles',
          [{ id: ALL_PROFILE, name: 'All', color: AURORA.violet }, ...(lib.profiles ?? [])].map((p) => ({ label: oneLine(p.name), color: p.color, on: p.id === profileId })),
          pickIdx,
        );
      if (mode === 'help') overlay(body, cols, bodyH, 'Keys', helpItems(), -1);
    }
    const rule = paintRow([{ t: '─'.repeat(cols), fg: AURORA.line }], cols);
    const frame = [paintRow(header(cols), cols), rule, ...body.slice(0, bodyH), paintRow(footer(cols), cols, AURORA.panel)];
    // Synchronized output keeps fast terminals from showing half-drawn frames.
    out.write('\x1b[?2026h\x1b[H' + frame.join('\r\n') + '\x1b[?2026l');
  }

  // ── Input ───────────────────────────────────────────────────────────────────────────────
  function move(to: number) {
    sel = Math.max(0, Math.min(list.length - 1, to));
    render();
  }
  function setView(id: string) {
    viewId = id;
    keepRead = new Set();
    sel = 0;
    top = 0;
    refilter(false);
  }
  function stepReader(d: number) {
    const i = list.findIndex((e) => e.item.id === readerId);
    const next = list[i + d];
    if (!next) return say(d > 0 ? 'That was the last one' : 'That was the first one');
    sel = i + d;
    void openReader(next.item);
  }

  input.on('keypress', (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } = {}) => {
    if (closed) return;
    if (key.ctrl && key.name === 'c') return quit();
    const page = Math.max(1, Math.floor(((out.rows || 24) - 3) / 2));

    if (editing) {
      const e = editing;
      if (key.name === 'escape') {
        if (e.kind === 'search') {
          query = e.before;
          refilter();
        }
        editing = null;
      } else if (key.name === 'return' || key.name === 'enter') {
        editing = null;
        if (e.kind === 'search') {
          query = e.text.trim();
          keepRead = new Set();
          refilter(false);
        } else if (e.text.trim()) {
          void ask(e.text.trim());
          // Stay ready for a follow-up; esc closes the line, a second esc leaves the conversation.
          editing = { kind: 'ask', text: '', before: '' };
        }
      } else if (key.name === 'backspace') e.text = [...e.text].slice(0, -1).join('');
      else if (key.ctrl && key.name === 'u') e.text = '';
      else if (key.ctrl && key.name === 'w') e.text = e.text.replace(/\s*\S+\s*$/, '');
      else if (str && !key.ctrl && !key.meta) e.text += sanitize(str).replace(/\n/g, ' ');
      if (editing && editing.kind === 'search') {
        query = editing.text.trim();
        refilter(false);
      }
      return render();
    }

    if (mode === 'help') {
      mode = prevMode;
      return render();
    }
    if (mode === 'pick-view' || mode === 'pick-profile') {
      const n = mode === 'pick-view' ? views().length : (lib.profiles?.length ?? 0) + 1;
      if (key.name === 'escape' || str === 'q') mode = 'list';
      else if (str === 'j' || key.name === 'down') pickIdx = Math.min(n - 1, pickIdx + 1);
      else if (str === 'k' || key.name === 'up') pickIdx = Math.max(0, pickIdx - 1);
      else if (key.name === 'return' || key.name === 'enter' || (str && /^[1-9]$/.test(str))) {
        const i = str && /^[1-9]$/.test(str) ? Number(str) - 1 : pickIdx;
        if (mode === 'pick-view') {
          const v = views()[i];
          if (v) setView(v.id);
        } else {
          const p = [ALL_PROFILE, ...(lib.profiles ?? []).map((x) => x.id)][i];
          if (p) {
            profileId = p;
            if (!views().some((v) => v.id === viewId)) viewId = 'worth';
            setView(viewId);
          }
        }
        mode = 'list';
      }
      return render();
    }

    if (mode === 'reader') {
      const it = readerId ? byId(readerId) : null;
      const h = (out.rows || 24) - 3;
      if (key.name === 'escape' || str === 'q' || str === 'h' || key.name === 'left') mode = 'list';
      else if (str === 'j' || key.name === 'down') readerScroll++;
      else if (str === 'k' || key.name === 'up') readerScroll = Math.max(0, readerScroll - 1);
      else if (str === ' ' || key.name === 'pagedown' || (key.ctrl && key.name === 'd')) readerScroll += str === ' ' || key.name === 'pagedown' ? h - 2 : Math.floor(h / 2);
      else if (str === 'b' || key.name === 'pageup' || (key.ctrl && key.name === 'u')) readerScroll = Math.max(0, readerScroll - (key.ctrl ? Math.floor(h / 2) : h - 2));
      else if (str === 'g') readerScroll = 0;
      else if (str === 'G') readerScroll = 1e9;
      else if (str === 'n') return stepReader(1);
      else if (str === 'N') return stepReader(-1);
      else if (str === 'o' && it) openUrl(it.url);
      else if (str === 'f' && it) void fetchArticle(it, true);
      else if (str === 's' && it) void patchState([it.id], { saved: !it.state.saved }, it.state.saved ? 'Unsave' : 'Save').then(() => say(it.state.saved ? 'Removed from saved' : 'Saved'));
      else if (str === 'a' && it) {
        void patchState([it.id], { archived: !it.state.archived }, 'Archive');
        say(it.state.archived ? 'Back in the feed' : 'Archived · u to undo');
      } else if (str === '.') {
        mode = 'ask';
        editing = { kind: 'ask', text: '', before: '' };
      }
      return render();
    }

    if (mode === 'ask') {
      if (key.name === 'escape' || str === 'q') mode = 'list';
      else if (str === '.' || key.name === 'return' || str === 'i') editing = { kind: 'ask', text: '', before: '' };
      else if (str === 'k' || key.name === 'up') chatScroll++;
      else if (str === 'j' || key.name === 'down') chatScroll = Math.max(0, chatScroll - 1);
      return render();
    }

    // List mode
    const it = current();
    if (str !== 'g') pendingG = false;
    if (str === 'q') return quit();
    if (str === 'j' || key.name === 'down') return move(sel + 1);
    if (str === 'k' || key.name === 'up') return move(sel - 1);
    if (key.ctrl && key.name === 'd') return move(sel + Math.floor(page / 2));
    if (key.ctrl && key.name === 'u') return move(sel - Math.floor(page / 2));
    if (str === ' ' || key.name === 'pagedown') return move(sel + page);
    if (key.name === 'pageup') return move(sel - page);
    if (str === 'G' || key.name === 'end') return move(list.length - 1);
    if (key.name === 'home') return move(0);
    if (str === 'g') {
      if (pendingG) {
        pendingG = false;
        return move(0);
      }
      pendingG = true;
      return;
    }
    if ((key.name === 'return' || key.name === 'enter' || str === 'l' || key.name === 'right') && it) return void openReader(it);
    if (str === 's' && it) {
      say(it.state.saved ? 'Removed from saved' : 'Saved');
      return void patchState([it.id], { saved: !it.state.saved }, it.state.saved ? 'Unsave' : 'Save');
    }
    if (str === 'a' && it) {
      say(it.state.archived ? 'Back in the feed' : 'Archived · u to undo');
      return void patchState([it.id], { archived: !it.state.archived }, 'Archive');
    }
    if (str === 'r' && it) {
      if (it.state.read) keepRead.delete(it.id);
      else keepRead.add(it.id);
      return void patchState([it.id], { read: !it.state.read }, 'Read');
    }
    if (str === 'u') {
      const last = undo.pop();
      if (!last) return say('Nothing to undo');
      say(`Undid ${last.label.toLowerCase()}`);
      return void patchState(last.ids, last.patch, 'Undo', false);
    }
    if (str === 'o' && it) return openUrl(it.url);
    if (str === '/') {
      editing = { kind: 'search', text: query, before: query };
      return render();
    }
    if (str === 'v') {
      mode = 'pick-view';
      pickIdx = Math.max(0, views().findIndex((v) => v.id === viewId));
      return render();
    }
    if (str === 'p') {
      mode = 'pick-profile';
      pickIdx = Math.max(0, [ALL_PROFILE, ...(lib.profiles ?? []).map((x) => x.id)].indexOf(profileId));
      return render();
    }
    if (str && /^[1-9]$/.test(str)) {
      const v = views()[Number(str) - 1];
      if (v) setView(v.id);
      return render();
    }
    if (str === '.') {
      mode = 'ask';
      editing = { kind: 'ask', text: '', before: '' };
      return render();
    }
    if (str === '?') {
      prevMode = mode;
      mode = 'help';
      return render();
    }
    if (key.ctrl && key.name === 'r') return void reload().then(() => say('Reloaded'));
    if (key.name === 'escape' && query) {
      query = '';
      refilter();
      return render();
    }
  });

  refilter(false);
  render();
  await done;
}
