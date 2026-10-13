// Search snippets: plain text with the matched ranges lit. The text is split at the ranges and the
// pieces drawn as nested Text, so nothing from a post is ever parsed as markup.
import type { Item } from '../../core/types.ts';
import type { Snippet } from '../../core/search.ts';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { font, usePalette } from './theme';

/** Cuts text into plain and matched pieces. Ranges may overlap or arrive unsorted. */
export function splitRanges(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const sorted = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b, text.length))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of sorted) {
    const from = Math.max(a, at);
    if (b <= from) continue;
    if (from > at) out.push({ text: text.slice(at, from), hit: false });
    out.push({ text: text.slice(from, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export function Highlighted({ snippet, style, lines }: { snippet: Snippet; style?: StyleProp<TextStyle>; lines?: number }) {
  const p = usePalette();
  return (
    <Text style={[{ color: p.ink2, fontFamily: font.regular, fontSize: 15, lineHeight: 21 }, style]} numberOfLines={lines}>
      {splitRanges(snippet.text, snippet.ranges).map((piece, i) =>
        piece.hit ? (
          <Text key={i} style={{ color: p.ink, fontFamily: font.semibold, backgroundColor: `${p.lamp}2e` }}>{piece.text}</Text>
        ) : (
          piece.text
        ),
      )}
    </Text>
  );
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/**
 * Offline search over the posts the phone saved: every word of the query must appear (in the
 * text, title or author). Newest first, since there is no index to rank with.
 */
export function searchLocal(items: Item[], query: string, limit = 40): { id: string; snippet: Snippet }[] {
  const words = (query.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 1);
  if (!words.length) return [];
  const out: { id: string; snippet: Snippet }[] = [];
  for (const it of items) {
    const text = `${it.title ? `${it.title}. ` : ''}${it.text}`.replace(/\s+/g, ' ').trim();
    const low = text.toLowerCase();
    const who = `${it.author.name} ${it.author.handle ?? ''}`.toLowerCase();
    if (!words.every((w) => low.includes(w) || who.includes(w))) continue;
    out.push({ id: it.id, snippet: snippetAround(text, low, words) });
    if (out.length >= limit) break;
  }
  return out;
}

function snippetAround(text: string, low: string, words: string[]): Snippet {
  const hits = words.map((w) => low.indexOf(w)).filter((i) => i >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = first > 60 ? text.lastIndexOf(' ', first - 50) + 1 : 0;
  const end = Math.min(text.length, start + 220);
  const lead = start > 0 ? '…' : '';
  const body = text.slice(start, end);
  const lowBody = body.toLowerCase();
  const ranges: [number, number][] = [];
  for (const w of words) {
    for (let i = lowBody.indexOf(w); i >= 0; i = lowBody.indexOf(w, i + w.length)) ranges.push([i + lead.length, i + lead.length + w.length]);
  }
  return { text: `${lead}${body}${end < text.length ? '…' : ''}`, ranges };
}
