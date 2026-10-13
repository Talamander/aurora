// Longform surfaces outside the reader: the read-later queue, the highlights library, and the
// host that mounts whichever one is open. The reader itself loads lazily (fonts and all).

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Highlight } from '../../core/longform.ts';
import { Icon } from './icons.tsx';
import { closeLongform, download, fmtMinutes, lf, openReader, READ_LATER, refreshHighlights, useHighlight, useLongformView, type QueueEntry } from './longform.ts';
import { canListen } from './Listen.tsx';
import { fromQueueEntry, listen } from './listenQueue.ts';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import './longform.css';

const ArticleReader = lazy(() => import('./Reader.tsx').then((m) => ({ default: m.ArticleReader })));

export function LongformHost({ r, phone, ask }: { r: Reader; phone: boolean; ask: (text: string, send?: boolean) => void }) {
  const view = useLongformView();
  // Article and highlight events from the server refresh the shared highlight cache.
  useEffect(() => r.subscribe((e) => {
    if (e.type === 'ui' && e.action.kind === 'longform' && e.action.what === 'highlights') void refreshHighlights();
  }), [r]);
  if (!view) return null;
  if (view.kind === 'reader') {
    return (
      <Suspense fallback={<div className="rd rd-fallback" role="status" aria-label="Opening the reader" />}>
        <ArticleReader key={view.itemId} r={r} itemId={view.itemId} startBlock={view.block} phone={phone} />
      </Suspense>
    );
  }
  if (view.kind === 'queue') return <ReadLaterSheet r={r} />;
  return <HighlightsSheet r={r} ask={ask} />;
}

// ---------------------------------------------------------------- read later

type Sort = 'short' | 'long' | 'new' | 'old';
type Fit = 'all' | 'quick' | 'mid' | 'long';

function ReadLaterSheet({ r }: { r: Reader }) {
  const ref = useDialog<HTMLDivElement>();
  const [data, setData] = useState<{ queue: QueueEntry[]; suggestions: QueueEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('aurora.queue.sort') as Sort) || 'new');
  const [fit, setFit] = useState<Fit>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => lf.queue().then(setData, (e) => setError((e as Error).message)), []);
  useEffect(() => void load(), [load]);
  useEffect(() => r.subscribe((e) => {
    if (e.type === 'library' || (e.type === 'ui' && e.action.kind === 'longform')) void load();
  }), [r, load]);
  useEffect(() => {
    try {
      localStorage.setItem('aurora.queue.sort', sort);
    } catch {
      /* ignore */
    }
  }, [sort]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        closeLongform();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const list = useMemo(() => {
    const q = [...(data?.queue ?? [])].filter((e) => (fit === 'all' ? true : fit === 'quick' ? e.minutes < 10 : fit === 'mid' ? e.minutes >= 10 && e.minutes <= 30 : e.minutes > 30));
    const cmp: Record<Sort, (a: QueueEntry, b: QueueEntry) => number> = {
      short: (a, b) => a.words - b.words,
      long: (a, b) => b.words - a.words,
      new: (a, b) => b.addedAt.localeCompare(a.addedAt),
      old: (a, b) => a.addedAt.localeCompare(b.addedAt),
    };
    return q.sort(cmp[sort]);
  }, [data, sort, fit]);
  const total = list.reduce((n, e) => n + Math.max(1, Math.round(e.minutes * (1 - e.progress))), 0);
  const byId = useMemo(() => new Map((r.lib?.items ?? []).map((i) => [i.id, i])), [r.lib]);
  const setQueued = async (e: QueueEntry, on: boolean) => {
    const it = byId.get(e.id);
    if (!it) return;
    await r.changeState([it], { collections: on ? [...new Set([...it.state.collections, READ_LATER])] : it.state.collections.filter((c) => c !== READ_LATER) }, on ? 'added to Read later' : 'removed from Read later');
    void load();
  };

  const subscribe = async () => {
    if (!url.trim()) return;
    setBusy('subscribe');
    try {
      const res = await lf.subscribe(url.trim());
      r.toast(`Following ${res.source?.label ?? res.feed}. Full articles will be ready to read soon.`);
      setUrl('');
      void r.reload();
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const importFile = async (file: File) => {
    setBusy('import');
    try {
      const text = await file.text();
      const res = await lf.importFile(file.name, text);
      r.toast(`Imported ${res.added + res.updated} articles from ${res.format}: ${res.queued} in Read later${res.archived ? `, ${res.archived} already read` : ''}${res.errors.length ? ` (${res.errors.length} skipped)` : ''}`);
      void r.reload();
      void load();
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="sheet-backdrop" onClick={closeLongform}>
      <div ref={ref} className="sheet lf-sheet" role="dialog" aria-modal="true" aria-label="Read later" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Read later</h2>
          <button className={`icon-btn ${addOpen ? 'on' : ''}`} onClick={() => setAddOpen(!addOpen)} aria-expanded={addOpen} aria-label="Add articles" title="Follow a newsletter or import"><Icon name="plus" /></button>
          <button className="icon-btn" onClick={closeLongform} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          {addOpen && (
            <section className="lf-add">
              <form onSubmit={(e) => { e.preventDefault(); void subscribe(); }}>
                <label className="lf-label" htmlFor="lf-sub">Follow a newsletter or blog</label>
                <div className="lf-row">
                  <input id="lf-sub" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="name.substack.com, a Ghost or Medium blog, any site" />
                  <button className="btn small primary" disabled={!url.trim() || busy === 'subscribe'}>{busy === 'subscribe' ? 'Adding…' : 'Follow'}</button>
                </div>
                <p className="lf-hint">Substack, Ghost, Medium, Buttondown, beehiiv and most blogs work. New posts arrive in full and open here.</p>
              </form>
              <div className="lf-import">
                <span className="lf-label">Bring your queue</span>
                <button className="btn small" disabled={busy === 'import'} onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} /> {busy === 'import' ? 'Importing…' : 'Import a file'}</button>
                <input ref={fileRef} type="file" accept=".csv,.html,.htm,.json,text/csv,text/html,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
                <p className="lf-hint">Pocket (CSV or HTML), Instapaper CSV, Omnivore JSON or Readwise Reader CSV. Nothing is fetched until you read.</p>
              </div>
            </section>
          )}

          <div className="lf-summary">
            <div>
              <strong>{list.length}</strong> {list.length === 1 ? 'article' : 'articles'}
              <span className="lf-total"> · {fmtMinutes(total)} to read</span>
            </div>
            {canListen && list.some((e) => !e.read) && (
              <button className="btn small ghost lf-listen-all" onClick={() => { closeLongform(); listen.playAll(list.filter((e) => !e.read).map(fromQueueEntry)); }} title="Read the unread articles aloud, in this order">
                <Icon name="headphones" size={14} /> Listen
              </button>
            )}
            {data && data.queue.length > 0 && (
              <button className="btn small ghost" onClick={() => { setBusy('epub'); download(lf.epubUrl({ collection: READ_LATER })).catch((e) => r.toast((e as Error).message, { tone: 'error' })).finally(() => setBusy(null)); }} disabled={busy === 'epub'}>
                <Icon name="upload" size={14} /> {busy === 'epub' ? 'Building…' : 'EPUB'}
              </button>
            )}
          </div>
          <div className="lf-controls">
            <div className="seg" role="radiogroup" aria-label="Sort">
              {([['new', 'Newest'], ['old', 'Oldest'], ['short', 'Shortest'], ['long', 'Longest']] as [Sort, string][]).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>
              ))}
            </div>
            <div className="lf-fits" role="radiogroup" aria-label="Length">
              {([['all', 'Any length'], ['quick', 'Under 10 min'], ['mid', '10–30 min'], ['long', 'Long reads']] as [Fit, string][]).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={fit === k} className={`chip ${fit === k ? 'on' : ''}`} onClick={() => setFit(k)}>{l}</button>
              ))}
            </div>
          </div>

          {error && <p className="lf-error">{error}</p>}
          {!data && !error && <p className="lf-empty">Loading…</p>}
          {data && data.queue.length === 0 && (
            <div className="lf-emptybox">
              <Icon name="inbox" size={28} />
              <p className="lf-empty-title">Nothing saved for later yet.</p>
              <p>Add a long post from its menu or from the reader, follow a newsletter, or import from Pocket, Instapaper or Omnivore with <strong>+</strong>.</p>
            </div>
          )}
          <ul className="lf-list">
            {list.map((e) => <QueueRow key={e.id} e={e} onOpen={() => openReader(e.id)} onToggle={(on) => void setQueued(e, on)} />)}
          </ul>

          {data && data.suggestions.length > 0 && (
            <>
              <h3 className="lf-sub">Long reads in your feed</h3>
              <ul className="lf-list sugg">
                {data.suggestions.slice(0, 12).map((e) => <QueueRow key={e.id} e={e} onOpen={() => openReader(e.id)} onToggle={(on) => void setQueued(e, on)} />)}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueRow({ e, onOpen, onToggle }: { e: QueueEntry; onOpen: () => void; onToggle: (on: boolean) => void }) {
  const host = (() => {
    try {
      return new URL(e.url).hostname.replace(/^www\./, '');
    } catch {
      return e.source;
    }
  })();
  const [img, setImg] = useState(!!e.image);
  return (
    <li className={`lf-item ${e.read ? 'read' : ''}`}>
      <button className="lf-open" onClick={onOpen}>
        <span className="lf-text">
          <span className="lf-host">{host}</span>
          <span className="lf-title">{e.title}</span>
          <span className="lf-meta">
            {e.exact ? '' : '≈'}{fmtMinutes(e.minutes)}
            {e.progress > 0.02 && e.progress < 0.97 && <> · {fmtMinutes(Math.max(1, Math.round(e.minutes * (1 - e.progress))))} left</>}
            {e.progress >= 0.97 && <> · finished</>}
            {e.author && e.author !== host && <> · {e.author}</>}
          </span>
          {e.progress > 0.02 && <span className="lf-prog" aria-hidden><i style={{ width: `${Math.round(e.progress * 100)}%` }} /></span>}
        </span>
        {img && e.image && <img className="lf-thumb" src={e.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImg(false)} />}
      </button>
      <button className={`icon-btn small lf-toggle ${e.inQueue ? 'on' : ''}`} onClick={() => onToggle(!e.inQueue)} aria-label={e.inQueue ? 'Remove from Read later' : 'Add to Read later'} title={e.inQueue ? 'Done, remove from the queue' : 'Add to Read later'}>
        <Icon name={e.inQueue ? 'check' : 'plus'} size={16} />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- highlights

function HighlightsSheet({ r, ask }: { r: Reader; ask: (text: string, send?: boolean) => void }) {
  const ref = useDialog<HTMLDivElement>();
  const [q, setQ] = useState('');
  const [list, setList] = useState<Highlight[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => void lf.highlights({ q }).then(setList).catch(() => setList([])), q ? 160 : 0);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        closeLongform();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; url: string; items: Highlight[] }>();
    for (const h of list ?? []) {
      const g = m.get(h.itemId) ?? { title: h.title ?? 'Article', url: h.url ?? '', items: [] };
      g.items.push(h);
      m.set(h.itemId, g);
    }
    return [...m.entries()];
  }, [list]);
  const exportMd = () => {
    const md = groups.map(([, g]) => `## ${g.title}\n${g.url}\n\n${g.items.map((h) => `> ${h.quote.replace(/\n+/g, '\n> ')}${h.note ? `\n\n${h.note}` : ''}`).join('\n\n')}`).join('\n\n---\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`# Highlights\n\n${md}\n`], { type: 'text/markdown' }));
    a.download = 'aurora-highlights.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const mark = (text: string) => {
    const words = q.trim().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return text;
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? <b key={i} className="lf-q">{part}</b> : part));
  };
  return (
    <div className="sheet-backdrop" onClick={closeLongform}>
      <div ref={ref} className="sheet lf-sheet" role="dialog" aria-modal="true" aria-label="Highlights" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Highlights</h2>
          {!!list?.length && <button className="icon-btn" onClick={exportMd} aria-label="Export highlights as Markdown" title="Export as Markdown"><Icon name="upload" /></button>}
          <button className="icon-btn" onClick={closeLongform} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <label className="search lf-search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search passages and notes" aria-label="Search highlights" autoFocus />
          </label>
          {list && list.length > 0 && !q && (
            <button className="btn small ghost lf-ask" onClick={() => { closeLongform(); ask('Look through my highlights (search_highlights) and tell me what threads connect them. Cite them as [[highlight:ID]].'); }}>
              <Icon name="sparkle" size={14} /> What connects my highlights?
            </button>
          )}
          {list === null && <p className="lf-empty">Loading…</p>}
          {list?.length === 0 && (
            <div className="lf-emptybox">
              <Icon name="star" size={28} />
              <p className="lf-empty-title">{q ? 'No highlights match.' : 'No highlights yet.'}</p>
              {!q && <p>Open an article in the reader, select a passage and press <kbd>h</kbd>. Notes are optional and searchable.</p>}
            </div>
          )}
          {groups.map(([itemId, g]) => (
            <section key={itemId} className="lf-hgroup">
              <button className="lf-htitle" onClick={() => openReader(itemId)}>{g.title}</button>
              {g.items.map((h) => (
                <div key={h.id} className={`lf-h hl-bar-${h.color}`}>
                  <button className="lf-hq" onClick={() => openReader(itemId, h.block)}>{mark(h.quote)}</button>
                  {h.note && <p className="lf-hn">{mark(h.note)}</p>}
                  <div className="lf-hmeta">
                    <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                    <button className="link-btn" onClick={async () => { await lf.deleteHighlight(h.id).catch(() => {}); setList((l) => (l ?? []).filter((x) => x.id !== h.id)); void refreshHighlights(); r.toast('Highlight removed'); }}>Remove</button>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A quote chip for [[highlight:ID]] citations in AI text. Opens the article at the passage. */
export function HighlightCite({ id }: { id: string }) {
  const h = useHighlight(id);
  if (h === undefined) return <span className="hl-cite loading">…</span>;
  if (!h) return null;
  return (
    <button className={`hl-cite hl-bar-${h.color}`} onClick={() => openReader(h.itemId, h.block)} title={h.title ? `From “${h.title}”` : 'Open the article'}>
      <Icon name="star" size={12} /> “{h.quote.length > 90 ? `${h.quote.slice(0, 88)}…` : h.quote}”
    </button>
  );
}
