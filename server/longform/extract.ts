// Full-article extraction for the reader. The page is fetched through safeFetch (public
// addresses only, size and time caps), Mozilla Readability finds the main content in a linkedom
// DOM, and a small walker turns that content into safe blocks (core/longform.ts). Nothing from
// the page runs: no scripts, no styles, no raw HTML is kept. Links stay http(s) only and images
// https only, both resolved against the final page URL.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { countWords, readMinutes, articleText, type Article, type ArticleBlock, type Span } from '../../core/longform.ts';
import type { SafeFetch } from '../connectors/types.ts';

const MAX_PAGE_BYTES = 4_000_000;
const MAX_BLOCKS = 3000;
const MAX_BLOCK_TEXT = 20_000;

export class ExtractError extends Error {}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'HR', 'TABLE', 'IMG', 'PICTURE', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'DL', 'DETAILS', 'CENTER']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE', 'NAV']);

function httpUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function httpsImage(raw: string | null | undefined, base: string): string | null {
  const u = httpUrl(raw, base);
  if (!u) return null;
  // Upgrade plain http images; a page's own images almost always serve over https too.
  return u.startsWith('http://') ? 'https://' + u.slice(7) : u;
}

function pickSrc(img: Element, base: string): string | null {
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  let best: string | null = null;
  if (srcset) {
    // Take the largest width candidate, capped so phones don't pull 4000px originals.
    let bestW = 0;
    for (const part of srcset.split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d?.endsWith('w') ? parseInt(d) : d?.endsWith('x') ? parseFloat(d) * 800 : 800;
      if (u && w > bestW && w <= 2000) {
        bestW = w;
        best = u;
      }
    }
  }
  const src = img.getAttribute('src');
  const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-original');
  const chosen = (src && !src.startsWith('data:') ? src : null) ?? dataSrc ?? best;
  return httpsImage(chosen && !chosen.startsWith('data:') ? chosen : best, base);
}

interface Fmt {
  href?: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
}

class Walker {
  blocks: ArticleBlock[] = [];
  private spans: Span[] = [];
  private base: string;
  constructor(base: string) {
    this.base = base;
  }

  private pushSpan(text: string, f: Fmt) {
    if (!text) return;
    const last = this.spans[this.spans.length - 1];
    if (last && last.href === f.href && !!last.b === !!f.b && !!last.i === !!f.i && !!last.code === !!f.code) {
      last.text += text;
      return;
    }
    const s: Span = { text };
    if (f.href) s.href = f.href;
    if (f.b) s.b = true;
    if (f.i) s.i = true;
    if (f.code) s.code = true;
    this.spans.push(s);
  }

  private takeSpans(): Span[] {
    const spans = this.spans;
    this.spans = [];
    return tidySpans(spans);
  }

  private push(b: ArticleBlock) {
    if (this.blocks.length < MAX_BLOCKS) this.blocks.push(b);
  }

  flush() {
    const spans = this.takeSpans();
    if (spans.length) this.push({ t: 'p', spans });
  }

  /** Collect inline content of a node into the current span buffer. Images inside break out. */
  inline(node: Node, f: Fmt) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const raw = child.textContent ?? '';
        this.pushSpan(f.code ? raw : raw.replace(/\s+/g, ' '), f);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'BR') this.pushSpan('\n', f);
      else if (tag === 'IMG' || tag === 'PICTURE' || tag === 'FIGURE') {
        this.flush();
        this.block(el);
      } else if (tag === 'A') {
        const href = httpUrl(el.getAttribute('href'), this.base) ?? undefined;
        this.inline(el, { ...f, href: href ?? f.href });
      } else if (tag === 'STRONG' || tag === 'B') this.inline(el, { ...f, b: true });
      else if (tag === 'EM' || tag === 'I' || tag === 'CITE') this.inline(el, { ...f, i: true });
      else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') this.inline(el, { ...f, code: true });
      else if (BLOCK_TAGS.has(tag) || tag === 'LI') {
        // Block content inside inline context (a <div> in a <p>, common in newsletters).
        this.flush();
        this.block(el);
      } else this.inline(el, f);
    }
  }

  private listItems(list: Element): Span[][] {
    const items: Span[][] = [];
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      const saved = this.spans;
      this.spans = [];
      const nested: Element[] = [];
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === 1 && ((c as Element).tagName === 'UL' || (c as Element).tagName === 'OL')) nested.push(c as Element);
        else if (c.nodeType === 1 && (c as Element).tagName === 'P') {
          if (this.spans.length) this.pushSpan(' ', {});
          this.inline(c, {});
        } else {
          const wrap = { childNodes: [c] } as unknown as Node;
          this.inline(wrap, {});
        }
      }
      const spans = tidySpans(this.spans);
      this.spans = saved;
      if (spans.length) items.push(spans);
      for (const n of nested) for (const sub of this.listItems(n)) items.push([{ text: '– ' }, ...sub]);
    }
    return items;
  }

  private image(img: Element, caption?: string) {
    const src = pickSrc(img, this.base);
    if (!src) return;
    const w = Number(img.getAttribute('width'));
    const h = Number(img.getAttribute('height'));
    if ((w && w < 24) || (h && h < 24)) return; // tracking pixels and icons
    const alt = (img.getAttribute('alt') ?? '').trim().slice(0, 500) || undefined;
    this.push({ t: 'img', src, alt, caption: caption?.slice(0, 1000) || undefined });
  }

  block(el: Element) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        this.flush();
        const text = clean(el.textContent ?? '');
        if (text) this.push({ t: 'h', level: tag === 'H1' || tag === 'H2' ? 2 : tag === 'H3' ? 3 : 4, text: text.slice(0, 300) });
        return;
      }
      case 'P':
        this.flush();
        this.inline(el, {});
        this.flush();
        return;
      case 'UL':
      case 'OL': {
        this.flush();
        const items = this.listItems(el);
        if (items.length) this.push({ t: tag === 'UL' ? 'ul' : 'ol', items });
        return;
      }
      case 'BLOCKQUOTE': {
        this.flush();
        // Quotes keep paragraph breaks as blank lines inside one quote block.
        const parts: Span[][] = [];
        for (const c of Array.from(el.childNodes)) {
          if (c.nodeType === 1 && BLOCK_TAGS.has((c as Element).tagName) && (c as Element).tagName !== 'P') {
            if (this.spans.length) parts.push(this.takeSpans());
            this.pushSpan(clean((c as Element).textContent ?? ''), {});
            parts.push(this.takeSpans());
            continue;
          }
          if (c.nodeType === 1 && (c as Element).tagName === 'P') {
            if (this.spans.length) parts.push(this.takeSpans());
            this.inline(c, {});
            parts.push(this.takeSpans());
          } else this.inline({ childNodes: [c] } as unknown as Node, {});
        }
        if (this.spans.length) parts.push(this.takeSpans());
        const spans: Span[] = [];
        for (const p of parts.filter((p) => p.length)) {
          if (spans.length) spans.push({ text: '\n\n' });
          spans.push(...p);
        }
        if (spans.length) this.push({ t: 'quote', spans });
        return;
      }
      case 'PRE': {
        this.flush();
        const codeEl = el.querySelector('code');
        const cls = `${el.getAttribute('class') ?? ''} ${codeEl?.getAttribute('class') ?? ''}`;
        const lang = /(?:language|lang)-([\w+#.-]{1,20})/.exec(cls)?.[1];
        const text = (el.textContent ?? '').replace(/\s+$/, '').slice(0, MAX_BLOCK_TEXT);
        if (text.trim()) this.push(lang ? { t: 'code', text, lang } : { t: 'code', text });
        return;
      }
      case 'FIGURE': {
        this.flush();
        const img = el.querySelector('img');
        const cap = clean(el.querySelector('figcaption')?.textContent ?? '');
        if (img) this.image(img, cap);
        else if (el.querySelector('pre')) this.block(el.querySelector('pre')!);
        else if (el.querySelector('blockquote')) this.block(el.querySelector('blockquote')!);
        else if (cap) this.push({ t: 'p', spans: [{ text: cap, i: true }] });
        return;
      }
      case 'PICTURE': {
        this.flush();
        const img = el.querySelector('img');
        if (img) this.image(img);
        return;
      }
      case 'IMG':
        this.flush();
        this.image(el);
        return;
      case 'HR':
        this.flush();
        if (this.blocks.length && this.blocks[this.blocks.length - 1].t !== 'hr') this.push({ t: 'hr' });
        return;
      case 'TABLE': {
        this.flush();
        // Tables become one line per row; enough to read, nothing to lay out.
        for (const tr of Array.from(el.querySelectorAll('tr')).slice(0, 200)) {
          const cells = Array.from(tr.children).map((c) => clean(c.textContent ?? '')).filter(Boolean);
          if (cells.length) this.push({ t: 'p', spans: [{ text: cells.join('  ·  ') }] });
        }
        return;
      }
      case 'DL': {
        this.flush();
        for (const c of Array.from(el.children)) {
          const text = clean(c.textContent ?? '');
          if (!text) continue;
          this.push({ t: 'p', spans: [c.tagName === 'DT' ? { text, b: true } : { text }] });
        }
        return;
      }
      default:
        // Containers: walk children, gathering loose inline content into paragraphs.
        for (const c of Array.from(el.childNodes)) {
          if (c.nodeType === 1 && (BLOCK_TAGS.has((c as Element).tagName) || (c as Element).tagName === 'LI')) {
            this.flush();
            this.block(c as Element);
          } else this.inline({ childNodes: [c] } as unknown as Node, {});
        }
        this.flush();
    }
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function tidySpans(spans: Span[]): Span[] {
  const out = spans.filter((s) => s.text);
  // Trim whitespace at the edges and around hard line breaks.
  while (out.length && !out[0].text.trim()) out.shift();
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  if (!out.length) return [];
  out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, '') };
  const l = out.length - 1;
  out[l] = { ...out[l], text: out[l].text.replace(/\s+$/, '') };
  let total = 0;
  const capped: Span[] = [];
  for (const s of out) {
    if (total >= MAX_BLOCK_TEXT) break;
    const text = s.text.replace(/ *\n */g, '\n').slice(0, MAX_BLOCK_TEXT - total);
    total += text.length;
    capped.push({ ...s, text });
  }
  return capped;
}

function meta(doc: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
}

/** Turns an HTML page into an article. Exported for tests and for imports that already have HTML. */
export function extractFromHtml(html: string, pageUrl: string, itemId: string): Article {
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  const leadImage = httpsImage(meta(doc, 'og:image', 'twitter:image', 'twitter:image:src'), pageUrl);
  const ogTitle = meta(doc, 'og:title', 'twitter:title');
  const published = meta(doc, 'article:published_time', 'og:published_time', 'date', 'pubdate');
  const siteName = meta(doc, 'og:site_name', 'application-name');
  const author = meta(doc, 'author', 'article:author', 'twitter:creator');
  const parsed = new Readability(doc, { charThreshold: 300, keepClasses: true }).parse();
  if (!parsed?.content) throw new ExtractError('Could not find an article on that page');

  const { document: clean2 } = parseHTML(`<!doctype html><html><body><div id="aurora-root">${parsed.content}</div></body></html>`);
  const root = (clean2 as unknown as Document).getElementById('aurora-root');
  if (!root) throw new ExtractError('Could not read the article');
  const w = new Walker(pageUrl);
  w.block(root);
  w.flush();
  let blocks = w.blocks;
  const title = clean(parsed.title || ogTitle || '') || new URL(pageUrl).hostname;
  // Readability often keeps the title as the first heading; the reader shows it already.
  if (blocks[0]?.t === 'h' && clean(blocks[0].text).toLowerCase() === title.toLowerCase()) blocks = blocks.slice(1);
  // Drop the lead image from the body when it repeats as the first picture.
  const text = articleText(blocks);
  const words = countWords(text);
  if (words < 40) throw new ExtractError('That page has too little text to read here');
  const pub = parsed.publishedTime || published;
  return {
    itemId,
    url: pageUrl,
    title: title.slice(0, 300),
    byline: clean(parsed.byline || author || '').slice(0, 200) || null,
    siteName: clean(parsed.siteName || siteName || '').slice(0, 120) || null,
    publishedAt: pub && Number.isFinite(Date.parse(pub)) ? new Date(pub).toISOString() : null,
    leadImage: blocks.some((b) => b.t === 'img') ? null : leadImage,
    excerpt: clean(parsed.excerpt || text.slice(0, 300)).slice(0, 400),
    blocks,
    words,
    minutes: readMinutes(words),
    fetchedAt: new Date().toISOString(),
  };
}

export async function extractArticle(url: string, itemId: string, fetcher: SafeFetch): Promise<Article> {
  const res = await fetcher(url, {
    timeoutMs: 20_000,
    maxBytes: MAX_PAGE_BYTES,
    headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
  });
  if (res.status === 401 || res.status === 403) throw new ExtractError(`The site refused the request (${res.status}). It may need a sign-in; open the original instead.`);
  if (res.status === 402 || res.status === 451) throw new ExtractError(`The site does not allow reading this here (${res.status})`);
  if (res.status >= 400) throw new ExtractError(`The site answered ${res.status}`);
  const type = res.headers['content-type'] ?? '';
  if (type && !/html|xml/i.test(type)) throw new ExtractError(`That link is not a web page (${type.split(';')[0]})`);
  return extractFromHtml(res.text, res.url || url, itemId);
}
