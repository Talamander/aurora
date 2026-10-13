// Small, safe text rendering for AI-written text: paragraphs, **bold**, `code`, "- " lists,
// https links, [[post:ID]] citations and [[highlight:ID]] quote chips. Everything becomes React text nodes; no HTML is parsed.

import type { ReactNode } from 'react';
import type { Item } from '../../core/types.ts';
import { HighlightCite } from './Longform.tsx';

const CITE = /\[\[(?:post:)?([^\]\s]+)\]\]/g;

export function citedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITE)].map((m) => m[1]).filter((id) => !id.startsWith('highlight:')))];
}

function inline(text: string, cite: (id: string) => ReactNode, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[\[(?:post:)?([^\]\s]+)\]\]|\*\*([^*]+)\*\*|`([^`]+)`|(https:\/\/[^\s)<>\]]+)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]?.startsWith('highlight:')) out.push(<HighlightCite key={k} id={m[1].slice(10)} />);
    else if (m[1]) out.push(<span key={k}>{cite(m[1])}</span>);
    else if (m[2]) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4]) {
      const url = m[4].replace(/[.,;:]+$/, '');
      out.push(<a key={k} href={url} target="_blank" rel="noopener noreferrer">{url.replace(/^https:\/\/(www\.)?/, '').slice(0, 48)}</a>);
      if (url.length < m[4].length) out.push(m[4].slice(url.length));
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, cite }: { text: string; cite?: (id: string, n: number) => ReactNode }) {
  const order: string[] = [];
  const citeFn = (id: string) => {
    let i = order.indexOf(id);
    if (i < 0) i = order.push(id) - 1;
    return cite ? cite(id, i + 1) : null;
  };
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''), citeFn, `${i}-${j}`)}</li>)}
            </ul>
          );
        }
        const h = /^#{1,4}\s+(.*)$/.exec(lines[0]);
        if (h && lines.length === 1) return <h4 key={i}>{inline(h[1], citeFn, `${i}`)}</h4>;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,4}\s+/, ''), citeFn, `${i}-${j}`)}</span>
            ))}
          </p>
        );
      })}
    </>
  );
}

/** A small card for a post the AI cited. */
export function PostMini({ it, n, onOpen }: { it: Item | undefined; n?: number; onOpen?: (it: Item) => void }) {
  if (!it) return null;
  const img = it.media.find((m) => m.type === 'image' || m.thumb);
  return (
    <button className="post-mini" onClick={() => onOpen?.(it)} title="Show this post in the feed">
      {n !== undefined && <span className="cite-n">{n}</span>}
      {it.author.avatar ? <img className="pm-av" src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="pm-av blank" />}
      <span className="pm-body">
        <span className="pm-who">{it.author.name}</span>
        <span className="pm-text">{(it.title ?? it.text).replace(/\s+/g, ' ').slice(0, 140)}</span>
      </span>
      {img && <img className="pm-img" src={img.thumb ?? img.url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </button>
  );
}
