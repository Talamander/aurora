// A small EPUB 3 writer for reading Aurora articles on an e-reader. Text only: remote images are
// left out (e-readers cannot fetch them, and we do not embed third-party files), captions stay.
// Every string is XML-escaped; no HTML from a page is copied in.

import { deflateRawSync, crc32 } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import type { Article, ArticleBlock, Highlight, Span } from '../../core/longform.ts';

// ---------------------------------------------------------------- zip

interface Entry {
  name: string;
  data: Buffer;
  store: boolean;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.store ? e.data : deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(e.store ? 0 : 8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------------------------------------------------------------- xhtml

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(XML_BAD, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function spans(list: Span[]): string {
  return list
    .map((s) => {
      let h = esc(s.text).replace(/\n/g, '<br/>');
      if (s.code) h = `<code>${h}</code>`;
      if (s.i) h = `<em>${h}</em>`;
      if (s.b) h = `<strong>${h}</strong>`;
      if (s.href && /^https?:\/\//.test(s.href)) h = `<a href="${esc(s.href)}">${h}</a>`;
      return h;
    })
    .join('');
}

function block(b: ArticleBlock): string {
  switch (b.t) {
    case 'h':
      return `<h${b.level + 1}>${esc(b.text)}</h${b.level + 1}>`;
    case 'p':
      return `<p>${spans(b.spans)}</p>`;
    case 'ul':
    case 'ol':
      return `<${b.t}>${b.items.map((i) => `<li>${spans(i)}</li>`).join('')}</${b.t}>`;
    case 'quote':
      return `<blockquote><p>${spans(b.spans)}</p></blockquote>`;
    case 'code':
      return `<pre><code>${esc(b.text)}</code></pre>`;
    case 'img':
      return b.caption || b.alt ? `<p class="fig">[Image${b.caption ? `: ${esc(b.caption)}` : b.alt ? `: ${esc(b.alt.slice(0, 200))}` : ''}]</p>` : '';
    case 'hr':
      return '<hr/>';
  }
}

const CSS = `body{font-family:serif;line-height:1.55;margin:0 4%}h1{font-size:1.6em;line-height:1.2;margin:.2em 0}
.meta{color:#666;font-size:.9em;margin-bottom:1.6em}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #999;font-style:italic}
pre{white-space:pre-wrap;font-size:.85em;background:#f3f3f3;padding:.6em}code{font-family:monospace}.fig{color:#666;font-size:.9em;font-style:italic}
.hl{margin:1em 0;padding:.4em .8em;border-left:3px solid #c90}.hl p{margin:.2em 0}.note{color:#555;font-size:.9em}`;

function chapter(a: Article, highlights: Highlight[]): string {
  const meta = [a.byline, a.siteName, a.publishedAt ? a.publishedAt.slice(0, 10) : null, `${a.minutes} min read`].filter(Boolean).map(esc).join(' · ');
  const hl = highlights.length
    ? `<hr/><h2>Your highlights</h2>${highlights.map((h) => `<div class="hl"><p>${esc(h.quote)}</p>${h.note ? `<p class="note">${esc(h.note)}</p>` : ''}</div>`).join('')}`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>${esc(a.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><h1>${esc(a.title)}</h1><p class="meta">${meta}<br/><a href="${esc(a.url)}">${esc(a.url)}</a></p>
${a.blocks.map(block).join('\n')}
${hl}
</body></html>`;
}

export function buildEpub(title: string, articles: { article: Article; highlights: Highlight[] }[]): Buffer {
  const id = `urn:uuid:${randomUUID()}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = articles.map((x, i) => ({ name: `ch${String(i + 1).padStart(3, '0')}.xhtml`, ...x }));
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>en</dc:language>
<dc:creator>Aurora</dc:creator><meta property="dcterms:modified">${now}</meta>
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>
${files.map((f, i) => `<item id="c${i}" href="${f.name}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>${files.map((_f, i) => `<itemref idref="c${i}"/>`).join('')}</spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>${esc(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>${esc(title)}</h1><ol>
${files.map((f) => `<li><a href="${f.name}">${esc(f.article.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const b = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: 'mimetype', data: b('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: b(container), store: false },
    { name: 'OEBPS/content.opf', data: b(opf), store: false },
    { name: 'OEBPS/nav.xhtml', data: b(nav), store: false },
    { name: 'OEBPS/style.css', data: b(CSS), store: false },
    ...files.map((f) => ({ name: `OEBPS/${f.name}`, data: b(chapter(f.article, f.highlights)), store: false })),
  ]);
}
