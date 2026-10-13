// Full-text search over the library with SQLite FTS5: ranked "best matches" with snippets, and
// "more like this" for one post.
//
// The index lives in its own file, data/search.db, next to the library. It is a cache: deleting
// it is safe and it is rebuilt in the background on the next start. Keeping it out of the main
// database keeps backups small and leaves the library's schema alone.
//
// Sync is incremental and cheap. The store hands out the same Item object for a post until that
// post changes, so a pass over the item list compares identities first and only re-reads posts
// that changed. Each indexed row carries a signature of what was indexed (text, article fetch
// time, highlights), so a restart re-indexes only what changed while the server was down.
//
// Everything indexed is third-party text. Snippets come back as plain text plus match ranges;
// the UI renders them as text and never as HTML.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseQuery } from '../core/filter.ts';
import { matchTopics, itemHaystack } from '../core/classify.ts';
import { blockText, type ArticleBlock } from '../core/longform.ts';
import type { Item, Topic } from '../core/types.ts';
import type { Store } from './db.ts';

import type { IndexStatus, RelatedHit, SearchHit, SearchResult, Snippet } from '../core/search.ts';
export type { IndexStatus, RelatedHit, SearchHit, SearchResult, Snippet };

// Column order matters: bm25() weights and snippet() column numbers follow it.
const COLS = ['title', 'body', 'author', 'article', 'notes'] as const;
const WEIGHTS = [4, 1, 2.5, 0.6, 2];
const MAX_ARTICLE = 60_000;
const START = '\u0002';
const END = '\u0003';
const ELLIPSIS = '…';
const CANDIDATES = 300;

const STOP = new Set(
  'the a an and or but if then of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me my your our their his her them us not no yes do does did done have has had just so than too very can will would should could about into over after before again more most some such only own same other also there here what which who whom when where why how all any both each few new now one two out up down off via per via amp http https www com org net html rt de la le el en et les des das der die und que'.split(
    ' ',
  ),
);

/** Strip the snippet markers and other control characters from third-party text before indexing. */
const clean = (s: string | null | undefined) => (s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');

/** Words as the index sees them (unicode61 with diacritics removed), for "more like this". */
export function words(s: string): string[] {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** A quoted FTS5 string. Double quotes inside are doubled; FTS5 tokenizes the inside. */
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * The library's search syntax as an FTS5 MATCH expression: words (all must match, prefix
 * matched), "exact phrases", -excluded words or phrases, from:author. site: is not indexed and is
 * applied afterwards. Returns null when nothing positive is left to search for.
 */
export function toMatch(query: string): { match: string; site: string[] } | null {
  const p = parseQuery(query);
  const pos: string[] = [];
  for (const t of p.terms) if (words(t).length) pos.push(`${q(t)}*`);
  for (const ph of p.phrases) if (words(ph).length) pos.push(q(ph));
  const from = p.from.filter((f) => words(f).length).map((f) => `author : ${q(f)}*`);
  if (from.length) pos.push(from.length > 1 ? `(${from.join(' OR ')})` : from[0]);
  if (!pos.length) return null;
  let match = pos.join(' AND ');
  const neg = p.negated.filter((n) => words(n).length).map(q);
  if (neg.length) match = `(${match}) NOT (${neg.join(' OR ')})`;
  return { match, site: p.site };
}

/** Turns a snippet with marker characters into plain text and ranges, with whitespace collapsed. */
export function parseSnippet(raw: string): Snippet {
  let text = '';
  const ranges: [number, number][] = [];
  let open = -1;
  let space = true; // drops leading whitespace
  for (const ch of raw) {
    if (ch === START) open = text.length;
    else if (ch === END) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length]);
      open = -1;
    } else if (/\s/.test(ch)) {
      if (!space) text += ' ';
      space = true;
    } else {
      text += ch;
      space = false;
    }
  }
  const trimmed = text.trimEnd();
  return { text: trimmed, ranges: ranges.map(([x, y]) => [x, Math.min(y, trimmed.length)] as [number, number]).filter(([x, y]) => y > x) };
}

function articleText(data: unknown): string {
  try {
    const a = JSON.parse(String(data)) as { blocks?: ArticleBlock[] };
    let s = '';
    for (const b of a.blocks ?? []) {
      s += blockText(b) + '\n';
      if (s.length > MAX_ARTICLE) break;
    }
    return s.slice(0, MAX_ARTICLE);
  } catch {
    return '';
  }
}

interface Doc {
  title: string;
  body: string;
  author: string;
  article: string;
  notes: string;
}

export function createSearch(deps: { store: Store; dataDir?: string; path?: string; topics?: () => Topic[]; log?: (m: string) => void }) {
  const { store } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const path = deps.path ?? join(deps.dataDir ?? '.', 'search.db');
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600); // it holds the text of your library
  } catch {
    /* best effort */
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS docs (rowid INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE, sig TEXT NOT NULL, published TEXT NOT NULL DEFAULT '');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(${COLS.join(', ')}, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(fts, 'row');
  `);

  const st = {
    getDoc: db.prepare('SELECT rowid, sig FROM docs WHERE item_id = ?'),
    allDocs: db.prepare('SELECT rowid, item_id, sig FROM docs'),
    insDoc: db.prepare('INSERT INTO docs(item_id, sig, published) VALUES(?, ?, ?)'),
    updDoc: db.prepare('UPDATE docs SET sig = ?, published = ? WHERE rowid = ?'),
    delDoc: db.prepare('DELETE FROM docs WHERE rowid = ?'),
    insFts: db.prepare(`INSERT INTO fts(rowid, ${COLS.join(', ')}) VALUES(?, ?, ?, ?, ?, ?)`),
    delFts: db.prepare('DELETE FROM fts WHERE rowid = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM docs'),
    vocab: db.prepare('SELECT doc FROM vocab WHERE term = ?'),
    idOf: db.prepare('SELECT item_id FROM docs WHERE rowid = ?'),
  };

  // Item objects already indexed in this process, by id. Same object means nothing changed.
  const seen = new Map<string, Item>();
  // Signatures on disk, loaded once for the first pass after start.
  let diskSigs: Map<string, { rowid: number; sig: string }> | null = null;
  let extrasKey = '';
  let extras: { articles: Map<string, { at: string; data: unknown }>; notes: Map<string, string> } = { articles: new Map(), notes: new Map() };
  let building = false;
  let lastSync = 0;
  let total = 0;
  let indexed = (st.count.get() as { n: number }).n;

  /** Articles and highlights live in the longform tables, which may not exist yet. */
  function loadExtras(force = false) {
    const t = Date.now();
    if (!force && t - lastExtras < 1500) return false;
    lastExtras = t;
    const articles = new Map<string, { at: string; data: unknown }>();
    const notes = new Map<string, string>();
    try {
      for (const r of store.db.prepare("SELECT item_id, fetched_at, data FROM lf_articles WHERE status = 'ok'").all() as Record<string, unknown>[]) {
        articles.set(String(r.item_id), { at: String(r.fetched_at), data: r.data });
      }
    } catch {
      /* no longform table yet */
    }
    try {
      for (const r of store.db.prepare('SELECT item_id, quote, note FROM lf_highlights ORDER BY created_at').all() as Record<string, unknown>[]) {
        const id = String(r.item_id);
        notes.set(id, `${notes.get(id) ?? ''}${String(r.quote)} ${String(r.note ?? '')}\n`);
      }
    } catch {
      /* no highlights table yet */
    }
    let key = '';
    for (const [id, a] of articles) key += id + a.at;
    for (const [id, n] of notes) key += id + n.length;
    const k = createHash('sha1').update(key).digest('base64url');
    const changed = k !== extrasKey;
    extrasKey = k;
    extras = { articles, notes };
    return changed;
  }
  let lastExtras = 0;

  function docOf(it: Item): { doc: Doc; sig: string } {
    const art = extras.articles.get(it.id);
    const doc: Doc = {
      title: clean(it.title),
      body: clean([it.text, it.quoted?.text ?? '', it.links.join(' ')].join('\n')),
      author: clean(`${it.author.name} ${it.author.handle ?? ''}`),
      article: art ? clean(articleText(art.data)) : '',
      notes: clean(extras.notes.get(it.id) ?? ''),
    };
    const sig = createHash('sha1')
      .update(doc.title)
      .update('\0')
      .update(doc.body)
      .update('\0')
      .update(doc.author)
      .update('\0')
      .update(art?.at ?? '')
      .update('\0')
      .update(doc.notes)
      .digest('base64url')
      .slice(0, 16);
    return { doc, sig };
  }

  function write(it: Item, existing: { rowid: number; sig: string } | undefined, built: { doc: Doc; sig: string }) {
    const { doc, sig } = built;
    if (existing && existing.sig === sig) return;
    let rowid: number;
    if (existing) {
      st.delFts.run(existing.rowid);
      st.updDoc.run(sig, it.publishedAt, existing.rowid);
      rowid = existing.rowid;
    } else {
      rowid = Number(st.insDoc.run(it.id, sig, it.publishedAt).lastInsertRowid);
    }
    st.insFts.run(rowid, doc.title, doc.body, doc.author, doc.article, doc.notes);
  }

  /** Brings the index up to date with the library. Incremental; returns how many rows changed. */
  function syncNow(): number {
    const items = store.listItems();
    total = items.length;
    const extrasChanged = loadExtras();
    let changed = 0;
    const live = new Set<string>();
    db.exec('BEGIN');
    try {
      for (const it of items) {
        live.add(it.id);
        if (!extrasChanged && seen.get(it.id) === it) continue;
        const prev = seen.get(it.id);
        // A state change (read, saved) makes a new object with the same text; skip those quickly.
        if (!extrasChanged && prev && prev.text === it.text && prev.title === it.title && prev.author.name === it.author.name) {
          seen.set(it.id, it);
          continue;
        }
        const built = docOf(it);
        const existing = diskSigs ? diskSigs.get(it.id) : (st.getDoc.get(it.id) as { rowid: number; sig: string } | undefined);
        if (!existing || existing.sig !== built.sig) {
          write(it, existing, built);
          changed++;
        }
        seen.set(it.id, it);
      }
      for (const id of [...seen.keys()]) {
        if (live.has(id)) continue;
        seen.delete(id);
        const d = st.getDoc.get(id) as { rowid: number } | undefined;
        if (d) {
          st.delFts.run(d.rowid);
          st.delDoc.run(d.rowid);
          changed++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (changed) indexed = (st.count.get() as { n: number }).n;
    lastSync = Date.now();
    return changed;
  }

  /**
   * The first pass after start, in slices so the server stays responsive. Compares each post
   * with the signature on disk and drops rows for posts that no longer exist.
   */
  async function build(): Promise<void> {
    if (building) return;
    building = true;
    const t0 = Date.now();
    try {
      diskSigs = new Map();
      for (const r of st.allDocs.all() as { rowid: number; item_id: string; sig: string }[]) diskSigs.set(r.item_id, { rowid: r.rowid, sig: r.sig });
      loadExtras(true);
      const items = store.listItems();
      total = items.length;
      let changed = 0;
      for (let i = 0; i < items.length; ) {
        const end = performance.now() + 15;
        db.exec('BEGIN');
        try {
          while (i < items.length && performance.now() < end) {
            for (const stop = Math.min(items.length, i + 50); i < stop; i++) {
              const it = items[i];
              const built = docOf(it);
              const existing = diskSigs.get(it.id);
              if (!existing || existing.sig !== built.sig) {
                write(it, existing, built);
                changed++;
              }
              diskSigs.delete(it.id);
              seen.set(it.id, it);
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        indexed = Math.min(total, (st.count.get() as { n: number }).n);
        await new Promise((r) => setTimeout(r, 8));
      }
      // Whatever is left on disk belongs to posts that are gone.
      db.exec('BEGIN');
      for (const { rowid } of diskSigs.values()) {
        st.delFts.run(rowid);
        st.delDoc.run(rowid);
      }
      db.exec('COMMIT');
      diskSigs = null;
      indexed = (st.count.get() as { n: number }).n;
      if (changed > 200) {
        // Merge the index's segments a little at a time ('optimize' does it all at once and holds
        // the event loop for a few hundred ms). A merge that writes almost nothing is the last one.
        const total = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
        for (let round = 0; round < 400; round++) {
          const before = total();
          db.exec("INSERT INTO fts(fts, rank) VALUES('merge', -128)");
          if (total() - before < 2) break;
          await new Promise((r) => setTimeout(r, 8));
        }
        log(`[search] indexed ${changed} posts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
      syncNow(); // catch anything that changed while building
    } catch (e) {
      log(`[search] index build failed: ${(e as Error).message}`);
      diskSigs = null;
    } finally {
      building = false;
    }
  }

  /** Before a query: sync unless the build is still running (then search what is there). */
  function fresh() {
    if (building) return;
    try {
      syncNow();
    } catch (e) {
      log(`[search] sync failed: ${(e as Error).message}`);
    }
  }

  const status = (): IndexStatus => ({ indexed, total: total || store.listItems().length, building });

  /** Recency nudges ties: a post from today counts up to 25% more than a two-year-old one. */
  function recency(published: string): number {
    const age = (Date.now() - Date.parse(published)) / 86_400_000;
    return Number.isFinite(age) ? 1 + 0.25 * Math.exp(-Math.max(0, age) / 45) : 1;
  }

  function search(query: string, opts: { limit?: number; ids?: ReadonlySet<string> | null } = {}): SearchResult {
    const t0 = performance.now();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    const parsed = toMatch(query.slice(0, 500));
    if (!parsed) return { query, results: [], matched: 0, ms: 0, index: status(), unsupported: query.trim() ? 'Add a word to search for; exclusions alone are not searchable.' : undefined };
    fresh();
    let rows: { rowid: number; item_id: string; published: string; r: number; s: string }[];
    try {
      rows = db
        .prepare(
          `SELECT f.rowid, d.item_id, d.published, bm25(fts, ${WEIGHTS.join(', ')}) AS r, snippet(fts, -1, char(2), char(3), '${ELLIPSIS}', 24) AS s
           FROM fts f JOIN docs d ON d.rowid = f.rowid
           WHERE fts MATCH ? ORDER BY r LIMIT ${opts.ids || parsed.site.length ? CANDIDATES * 4 : CANDIDATES}`,
        )
        .all(parsed.match) as typeof rows;
    } catch (e) {
      return { query, results: [], matched: 0, ms: performance.now() - t0, index: status(), unsupported: `That search could not be read: ${(e as Error).message}` };
    }
    let out = rows;
    if (opts.ids) out = out.filter((r) => opts.ids!.has(r.item_id));
    if (parsed.site.length) {
      const byId = new Map<string, Item>();
      out = out.filter((r) => {
        const it = byId.get(r.item_id) ?? store.getItem(r.item_id);
        if (!it) return false;
        const hay = `${it.url} ${it.links.join(' ')}`.toLowerCase();
        return parsed.site.some((s) => hay.includes(s));
      });
    }
    const results = out
      .map((r) => ({ id: r.item_id, score: -r.r * recency(r.published), snippet: parseSnippet(r.s) }))
      .sort((a, b) => b.score - a.score);
    return { query, results: results.slice(0, limit), matched: results.length, ms: Math.round((performance.now() - t0) * 10) / 10, index: status() };
  }

  /** Posts like this one: its rarest shared words, then a boost for the same author and topics. */
  function related(id: string, opts: { limit?: number; ids?: ReadonlySet<string> | null } = {}): RelatedHit[] {
    const it = store.getItem(id);
    if (!it) return [];
    fresh();
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    const n = Math.max(1, indexed);
    const art = extras.articles.get(id);
    const text = `${it.title ?? ''} ${it.title ?? ''} ${it.text} ${it.quoted?.text ?? ''} ${art ? articleText(art.data).slice(0, 8000) : ''}`;
    const tf = new Map<string, number>();
    for (const w of words(text)) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      tf.set(w, (tf.get(w) ?? 0) + 1);
    }
    const scored: { w: string; s: number; common: boolean }[] = [];
    for (const [w, f] of [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)) {
      const df = (st.vocab.get(w) as { doc: number } | undefined)?.doc ?? 0;
      if (df < 2 || df > n * 0.6) continue; // must be shared, and not nearly everywhere
      scored.push({ w, s: (1 + Math.log(f)) * Math.log(n / df), common: df > n * 0.2 });
    }
    // Words in more than a fifth of the library only count when too few rarer ones are shared,
    // which happens in small or very uniform libraries.
    const rare = scored.filter((x) => !x.common);
    const top = (rare.length >= 3 ? rare : scored).sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.w);
    if (!top.length) return [];
    const rows = db
      .prepare(`SELECT d.item_id, d.published, bm25(fts, ${WEIGHTS.join(', ')}) AS r FROM fts f JOIN docs d ON d.rowid = f.rowid WHERE fts MATCH ? ORDER BY r LIMIT 120`)
      .all(top.map(q).join(' OR ')) as { item_id: string; published: string; r: number }[];
    const topics = deps.topics?.() ?? [];
    const mine = new Set(matchTopics(itemHaystack(it), topics).map((t) => t.topicName));
    const authorKey = (x: Item) => `${x.platform}:${(x.author.handle ?? x.author.name).toLowerCase()}`;
    const me = authorKey(it);
    const out: RelatedHit[] = [];
    for (const r of rows) {
      if (r.item_id === id) continue;
      if (opts.ids && !opts.ids.has(r.item_id)) continue;
      const other = store.getItem(r.item_id);
      if (!other || other.dedupeKey === it.dedupeKey) continue;
      const theirArt = extras.articles.get(r.item_id);
      const set = new Set(words(`${other.title ?? ''} ${other.text} ${other.quoted?.text ?? ''} ${theirArt ? articleText(theirArt.data).slice(0, 8000) : ''}`));
      const shared = top.filter((w) => set.has(w));
      const theirs = matchTopics(itemHaystack(other), topics)
        .map((t) => t.topicName)
        .filter((t) => mine.has(t));
      const sameAuthor = authorKey(other) === me;
      // One shared word alone is a coincidence unless the author or a topic backs it up.
      if (shared.length < 2 && !sameAuthor && !theirs.length) continue;
      const score = -r.r * (sameAuthor ? 1.3 : 1) * (1 + 0.15 * theirs.length) * recency(r.published);
      out.push({ id: r.item_id, score, shared: shared.slice(0, 5), sameAuthor, topics: theirs });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return {
    search,
    related,
    status,
    build,
    /** Sync after writes; cheap when nothing changed. */
    sync: () => {
      if (!building && Date.now() - lastSync > 250) fresh();
    },
    close: () => db.close(),
  };
}

export type Search = ReturnType<typeof createSearch>;
