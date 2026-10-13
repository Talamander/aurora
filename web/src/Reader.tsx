// The reader: a quiet, full-screen page for one article. The article arrives as safe blocks
// (core/longform.ts) and renders as React elements only; links open in a new tab with no
// referrer, images are https only. Highlights, notes and the reading position stay local.

import '@fontsource-variable/literata/opsz.css';
import '@fontsource-variable/literata/opsz-italic.css';
import './reader.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { blockText, type Article, type ArticleBlock, type ArticleRecord, type Highlight, type HighlightColor, type Span } from '../../core/longform.ts';
import type { Item } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { canListen, speaker, useSpeaker, type ListenPart } from './Listen.tsx';
import { articleEntry, listen as listenQueue } from './listenQueue.ts';
import { closeLongform, download, fmtMinutes, lf, READ_LATER, refreshHighlights } from './longform.ts';
import { RichText } from './rich.tsx';
import type { Reader as AppState } from './state.ts';
import { useDialog } from './useDialog.ts';
import { useThread } from './threads.ts';

// ---------------------------------------------------------------- preferences

interface Prefs {
  font: 'serif' | 'sans';
  size: number;
  width: 'narrow' | 'medium' | 'wide';
  paper: 'auto' | 'paper';
}
const DEFAULT_PREFS: Prefs = { font: 'serif', size: 19, width: 'medium', paper: 'auto' };
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('aurora.reader.v1') ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem('aurora.reader.v1', JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------- highlight ranges

interface Range {
  start: number;
  end: number;
  h: Highlight;
}

/** Plain text of a block exactly as rendered (list items joined by \n), for offset maths. */
const textOf = (b: ArticleBlock) => blockText(b);

/** Finds where each highlight sits: its quote is split into lines and matched block by block. */
function locate(blocks: ArticleBlock[], highlights: Highlight[]): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  const texts = blocks.map(textOf);
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  for (const h of highlights) {
    const pieces = h.quote.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    let bi = Math.min(Math.max(0, h.block), blocks.length - 1);
    let from = 0;
    for (const piece of pieces) {
      let found = false;
      for (let b = bi; b < Math.min(blocks.length, bi + 4) && !found; b++) {
        const t = texts[b];
        let at = t.indexOf(piece, b === bi ? from : 0);
        if (at < 0) {
          // Selections collapse whitespace differently; retry on normalised text of equal length.
          const nt = norm(t);
          if (nt.length === t.length) at = nt.indexOf(norm(piece), b === bi ? from : 0);
        }
        if (at >= 0) {
          const list = out.get(b) ?? [];
          list.push({ start: at, end: at + piece.length, h });
          out.set(b, list);
          bi = b;
          from = at + piece.length;
          found = true;
        }
      }
    }
  }
  return out;
}

function renderSpans(spans: Span[], base: number, ranges: Range[], onMark: (h: Highlight, el: HTMLElement) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let off = base;
  spans.forEach((s, si) => {
    const len = s.text.length;
    // Cut points inside this span from highlight edges.
    const cuts = new Set<number>([0, len]);
    for (const r of ranges) {
      if (r.start > off && r.start < off + len) cuts.add(r.start - off);
      if (r.end > off && r.end < off + len) cuts.add(r.end - off);
    }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const text = s.text.slice(a, b);
      let node: ReactNode = text;
      if (s.code) node = <code>{node}</code>;
      if (s.i) node = <em>{node}</em>;
      if (s.b) node = <strong>{node}</strong>;
      if (s.href) node = <a href={s.href} target="_blank" rel="noopener noreferrer">{node}</a>;
      const hit = ranges.find((r) => r.start <= off + a && r.end >= off + b);
      const key = `${si}-${a}`;
      if (hit) {
        out.push(
          <mark key={key} className={`hl hl-${hit.h.color} ${hit.h.note ? 'has-note' : ''}`} data-hl={hit.h.id} onClick={(e) => { e.stopPropagation(); onMark(hit.h, e.currentTarget); }}>
            {node}
          </mark>,
        );
      } else out.push(<span key={key}>{node}</span>);
    }
    off += len;
  });
  return out;
}

function BlockView({ b, i, ranges, onMark, reading }: { b: ArticleBlock; i: number; ranges: Range[]; onMark: (h: Highlight, el: HTMLElement) => void; reading: boolean }) {
  const cls = reading ? 'speaking' : undefined;
  switch (b.t) {
    case 'h': {
      const Tag = (`h${b.level}` as 'h2' | 'h3' | 'h4');
      return <Tag data-block={i} className={cls}>{renderSpans([{ text: b.text }], 0, ranges, onMark)}</Tag>;
    }
    case 'p': {
      // In a thread, "2 of 7" links each post to its original and marks where one post ends.
      const mark = b.spans.length === 1 && b.spans[0].href && /^\d+ of \d+$/.test(b.spans[0].text);
      return <p data-block={i} className={[cls, mark ? 'rd-post-mark' : ''].filter(Boolean).join(' ') || undefined}>{renderSpans(b.spans, 0, ranges, onMark)}</p>;
    }
    case 'quote':
      return <blockquote data-block={i} className={cls}>{renderSpans(b.spans, 0, ranges, onMark)}</blockquote>;
    case 'ul':
    case 'ol': {
      const Tag = b.t;
      let base = 0;
      return (
        <Tag data-block={i} className={cls}>
          {b.items.map((it, j) => {
            const start = base;
            base += it.reduce((n, s) => n + s.text.length, 0) + 1;
            return <li key={j}>{renderSpans(it, start, ranges, onMark)}</li>;
          })}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre data-block={i} className={cls}>
          <code>{renderSpans([{ text: b.text }], 0, ranges, onMark)}</code>
        </pre>
      );
    case 'img':
      return <Figure b={b} i={i} />;
    case 'hr':
      return <hr data-block={i} />;
  }
}

function Figure({ b, i }: { b: Extract<ArticleBlock, { t: 'img' }>; i: number }) {
  const [broken, setBroken] = useState(false);
  if (broken || !b.src.startsWith('https://')) return b.caption ? <p data-block={i} className="rd-caption-only">{b.caption}</p> : null;
  return (
    <figure data-block={i}>
      <img src={b.src} alt={b.alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      {b.caption && <figcaption>{b.caption}</figcaption>}
    </figure>
  );
}

// ---------------------------------------------------------------- reader

type Ai = { mode: 'summary' | 'eli5' | 'ask'; text: string | null; busy: boolean; error: string | null; question?: string };

export function ArticleReader({ r, itemId, startBlock, phone }: { r: AppState; itemId: string; startBlock?: number; phone: boolean }) {
  const item: Item | undefined = useMemo(() => r.lib?.items.find((i) => i.id === itemId), [r.lib, itemId]);
  const thread = useThread(itemId);
  const [article, setArticle] = useState<Article | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ progress: number; position: number }>({ progress: 0, position: 0 });
  const [prefs, setPrefsRaw] = useState<Prefs>(loadPrefs);
  const setPrefs = (p: Partial<Prefs>) => setPrefsRaw((cur) => {
    const next = { ...cur, ...p };
    savePrefs(next);
    return next;
  });
  const [typeOpen, setTypeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [sel, setSel] = useState<{ quote: string; block: number; x: number; y: number } | null>(null);
  const [mark, setMark] = useState<{ h: Highlight; x: number; y: number } | null>(null);
  const [ai, setAi] = useState<Ai | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useDialog<HTMLDivElement>();
  const sp = useSpeaker();
  const scope = `article:${itemId}`;
  const speaking = sp.status !== 'idle' && sp.scope === scope;

  // Load (and extract on demand).
  const load = useCallback(async (force = false) => {
    setStatus('loading');
    setError(null);
    try {
      let rec: ArticleRecord = await lf.article(itemId);
      setSaved({ progress: rec.progress, position: rec.position });
      if (rec.status !== 'ok' || force) rec = await lf.extract(itemId, force);
      if (rec.article) {
        setArticle(rec.article);
        setStatus('ok');
      } else {
        setError(rec.error ?? 'Could not read this article');
        setStatus('error');
      }
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }, [itemId]);
  useEffect(() => void load(), [load]);
  const loadHighlights = useCallback(() => lf.highlights({ item: itemId }).then(setHighlights).catch(() => {}), [itemId]);
  useEffect(() => void loadHighlights(), [loadHighlights]);

  // Restore the reading position once the article is on screen.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (status !== 'ok' || restored.current || !scrollRef.current) return;
    restored.current = true;
    const target = startBlock ?? (saved.progress < 0.97 && saved.position > 2 ? saved.position : null);
    if (target === null) return;
    const el = bodyRef.current?.querySelector(`[data-block="${target}"]`) as HTMLElement | null;
    if (el) {
      scrollRef.current.scrollTop = el.offsetTop - 80;
      if (startBlock === undefined) setResumed(true);
      else el.classList.add('flash');
    }
  }, [status, saved, startBlock]);

  // Progress, header state and position memory.
  const lastSave = useRef(0);
  const posRef = useRef({ progress: 0, position: 0 });
  const persist = useCallback(() => {
    const { progress: p, position } = posRef.current;
    if (status === 'ok') void lf.reading(itemId, p, position).catch(() => {});
  }, [itemId, status]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || status !== 'ok') return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = el.scrollHeight - el.clientHeight;
        const p = max > 0 ? Math.min(1, el.scrollTop / max) : 1;
        setProgress(p);
        setScrolled(el.scrollTop > 160);
        // The first block whose bottom is below the top bar is where you are.
        let position = 0;
        const blocks = bodyRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [];
        for (const b of blocks) {
          if (b.offsetTop + b.offsetHeight > el.scrollTop + 90) {
            position = Number(b.dataset.block);
            break;
          }
        }
        posRef.current = { progress: p, position };
        if (Date.now() - lastSave.current > 1500) {
          lastSave.current = Date.now();
          persist();
        }
      });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [status, persist]);
  useEffect(() => () => persist(), [persist]);

  const close = useCallback(() => {
    persist();
    if (speaking) speaker.stop();
    closeLongform();
  }, [persist, speaking]);

  // Selection: a small toolbar above the selected text.
  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount || !bodyRef.current) return setSel(null);
      const range = s.getRangeAt(0);
      if (!bodyRef.current.contains(range.commonAncestorContainer)) return setSel(null);
      const quote = s.toString().trim();
      if (quote.length < 2) return setSel(null);
      const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) as Element | null;
      const block = Number((startEl?.closest('[data-block]') as HTMLElement | null)?.dataset.block ?? 0);
      const rect = range.getBoundingClientRect();
      setSel({ quote: quote.slice(0, 4000), block, x: rect.left + rect.width / 2, y: rect.top });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const addHighlight = useCallback(async (note?: string, color: HighlightColor = 'lamp') => {
    if (!sel) {
      r.toast('Select some text first, then press h');
      return null;
    }
    try {
      const h = await lf.addHighlight({ itemId, block: sel.block, quote: sel.quote, note, color });
      window.getSelection()?.removeAllRanges();
      setSel(null);
      setHighlights((list) => [...list, h].sort((a, b) => a.block - b.block));
      void refreshHighlights();
      return h;
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
      return null;
    }
  }, [sel, itemId, r]);

  const runAi = useCallback(async (mode: Ai['mode'], question?: string) => {
    setAi({ mode, text: null, busy: true, error: null, question });
    try {
      const res = await lf.ai(itemId, mode, question);
      setAi({ mode, text: res.text, busy: false, error: null, question });
    } catch (e) {
      setAi({ mode, text: null, busy: false, error: (e as Error).message, question });
    }
  }, [itemId]);

  const listen = useCallback(() => {
    if (!article) return;
    if (speaking) return sp.status === 'paused' ? speaker.resume() : speaker.pause();
    const from = posRef.current.position;
    const parts: ListenPart[] = [];
    if (from === 0) parts.push({ key: 'title', label: article.title, text: `${article.title}.${article.byline ? ` By ${article.byline}.` : ''}` });
    article.blocks.forEach((b, i) => {
      if (i < from || b.t === 'img' || b.t === 'hr' || b.t === 'code') return;
      const text = blockText(b);
      if (text.trim()) parts.push({ key: String(i), label: article.title, text });
    });
    speaker.play(parts, scope);
  }, [article, speaking, sp.status, scope]);

  // Follow the voice: keep the paragraph being read in view.
  useEffect(() => {
    if (!speaking || !sp.key || sp.key === 'title') return;
    const el = bodyRef.current?.querySelector(`[data-block="${sp.key}"]`) as HTMLElement | null;
    const box = scrollRef.current;
    if (!el || !box) return;
    const top = el.offsetTop - box.scrollTop;
    if (top < 80 || top > box.clientHeight * 0.7) box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.3, behavior: 'smooth' });
  }, [speaking, sp.key]);

  // Keys: j/k scroll, h highlights the selection, +/- size, l listens, o opens the original.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        if (mark) setMark(null);
        else if (typeOpen || moreOpen) { setTypeOpen(false); setMoreOpen(false); }
        else if (listOpen) setListOpen(false);
        else if (sel) { window.getSelection()?.removeAllRanges(); setSel(null); }
        else if (!typing) close();
        else t.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const box = scrollRef.current;
      let handled = true;
      switch (e.key) {
        case 'j': box?.scrollBy({ top: box.clientHeight * 0.32, behavior: 'smooth' }); break;
        case 'k': box?.scrollBy({ top: -box.clientHeight * 0.32, behavior: 'smooth' }); break;
        case 'h': void addHighlight(); break;
        case '+': case '=': setPrefs({ size: Math.min(26, prefs.size + 1) }); break;
        case '-': setPrefs({ size: Math.max(14, prefs.size - 1) }); break;
        case 'l': if (canListen) listen(); break;
        case 'o': if (article) window.open(article.url, '_blank', 'noopener,noreferrer'); break;
        case 'g': box?.scrollTo({ top: 0, behavior: 'smooth' }); break;
        case 'G': box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else e.stopImmediatePropagation(); // the feed underneath must not react
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mark, typeOpen, moreOpen, listOpen, sel, close, addHighlight, prefs.size, listen, article]);

  const ranges = useMemo(() => (article ? locate(article.blocks, highlights) : new Map<number, Range[]>()), [article, highlights]);
  const onMark = useCallback((h: Highlight, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setMark({ h, x: rect.left + rect.width / 2, y: rect.bottom });
  }, []);

  const words = article?.words ?? 0;
  const left = Math.max(0, Math.ceil((words * (1 - progress)) / 230));
  const inQueue = !!item?.state.collections.includes(READ_LATER);
  const toggleQueue = () => {
    if (!item) return;
    void r.changeState([item], { collections: inQueue ? item.state.collections.filter((c) => c !== READ_LATER) : [...item.state.collections, READ_LATER] }, inQueue ? 'removed from Read later' : 'added to Read later');
  };
  const host = (() => {
    try {
      return new URL(article?.url ?? item?.url ?? '').hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const pub = article?.publishedAt ? new Date(article.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;

  return (
    <div
      ref={dialogRef}
      className={`rd font-${prefs.font} w-${prefs.width} ${prefs.paper === 'paper' ? 'paper' : ''} ${phone ? 'phone' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={article?.title ?? 'Reader'}
      style={{ '--rd-size': `${prefs.size}px` } as React.CSSProperties}
    >
      <div className="rd-progress" aria-hidden><i style={{ transform: `scaleX(${progress})` }} /></div>
      <header className={`rd-bar ${scrolled ? 'scrolled' : ''}`}>
        <button className="icon-btn" onClick={close} aria-label="Close reader" title="Close (Esc)"><Icon name={phone ? 'back' : 'x'} /></button>
        <div className="rd-bar-title" aria-hidden={!scrolled}>
          <span className="rd-bar-site">{article?.siteName ?? host}</span>
          <span className="rd-bar-head">{article?.title ?? item?.title ?? ''}</span>
        </div>
        <div className="rd-bar-tools">
          {status === 'ok' && <span className="rd-left" title="Time left at about 230 words a minute">{progress > 0.985 ? 'Done' : `${fmtMinutes(left)} left`}</span>}
          {canListen && status === 'ok' && (
            <button className={`icon-btn ${speaking ? 'on' : ''}`} onClick={listen} aria-pressed={speaking} title={speaking ? (sp.status === 'paused' ? 'Resume' : 'Pause') : 'Listen (l)'} aria-label="Listen">
              <Icon name={speaking && sp.status === 'playing' ? 'pause' : 'play'} />
            </button>
          )}
          {canListen && status === 'ok' && item && (
            <button className="icon-btn" onClick={() => listenQueue.add(articleEntry(item))} title="Add to the listen queue" aria-label="Add to the listen queue">
              <Icon name="headphones" />
            </button>
          )}
          {status === 'ok' && (
            <button className={`icon-btn ${ai ? 'on' : ''}`} onClick={() => (ai ? setAi(null) : void runAi('summary'))} title="Summarize with AI" aria-label="Summarize with AI"><Icon name="sparkle" /></button>
          )}
          {!phone && status === 'ok' && (
            <button className={`icon-btn rd-hl-count ${listOpen ? 'on' : ''}`} onClick={() => setListOpen(!listOpen)} title="Highlights in this article" aria-label={`${highlights.length} highlights`}>
              <Icon name="star" />{highlights.length > 0 && <b>{highlights.length}</b>}
            </button>
          )}
          <div className="rd-pop-wrap">
            <button className={`icon-btn rd-aa ${typeOpen ? 'on' : ''}`} onClick={() => { setTypeOpen(!typeOpen); setMoreOpen(false); }} aria-expanded={typeOpen} title="Text settings" aria-label="Text settings">Aa</button>
            {typeOpen && (
              <div className="rd-pop rd-type" role="dialog" aria-label="Text settings">
                <div className="rd-type-row">
                  <button className={prefs.font === 'serif' ? 'on' : ''} onClick={() => setPrefs({ font: 'serif' })}><span className="rd-sample serif">Ag</span>Serif</button>
                  <button className={prefs.font === 'sans' ? 'on' : ''} onClick={() => setPrefs({ font: 'sans' })}><span className="rd-sample sans">Ag</span>Sans</button>
                </div>
                <div className="rd-type-size">
                  <button onClick={() => setPrefs({ size: Math.max(14, prefs.size - 1) })} aria-label="Smaller text">A</button>
                  <input type="range" min={14} max={26} value={prefs.size} onChange={(e) => setPrefs({ size: Number(e.target.value) })} aria-label="Text size" />
                  <button onClick={() => setPrefs({ size: Math.min(26, prefs.size + 1) })} aria-label="Larger text" className="big">A</button>
                </div>
                <div className="seg rd-seg" role="radiogroup" aria-label="Line width">
                  {(['narrow', 'medium', 'wide'] as const).map((w) => (
                    <button key={w} role="radio" aria-checked={prefs.width === w} className={prefs.width === w ? 'on' : ''} onClick={() => setPrefs({ width: w })}>{w[0].toUpperCase() + w.slice(1)}</button>
                  ))}
                </div>
                <div className="seg rd-seg" role="radiogroup" aria-label="Page">
                  <button role="radio" aria-checked={prefs.paper === 'auto'} className={prefs.paper === 'auto' ? 'on' : ''} onClick={() => setPrefs({ paper: 'auto' })}>Theme</button>
                  <button role="radio" aria-checked={prefs.paper === 'paper'} className={prefs.paper === 'paper' ? 'on' : ''} onClick={() => setPrefs({ paper: 'paper' })}>Paper</button>
                </div>
              </div>
            )}
          </div>
          <div className="rd-pop-wrap">
            <button className={`icon-btn ${moreOpen ? 'on' : ''}`} onClick={() => { setMoreOpen(!moreOpen); setTypeOpen(false); }} aria-expanded={moreOpen} aria-label="More" title="More"><Icon name="more" /></button>
            {moreOpen && (
              <div className="rd-pop rd-menu" role="menu">
                {article && <a role="menuitem" href={article.url} target="_blank" rel="noopener noreferrer" onClick={() => setMoreOpen(false)}><Icon name="external" size={16} /> Open original <kbd>o</kbd></a>}
                {item && <button role="menuitem" onClick={() => { toggleQueue(); setMoreOpen(false); }}><Icon name="inbox" size={16} /> {inQueue ? 'Remove from Read later' : 'Add to Read later'}</button>}
                {item && <button role="menuitem" onClick={() => { void r.changeState([item], { saved: !item.state.saved }, item.state.saved ? 'unsaved' : 'saved'); setMoreOpen(false); }}><Icon name={item.state.saved ? 'bookmarkFill' : 'bookmark'} size={16} /> {item.state.saved ? 'Saved' : 'Save'}</button>}
                {status === 'ok' && <button role="menuitem" onClick={() => { setMoreOpen(false); void runAi('eli5'); }}><Icon name="sparkle" size={16} /> Explain like I'm new to this</button>}
                {phone && status === 'ok' && <button role="menuitem" onClick={() => { setMoreOpen(false); setListOpen(true); }}><Icon name="star" size={16} /> Highlights ({highlights.length})</button>}
                {status === 'ok' && <button role="menuitem" onClick={() => { setMoreOpen(false); download(lf.epubUrl({ ids: [itemId] })).catch((e) => r.toast((e as Error).message, { tone: 'error' })); }}><Icon name="upload" size={16} /> Export as EPUB</button>}
                {status === 'ok' && <button role="menuitem" onClick={() => { setMoreOpen(false); restored.current = true; void load(true); }}><Icon name="sync" size={16} /> Fetch again</button>}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="rd-scroll" ref={scrollRef} onClick={() => { setTypeOpen(false); setMoreOpen(false); }}>
        {status === 'loading' && (
          <div className="rd-col rd-loading" role="status">
            <p className="rd-kicker">{host}</p>
            <h1 className="rd-title">{item?.title ?? 'Opening the article…'}</h1>
            <div className="rd-skel"><i /><i /><i /><i style={{ width: '62%' }} /></div>
            <p className="rd-meta">Fetching and tidying the article…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="rd-col rd-error">
            <p className="rd-kicker">{host}</p>
            <h1 className="rd-title">{item?.title ?? 'This page'}</h1>
            <p className="rd-error-msg">{error}</p>
            <div className="rd-error-actions">
              <button className="btn" onClick={() => void load(true)}><Icon name="sync" size={15} /> Try again</button>
              {(item?.url) && <a className="btn primary" href={item.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Open original</a>}
            </div>
          </div>
        )}
        {status === 'ok' && article && (
          <article className="rd-col">
            {resumed && (
              <div className="rd-resumed" role="status">
                Picked up where you left off.
                <button className="link-btn" onClick={() => { scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); setResumed(false); }}>Start from the top</button>
                <button className="icon-btn small" aria-label="Dismiss" onClick={() => setResumed(false)}><Icon name="x" size={14} /></button>
              </div>
            )}
            <p className="rd-kicker">{article.siteName ?? host}</p>
            <h1 className="rd-title">{article.title}</h1>
            <p className="rd-meta">
              {[article.byline, pub, `${article.minutes} min read`].filter(Boolean).join('  ·  ')}
            </p>
            {ai && (
              <section className="rd-ai" aria-live="polite">
                <div className="rd-ai-head">
                  <div className="seg rd-seg">
                    <button className={ai.mode === 'summary' ? 'on' : ''} onClick={() => void runAi('summary')}>Summary</button>
                    <button className={ai.mode === 'eli5' ? 'on' : ''} onClick={() => void runAi('eli5')}>New to this</button>
                    <button className={ai.mode === 'ask' ? 'on' : ''} onClick={() => setAi({ mode: 'ask', text: null, busy: false, error: null })}>Ask</button>
                  </div>
                  <button className="icon-btn small" onClick={() => setAi(null)} aria-label="Close AI notes"><Icon name="x" size={14} /></button>
                </div>
                {ai.mode === 'ask' && (
                  <form className="rd-ask" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get('q'); if (String(q ?? '').trim()) void runAi('ask', String(q)); }}>
                    <input name="q" defaultValue={ai.question ?? ''} placeholder="Ask about this article…" autoFocus aria-label="Question about this article" />
                    <button className="btn small primary" disabled={ai.busy}>Ask</button>
                  </form>
                )}
                {ai.busy && <div className="rd-ai-busy"><span className="spin" aria-hidden /> Reading the article…</div>}
                {ai.error && <p className="rd-ai-err">{ai.error}</p>}
                {ai.text && <div className="rich rd-ai-text"><RichText text={ai.text} /></div>}
                <p className="rd-ai-note">Written by your AI from the article text. Check the original for anything that matters.</p>
              </section>
            )}
            {article.leadImage && <figure className="rd-lead"><img src={article.leadImage} alt="" referrerPolicy="no-referrer" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).hidden = true)} /></figure>}
            <div className="rd-body" ref={bodyRef}>
              {article.blocks.map((b, i) => <BlockView key={i} b={b} i={i} ranges={ranges.get(i) ?? []} onMark={onMark} reading={speaking && sp.key === String(i)} />)}
            </div>
            <footer className="rd-end">
              <span className="rd-end-mark" aria-hidden>❦</span>
              <p>{article.words.toLocaleString()} words{highlights.length ? ` · ${highlights.length} highlight${highlights.length === 1 ? '' : 's'}` : ''}</p>
              <div className="rd-end-actions">
                <a className="btn" href={article.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Original</a>
                {item && inQueue && <button className="btn" onClick={() => { toggleQueue(); close(); }}><Icon name="check" size={15} /> Done, remove from queue</button>}
                {item && !item.state.archived && <button className="btn" onClick={() => { void r.changeState(thread ?? [item], { archived: true, read: true }, 'archived'); close(); }}><Icon name="archive" size={15} /> Archive</button>}
              </div>
              {!phone && <p className="rd-keys"><kbd>j</kbd><kbd>k</kbd> scroll · <kbd>h</kbd> highlight selection · <kbd>l</kbd> listen · <kbd>+</kbd><kbd>-</kbd> size · <kbd>Esc</kbd> close</p>}
            </footer>
          </article>
        )}
      </div>

      {sel && (
        <div className={`rd-seltools ${phone ? 'docked' : ''}`} style={phone ? undefined : { left: Math.max(90, Math.min(window.innerWidth - 90, sel.x)), top: Math.max(64, sel.y - 52) }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => void addHighlight()}><span className="dot lamp" /> Highlight <kbd>h</kbd></button>
          <button onClick={async () => { const h = await addHighlight(); if (h) setMark({ h, x: sel.x, y: sel.y + 24 }); }}><Icon name="plus" size={14} /> Note</button>
          <button onClick={() => { const q = sel.quote; window.getSelection()?.removeAllRanges(); setSel(null); void runAi('ask', `Explain this passage: "${q.slice(0, 400)}"`); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}><Icon name="sparkle" size={14} /> Explain</button>
        </div>
      )}
      {mark && <MarkPopover key={mark.h.id} mark={mark} phone={phone} close={() => setMark(null)} onChange={(h) => { setHighlights((l) => (h ? l.map((x) => (x.id === h.id ? h : x)) : l.filter((x) => x.id !== mark.h.id))); void refreshHighlights(); }} />}
      {listOpen && (
        <aside className="rd-list" aria-label="Highlights in this article">
          <div className="rd-list-head"><h2>Highlights</h2><button className="icon-btn small" onClick={() => setListOpen(false)} aria-label="Close"><Icon name="x" size={14} /></button></div>
          {highlights.length === 0 ? <p className="rd-list-empty">Select text and press <kbd>h</kbd> to keep a passage. Add a note to remember why.</p> : (
            <ul>
              {highlights.map((h) => (
                <li key={h.id}>
                  <button onClick={() => { const el = bodyRef.current?.querySelector(`[data-hl="${h.id}"]`) ?? bodyRef.current?.querySelector(`[data-block="${h.block}"]`); (el as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (phone) setListOpen(false); }}>
                    <span className={`rd-list-q hl-${h.color}`}>{h.quote}</span>
                    {h.note && <span className="rd-list-n">{h.note}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}

function MarkPopover({ mark, close, onChange, phone }: { mark: { h: Highlight; x: number; y: number }; close: () => void; onChange: (h: Highlight | null) => void; phone: boolean }) {
  const [note, setNote] = useState(mark.h.note);
  const [color, setColor] = useState<HighlightColor>(mark.h.color);
  const save = async (patch: { note?: string; color?: HighlightColor }) => {
    try {
      onChange(await lf.updateHighlight(mark.h.id, patch));
    } catch {
      /* keep the popover open */
    }
  };
  const left = Math.max(170, Math.min(window.innerWidth - 170, mark.x));
  return (
    <>
      <div className="rd-mark-scrim" onClick={() => { if (note !== mark.h.note) void save({ note }); close(); }} />
      <div className={`rd-mark ${phone ? 'docked' : ''}`} style={phone ? undefined : { left, top: Math.min(window.innerHeight - 220, mark.y + 8) }} role="dialog" aria-label="Highlight">
        <div className="rd-mark-colors" role="radiogroup" aria-label="Colour">
          {(['lamp', 'green', 'blue', 'pink'] as HighlightColor[]).map((c) => (
            <button key={c} role="radio" aria-checked={color === c} aria-label={c} className={`dot ${c} ${color === c ? 'on' : ''}`} onClick={() => { setColor(c); void save({ color: c }); }} />
          ))}
          <span className="grow" />
          <button className="icon-btn small" title="Remove highlight" aria-label="Remove highlight" onClick={async () => { await lf.deleteHighlight(mark.h.id).catch(() => {}); onChange(null); close(); }}><Icon name="trash" size={15} /></button>
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" rows={3} autoFocus={!mark.h.note} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { void save({ note }); close(); } }} />
        <div className="rd-mark-foot">
          <span>{new Date(mark.h.createdAt).toLocaleDateString()}</span>
          <button className="btn small primary" onClick={() => { void save({ note }); close(); }}>Done</button>
        </div>
      </div>
    </>
  );
}
