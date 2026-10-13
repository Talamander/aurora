// Full-text search in the web app: ranked "Best matches" above the feed while you search, and a
// "More like this" sheet for one post. Both come from the server's FTS5 index (server/search.ts).
// Snippets are third-party text: they arrive as plain text with match ranges and are rendered by
// splitting the string, never as HTML.

import { Fragment, useEffect, useState } from 'react';
import type { Item } from '../../core/types.ts';
import { api } from './api.ts';
import type { RelatedHit, SearchHit, SearchResult, Snippet } from '../../core/search.ts';
import { Icon } from './icons.tsx';
import { agoText, platformLabel } from './format.ts';
import type { ItemIndex } from './itemIndex.ts';
import { useDialog } from './useDialog.ts';

/** Ranked results for a query, debounced. null while there is nothing to show. */
export function useFullText(query: string, opts: { limit?: number; delay?: number; profile?: string | null } = {}): SearchResult | null {
  const [res, setRes] = useState<SearchResult | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) {
      setRes(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .search(q, opts.limit ?? 8, opts.profile ?? undefined)
        .then((r) => live && setRes(r))
        .catch(() => live && setRes(null));
    }, opts.delay ?? 140);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, opts.limit, opts.delay, opts.profile]);
  return res;
}

/** A snippet with its matches marked, as text. */
export function Snip({ s, max = 260 }: { s: Snippet; max?: number }) {
  const text = s.text.length > max ? s.text.slice(0, max) + '…' : s.text;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of s.ranges) {
    if (a >= text.length) break;
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={a}>{text.slice(a, Math.min(b, text.length))}</mark>);
    at = Math.min(b, text.length);
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

function MiniAvatar({ it }: { it: Item }) {
  const [broken, setBroken] = useState(false);
  if (it.author.avatar && !broken) return <img className="bm-av" src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  const parts = it.author.name.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  return <span className="bm-av initials" aria-hidden>{((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()}</span>;
}

function Row({ it, children, onOpen, label }: { it: Item; children: React.ReactNode; onOpen: () => void; label: string }) {
  return (
    <li>
      <button className="bm-row" onClick={onOpen}>
        <MiniAvatar it={it} />
        <span className="bm-main">
          <span className="bm-who">
            <b>{it.author.name}</b> <span className="bm-meta">{label} · {agoText(it.publishedAt)}</span>
          </span>
          {it.title && <span className="bm-title">{it.title}</span>}
          <span className="bm-snip">{children}</span>
        </span>
        <span className="bm-go" aria-hidden><Icon name="back" size={15} /></span>
      </button>
    </li>
  );
}

/**
 * Best matches above the feed while searching: up to five posts ranked by relevance, including
 * matches the word filter cannot see (word starts, article bodies, highlight notes).
 */
export function BestMatches({ query, byId, visible, sourceLabels, profile, openPost }: {
  query: string; byId: ItemIndex; visible: ReadonlySet<string>; sourceLabels: Record<string, string>; profile?: string | null; openPost: (it: Item) => void;
}) {
  const res = useFullText(query, { limit: 12, profile });
  const [open, setOpen] = useState(true);
  if (!res || res.unsupported) return null;
  const hits = res.results.map((h) => ({ h, it: byId.get(h.id) })).filter((x): x is { h: SearchHit; it: Item } => !!x.it && !x.it.state.archived);
  if (!hits.length) {
    if (!res.index.building) return null;
    return <p className="bm-building">Building the search index · {pct(res.index)}</p>;
  }
  const shown = hits.slice(0, open ? 5 : 0);
  const extra = hits.filter((x) => !visible.has(x.h.id)).length;
  return (
    <section className="best-matches" aria-label="Best matches">
      <header className="bm-head">
        <span className="bm-kick"><Icon name="sparkle" size={14} /> Best matches</span>
        <span className="bm-count">
          {res.matched >= 300 ? '300+' : res.matched} ranked{extra > 0 ? ` · ${extra} the feed filter misses` : ''}
          {res.index.building ? ` · indexing ${pct(res.index)}` : ''}
        </span>
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
      </header>
      {open && (
        <ol className="bm-list">
          {shown.map(({ h, it }) => (
            <Row key={h.id} it={it} onOpen={() => openPost(it)} label={it.isDemo ? `Demo ${platformLabel(it.platform)}` : sourceLabels[it.sourceId] ?? platformLabel(it.platform)}>
              <Snip s={h.snippet} />
            </Row>
          ))}
        </ol>
      )}
    </section>
  );
}

const pct = (s: { indexed: number; total: number }) => `${Math.min(100, Math.round((s.indexed / Math.max(1, s.total)) * 100))}%`;

/** "More like this": posts sharing this one's rarest words, same author and topics boosted. */
export function RelatedSheet({ id, byId, sourceLabels, profile, close, openPost }: {
  id: string; byId: ItemIndex; sourceLabels: Record<string, string>; profile?: string | null; close: () => void; openPost: (it: Item) => void;
}) {
  const dlg = useDialog<HTMLDivElement>();
  const [hits, setHits] = useState<RelatedHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const it = byId.get(id);
  useEffect(() => {
    let live = true;
    setHits(null);
    api
      .related(id, 12, profile ?? undefined)
      .then((r) => live && setHits(r.results))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [id, profile]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const rows = (hits ?? []).map((h) => ({ h, it: byId.get(h.id) })).filter((x): x is { h: RelatedHit; it: Item } => !!x.it);
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet related-sheet" role="dialog" aria-modal="true" aria-label="More like this" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>More like this</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          {it && (
            <p className="rel-of">
              Like <b>{it.author.name}</b>: {(it.title ?? it.text).replace(/\s+/g, ' ').slice(0, 120)}
              {(it.title ?? it.text).length > 120 ? '…' : ''}
            </p>
          )}
          {err ? (
            <p className="rel-empty">Could not look: {err}</p>
          ) : !hits ? (
            <p className="rel-empty">Looking through your library…</p>
          ) : !rows.length ? (
            <p className="rel-empty">Nothing else in your library shares enough with this post yet.</p>
          ) : (
            <ol className="bm-list">
              {rows.map(({ h, it: other }) => (
                <Row key={h.id} it={other} onOpen={() => { close(); openPost(other); }} label={other.isDemo ? `Demo ${platformLabel(other.platform)}` : sourceLabels[other.sourceId] ?? platformLabel(other.platform)}>
                  {(other.text || other.title || '').replace(/\s+/g, ' ').slice(0, 200)}
                  <span className="rel-why">
                    {h.sameAuthor && <span className="rel-tag">same author</span>}
                    {h.topics.map((t) => <span key={t} className="rel-tag">#{t.toLowerCase().replace(/\s+/g, '')}</span>)}
                    {h.shared.map((w) => <span key={w} className="rel-word">{w}</span>)}
                  </span>
                </Row>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/** Ask the app to open "More like this" for a post, from anywhere. */
export function openRelated(id: string) {
  window.dispatchEvent(new CustomEvent('aurora:related', { detail: id }));
}
