// Read-it-later exports: Pocket (HTML and CSV), Instapaper CSV, Omnivore JSON and Readwise
// Reader CSV. Files are picked by the user and parsed as untrusted data: only http(s) URLs are
// kept, titles become plain text and nothing is fetched while importing. Unread entries go to
// the "Read later" collection; archived ones arrive already read.

import { decodeEntities, safeHttpUrl } from '../../core/normalize.ts';
import type { ItemDraft } from '../connectors/types.ts';

export interface LongformImport {
  label: string;
  format: 'pocket' | 'instapaper' | 'omnivore' | 'readwise';
  entries: { draft: ItemDraft; archived: boolean; tags: string[] }[];
  errors: string[];
}

const MAX_ENTRIES = 20_000;

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const plain = (s: unknown, max = 500) => decodeEntities(String(s ?? '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function draft(format: LongformImport['format'], fileName: string, url: string, title: string, text: string, at: string | null, author?: string): ItemDraft {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* checked by caller */
  }
  return {
    platform: 'web',
    externalId: url.slice(0, 500),
    url,
    author: { name: author || host || 'Web' },
    title: title || url,
    text,
    links: [],
    media: [],
    quoted: null,
    lang: null,
    kind: 'article',
    publishedAt: at ?? new Date().toISOString(),
    provenance: { connector: `${format}-import`, connectorVersion: 1, via: 'import', fileName },
    metrics: null,
  } as ItemDraft;
}

function tagsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => plain(typeof t === 'object' && t ? (t as any).name : t, 60)).filter(Boolean).slice(0, 10);
  return String(v ?? '')
    .split(/[|,;]/)
    .map((t) => plain(t, 60))
    .filter(Boolean)
    .slice(0, 10);
}

function fromCsv(fileName: string, text: string): LongformImport | null {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iUrl = col('url');
  if (iUrl < 0) return null;
  let format: LongformImport['format'];
  if (head.includes('selection') && head.includes('folder')) format = 'instapaper';
  else if (head.includes('time_added') || (head.includes('status') && head.includes('tags'))) format = 'pocket';
  else if (head.includes('location') || head.includes('document tags') || head.includes('saved date')) format = 'readwise';
  else format = 'pocket';
  const iTitle = col('title');
  const iAt = col('time_added', 'timestamp', 'saved date', 'saved_at', 'date');
  const iTags = col('tags', 'document tags');
  const iSel = col('selection', 'summary', 'description');
  const iStatus = col('status', 'folder', 'location');
  const iAuthor = col('author');
  const out: LongformImport = { label: '', format, entries: [], errors: [] };
  for (const [n, r] of rows.slice(1).entries()) {
    if (out.entries.length >= MAX_ENTRIES) {
      out.errors.push(`Only the first ${MAX_ENTRIES} entries were imported`);
      break;
    }
    const url = safeHttpUrl((r[iUrl] ?? '').trim());
    if (!url) {
      if (out.errors.length < 50) out.errors.push(`Row ${n + 2}: no usable http(s) link`);
      continue;
    }
    const status = (r[iStatus] ?? '').trim().toLowerCase();
    const tags = iTags >= 0 ? tagsOf(r[iTags]) : [];
    if (format === 'instapaper' && status && !['unread', 'archive', 'starred'].includes(status)) tags.push(plain(r[iStatus], 60));
    out.entries.push({
      draft: draft(format, fileName, url, plain(r[iTitle]), iSel >= 0 ? plain(r[iSel], 2000) : '', iAt >= 0 ? toIso(r[iAt]) : null, iAuthor >= 0 ? plain(r[iAuthor], 120) : undefined),
      archived: status === 'archive' || status === 'archived' || status === 'read',
      tags,
    });
  }
  return out;
}

function fromPocketHtml(fileName: string, text: string): LongformImport | null {
  if (!/<a\s[^>]*href=/i.test(text)) return null;
  const out: LongformImport = { label: '', format: 'pocket', entries: [], errors: [] };
  // Pocket's HTML export has an "Unread" list followed by a "Read Archive" list.
  const archiveAt = text.search(/<h1>\s*Read Archive\s*<\/h1>/i);
  for (const m of text.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (out.entries.length >= MAX_ENTRIES) break;
    const attrs = m[1];
    const get = (name: string) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
      return r ? decodeEntities(r[1] ?? r[2] ?? '') : '';
    };
    const url = safeHttpUrl(get('href'));
    if (!url) continue;
    out.entries.push({
      draft: draft('pocket', fileName, url, plain(m[2]), '', toIso(get('time_added') || get('add_date'))),
      archived: archiveAt >= 0 && (m.index ?? 0) > archiveAt,
      tags: tagsOf(get('tags')),
    });
  }
  return out.entries.length ? out : null;
}

function fromJson(fileName: string, text: string): LongformImport | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : Array.isArray((data as any)?.items) ? (data as any).items : Array.isArray((data as any)?.list) ? (data as any).list : Object.values((data as any)?.list ?? {});
  if (!Array.isArray(rows) || !rows.length) return null;
  const out: LongformImport = { label: '', format: 'omnivore', entries: [], errors: [] };
  for (const [n, r] of rows.entries()) {
    if (out.entries.length >= MAX_ENTRIES) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, any>;
    const url = safeHttpUrl(o.url ?? o.originalUrl ?? o.resolved_url ?? o.given_url ?? o.link);
    if (!url) {
      if (out.errors.length < 50) out.errors.push(`Entry ${n + 1}: no usable http(s) link`);
      continue;
    }
    const state = String(o.state ?? o.status ?? '').toLowerCase();
    out.entries.push({
      draft: draft('omnivore', fileName, url, plain(o.title ?? o.resolved_title ?? o.given_title), plain(o.description ?? o.excerpt ?? '', 2000), toIso(o.savedAt ?? o.time_added ?? o.createdAt ?? o.publishedAt), plain(o.author, 120) || undefined),
      archived: state === 'archived' || state === '1' || o.isArchived === true,
      tags: tagsOf(o.labels ?? o.tags),
    });
  }
  return out.entries.length ? out : null;
}

const LABELS: Record<LongformImport['format'], string> = { pocket: 'Pocket', instapaper: 'Instapaper', omnivore: 'Omnivore', readwise: 'Readwise Reader' };

export function parseLongformImport(fileName: string, text: string): LongformImport {
  if (!text.trim()) throw new Error('The file is empty');
  const head = text.trimStart().slice(0, 200);
  const lower = fileName.toLowerCase();
  let r: LongformImport | null = null;
  if (head.startsWith('[') || head.startsWith('{') || lower.endsWith('.json')) r = fromJson(fileName, text);
  else if (/^<!doctype|^<html|^<ul|^<title|^<h1/i.test(head) || lower.endsWith('.html') || lower.endsWith('.htm')) r = fromPocketHtml(fileName, text);
  else r = fromCsv(fileName, text);
  if (!r || !r.entries.length) throw new Error('No saved articles found. Use a Pocket export (CSV or HTML), an Instapaper CSV, an Omnivore JSON export or a Readwise Reader CSV.');
  r.label = `${LABELS[r.format]} import`;
  return r;
}
