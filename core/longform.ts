// Longform articles in a safe structured form. The extractor turns a web page into these
// blocks on the server; the reader renders them as React elements. No HTML string from a page
// ever reaches the UI: text is text, links are http(s) only and images are https only.

export interface Span {
  text: string;
  href?: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
}

export type ArticleBlock =
  | { t: 'h'; level: 2 | 3 | 4; text: string }
  | { t: 'p'; spans: Span[] }
  | { t: 'ul' | 'ol'; items: Span[][] }
  | { t: 'quote'; spans: Span[] }
  | { t: 'code'; text: string; lang?: string }
  | { t: 'img'; src: string; alt?: string; caption?: string }
  | { t: 'hr' };

export interface Article {
  itemId: string;
  url: string;
  title: string;
  byline: string | null;
  siteName: string | null;
  publishedAt: string | null;
  leadImage: string | null;
  excerpt: string;
  blocks: ArticleBlock[];
  words: number;
  minutes: number;
  fetchedAt: string;
}

export type ArticleStatus = 'none' | 'queued' | 'ok' | 'error';

export interface ArticleRecord {
  status: ArticleStatus;
  article: Article | null;
  error: string | null;
  /** Reading position memory: 0..1 through the article, and the block index at the top. */
  progress: number;
  position: number;
}

export type HighlightColor = 'lamp' | 'green' | 'blue' | 'pink';

export interface Highlight {
  id: string;
  itemId: string;
  /** Index of the block the highlight starts in, so the reader can scroll to it. */
  block: number;
  quote: string;
  note: string;
  color: HighlightColor;
  createdAt: string;
  /** Filled in by the list endpoint for display. */
  title?: string;
  url?: string;
}

export const WORDS_PER_MINUTE = 230;

export function spansText(spans: Span[]): string {
  return spans.map((s) => s.text).join('');
}

export function blockText(b: ArticleBlock): string {
  switch (b.t) {
    case 'h':
    case 'code':
      return b.text;
    case 'p':
    case 'quote':
      return spansText(b.spans);
    case 'ul':
    case 'ol':
      return b.items.map(spansText).join('\n');
    case 'img':
      return b.caption ?? '';
    default:
      return '';
  }
}

export function articleText(blocks: ArticleBlock[]): string {
  return blocks.map(blockText).filter(Boolean).join('\n\n');
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export const readMinutes = (words: number) => Math.max(1, Math.round(words / WORDS_PER_MINUTE));
