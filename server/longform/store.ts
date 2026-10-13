// Local storage for longform reading: extracted articles, reading positions and highlights.
// Tables are created lazily (CREATE TABLE IF NOT EXISTS) so this module does not need a schema
// migration slot of its own. Everything here is local; nothing is written to any platform.

import { randomUUID } from 'node:crypto';
import type { Article, ArticleRecord, ArticleStatus, Highlight, HighlightColor } from '../../core/longform.ts';
import type { Store } from '../db.ts';

const ready = new WeakSet<Store>();

function db(store: Store) {
  if (!ready.has(store)) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS lf_articles (
        item_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        words INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lf_reading (
        item_id TEXT PRIMARY KEY,
        progress REAL NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lf_highlights (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        block INTEGER NOT NULL DEFAULT 0,
        quote TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'lamp',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lf_highlights_item ON lf_highlights(item_id, block);
    `);
    ready.add(store);
  }
  return store.db;
}

type Row = Record<string, unknown>;

export interface ArticleMeta {
  itemId: string;
  status: ArticleStatus;
  words: number;
  error: string | null;
  attempts: number;
  progress: number;
}

export function getArticle(store: Store, itemId: string): ArticleRecord {
  const d = db(store);
  const a = d.prepare('SELECT status, data, error FROM lf_articles WHERE item_id = ?').get(itemId) as Row | undefined;
  const r = d.prepare('SELECT progress, position FROM lf_reading WHERE item_id = ?').get(itemId) as Row | undefined;
  return {
    status: (a?.status as ArticleStatus) ?? 'none',
    article: a?.data ? (JSON.parse(String(a.data)) as Article) : null,
    error: (a?.error as string) ?? null,
    progress: Number(r?.progress ?? 0),
    position: Number(r?.position ?? 0),
  };
}

export function saveArticle(store: Store, a: Article) {
  db(store)
    .prepare(
      `INSERT INTO lf_articles(item_id, url, status, data, words, error, attempts, fetched_at) VALUES(?,?,?,?,?,NULL,1,?)
       ON CONFLICT(item_id) DO UPDATE SET url = excluded.url, status = 'ok', data = excluded.data, words = excluded.words, error = NULL, attempts = attempts + 1, fetched_at = excluded.fetched_at`,
    )
    .run(a.itemId, a.url, 'ok', JSON.stringify(a), a.words, a.fetchedAt);
}

export function saveArticleError(store: Store, itemId: string, url: string, error: string) {
  db(store)
    .prepare(
      `INSERT INTO lf_articles(item_id, url, status, data, words, error, attempts, fetched_at) VALUES(?,?,'error',NULL,0,?,1,?)
       ON CONFLICT(item_id) DO UPDATE SET status = CASE WHEN data IS NULL THEN 'error' ELSE 'ok' END, error = excluded.error, attempts = attempts + 1, fetched_at = excluded.fetched_at`,
    )
    .run(itemId, url, error.slice(0, 300), new Date().toISOString());
}

/** Word counts, statuses and reading progress for every item that has any longform data. */
export function articleIndex(store: Store): Record<string, ArticleMeta> {
  const d = db(store);
  const out: Record<string, ArticleMeta> = {};
  for (const r of d.prepare('SELECT item_id, status, words, error, attempts FROM lf_articles').all() as Row[]) {
    out[String(r.item_id)] = { itemId: String(r.item_id), status: r.status as ArticleStatus, words: Number(r.words), error: (r.error as string) ?? null, attempts: Number(r.attempts), progress: 0 };
  }
  for (const r of d.prepare('SELECT item_id, progress FROM lf_reading').all() as Row[]) {
    const id = String(r.item_id);
    out[id] ??= { itemId: id, status: 'none', words: 0, error: null, attempts: 0, progress: 0 };
    out[id].progress = Number(r.progress);
  }
  return out;
}

export function saveReading(store: Store, itemId: string, progress: number, position: number) {
  db(store)
    .prepare(
      `INSERT INTO lf_reading(item_id, progress, position, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET progress = excluded.progress, position = excluded.position, updated_at = excluded.updated_at`,
    )
    .run(itemId, Math.max(0, Math.min(1, progress)), Math.max(0, Math.floor(position)), new Date().toISOString());
}

const COLORS: HighlightColor[] = ['lamp', 'green', 'blue', 'pink'];
const rowToHighlight = (r: Row): Highlight => ({
  id: String(r.id),
  itemId: String(r.item_id),
  block: Number(r.block),
  quote: String(r.quote),
  note: String(r.note ?? ''),
  color: (COLORS.includes(r.color as HighlightColor) ? r.color : 'lamp') as HighlightColor,
  createdAt: String(r.created_at),
});

export function listHighlights(store: Store, opts: { itemId?: string; query?: string; limit?: number } = {}): Highlight[] {
  const d = db(store);
  const where: string[] = [];
  const args: string[] = [];
  if (opts.itemId) {
    where.push('item_id = ?');
    args.push(opts.itemId);
  }
  const q = opts.query?.trim();
  if (q) {
    // Plain substring search over quote and note, every word must match.
    for (const w of q.split(/\s+/).slice(0, 8)) {
      where.push(`(quote LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
      const like = `%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      args.push(like, like);
    }
  }
  const sql = `SELECT * FROM lf_highlights ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${opts.itemId ? 'block, created_at' : 'created_at DESC'} LIMIT ${Math.min(5000, opts.limit ?? 2000)}`;
  return (d.prepare(sql).all(...args) as Row[]).map(rowToHighlight);
}

export function getHighlight(store: Store, id: string): Highlight | null {
  const r = db(store).prepare('SELECT * FROM lf_highlights WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToHighlight(r) : null;
}

export function addHighlight(store: Store, h: { itemId: string; block: number; quote: string; note?: string; color?: string }): Highlight {
  const color = COLORS.includes(h.color as HighlightColor) ? (h.color as HighlightColor) : 'lamp';
  const row = {
    id: randomUUID().slice(0, 12),
    item_id: h.itemId,
    block: Math.max(0, Math.floor(h.block)),
    quote: h.quote.trim().slice(0, 4000),
    note: (h.note ?? '').trim().slice(0, 4000),
    color,
    created_at: new Date().toISOString(),
  };
  db(store).prepare('INSERT INTO lf_highlights(id, item_id, block, quote, note, color, created_at) VALUES(?,?,?,?,?,?,?)').run(row.id, row.item_id, row.block, row.quote, row.note, row.color, row.created_at);
  return rowToHighlight(row);
}

export function updateHighlight(store: Store, id: string, patch: { note?: string; color?: string }): Highlight | null {
  const cur = getHighlight(store, id);
  if (!cur) return null;
  const note = patch.note !== undefined ? String(patch.note).trim().slice(0, 4000) : cur.note;
  const color = patch.color && COLORS.includes(patch.color as HighlightColor) ? patch.color : cur.color;
  db(store).prepare('UPDATE lf_highlights SET note = ?, color = ? WHERE id = ?').run(note, color, id);
  return { ...cur, note, color: color as HighlightColor };
}

export function deleteHighlight(store: Store, id: string) {
  db(store).prepare('DELETE FROM lf_highlights WHERE id = ?').run(id);
}
