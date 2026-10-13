// Durable local storage on SQLite (node:sqlite, built into Node 24+).
// One file: data/social-reader.db. Schema versioned with PRAGMA user_version.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { AiRule, AgentEvent, AgentThread, FilterSpec, Item, ItemState, Page, SavedView, Source, SyncRun, Topic } from '../core/types.ts';

const SCHEMA_VERSION = 3;
const ITEM_SELECT = `SELECT i.id, i.source_id, i.data, i.ingested_at, i.dedupe_key, i.is_demo,
                s.read, s.saved, s.archived, s.collections, s.noise_override, s.read_at, s.saved_at
         FROM items i LEFT JOIN item_state s ON s.item_id = i.id`;
// The item list's order. Rows are read in table order (newest rowid first) and sorted here: walking
// the published_at index instead costs a random lookup per row, about 2.5x slower at 100k posts.
// The sort is stable, so posts published at the same moment keep newest-rowid-first, as before.
const newestFirst = (a: Item, b: Item) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0);
const SECRET_PREFIX = 'enc:v1:';

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, connector TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'never', status_detail TEXT,
      last_sync_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0,
      cursor TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, platform TEXT NOT NULL, external_id TEXT NOT NULL,
      url TEXT NOT NULL, data TEXT NOT NULL, published_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX items_source ON items(source_id);
    CREATE INDEX items_published ON items(published_at);
    CREATE TABLE item_state (
      item_id TEXT PRIMARY KEY, read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, collections TEXT NOT NULL DEFAULT '[]', noise_override INTEGER,
      read_at TEXT, saved_at TEXT
    );
    CREATE TABLE views (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, terms TEXT NOT NULL);
    CREATE TABLE collections (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0, errors TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // Which sources hold each item, so removing one source keeps posts another source still has.
  2: `
    CREATE TABLE item_sources (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      PRIMARY KEY (item_id, source_id)
    );
    CREATE INDEX item_sources_source ON item_sources(source_id);
    INSERT OR IGNORE INTO item_sources(item_id, source_id) SELECT id, source_id FROM items;
  `,
  // The agent: pages it builds, conversations, an undo log, and plain-English rules with cached labels.
  3: `
    CREATE TABLE pages (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, blocks TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_threads (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'chat', title TEXT, status TEXT NOT NULL DEFAULT 'idle',
      parent_id TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX agent_events_thread ON agent_events(thread_id, id);
    CREATE TABLE changes (
      id TEXT PRIMARY KEY, thread_id TEXT, at TEXT NOT NULL, label TEXT NOT NULL, undo TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ai_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'hide',
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE item_labels (
      item_id TEXT NOT NULL, rule_id TEXT NOT NULL, match INTEGER NOT NULL, reason TEXT, at TEXT NOT NULL,
      PRIMARY KEY (item_id, rule_id)
    );
  `,
};

const EMPTY_STATE: ItemState = { read: false, saved: false, archived: false, collections: [], noiseOverride: null, readAt: null, savedAt: null };

type Row = Record<string, unknown>;

/** Distinguishes item-list versions across restarts. */
const BOOT_ID = randomBytes(4).toString('hex');


export class Store {
  db: DatabaseSync;
  path: string;
  /** Called after a new source, view, page or AI rule is created (not on updates). Profiles use it. */
  onCreate?: (kind: 'source' | 'view' | 'page' | 'aiRule', id: string) => void;

  constructor(dataDir: string) {
    const dir = resolve(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'social-reader.db');
    this.db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600); // the file can hold OAuth tokens
    } catch {
      /* best effort */
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seedDefaults();
    try {
      this.encryptLegacySecrets();
    } catch (e) {
      console.warn('[store] Could not encrypt stored secrets:', (e as Error).message);
    }
    try {
      if (statSync(dir).mode & 0o077) console.warn(`[store] ${dir} can be read by other users on this machine. Run: chmod 700 '${dir}'`);
    } catch {
      /* best effort */
    }
  }

  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private seedDefaults() {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM topics').get() as { n: number }).n;
    const seeded = this.getSetting<boolean>('seeded');
    if (!seeded && n === 0) {
      // Starter topics are plain keyword lists the user can edit or delete.
      const starters: [string, string[]][] = [
        ['AI and models', ['ai', 'llm', 'llms', 'model', 'models', 'claude', 'gpt', 'machine learning', 'agents']],
        ['Software', ['programming', 'code', 'typescript', 'rust', 'python', 'compiler', 'database', 'sqlite', 'terminal', 'unix']],
        ['Design', ['design', 'typography', 'type', 'ui', 'ux', 'interface']],
      ];
      for (const [name, terms] of starters) this.saveTopic({ id: randomUUID(), name, terms });
      this.setSetting('seeded', true);
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- settings & secrets
  getSetting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as T) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  // Secrets (AI key, OAuth tokens, feed and image tokens) are stored encrypted with AES-256-GCM.
  // The key is a random 32 bytes in secret.key next to the database, mode 0600. This keeps the
  // values out of copies of the database file (backups, synced folders, a shared .db); it does not
  // help against someone who can read the whole data folder. Rows written before encryption are
  // read as plaintext and re-encrypted at startup.
  getSecret(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as Row | undefined;
    if (!r) return null;
    const v = String(r.value);
    if (!v.startsWith(SECRET_PREFIX)) return v;
    try {
      const raw = Buffer.from(v.slice(SECRET_PREFIX.length), 'base64url');
      const d = createDecipheriv('aes-256-gcm', this.secretKey(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      console.warn(`[store] Could not decrypt secret "${key}" (secret.key changed or missing); it needs to be entered again.`);
      return null;
    }
  }
  setSecret(key: string, value: string | null) {
    if (value === null) {
      this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
      return;
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    const stored = SECRET_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
    this.db.prepare('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, stored);
  }

  private _secretKey?: Buffer;
  private secretKey(): Buffer {
    if (this._secretKey) return this._secretKey;
    const file = join(dirname(this.path), 'secret.key');
    for (let attempt = 0; ; attempt++) {
      try {
        const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
        // Never replace a damaged key file: that would silently lose every stored secret.
        if (k.length !== 32) throw new Error(`${file} is not a valid key file; move it aside to start over`);
        return (this._secretKey = k);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) throw e;
        try {
          writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
        } catch (w) {
          if ((w as NodeJS.ErrnoException).code !== 'EEXIST') throw w;
        }
      }
    }
  }

  /** Re-encrypts secrets stored as plaintext by older versions. */
  private encryptLegacySecrets() {
    const rows = this.db.prepare('SELECT key, value FROM secrets').all() as { key: string; value: string }[];
    for (const r of rows) if (!String(r.value).startsWith(SECRET_PREFIX)) this.setSecret(r.key, String(r.value));
  }

  // ---------- sources
  private rowToSource(r: Row): Source {
    return {
      id: String(r.id),
      connector: String(r.connector),
      label: String(r.label),
      platform: String(r.platform) as Source['platform'],
      config: JSON.parse(String(r.config)),
      status: String(r.status) as Source['status'],
      statusDetail: (r.status_detail as string) ?? null,
      lastSyncAt: (r.last_sync_at as string) ?? null,
      itemCount: Number(r.item_count ?? 0),
      enabled: Boolean(r.enabled),
      isDemo: Boolean(r.is_demo),
      createdAt: String(r.created_at),
    };
  }
  listSources(): Source[] {
    const rows = this.db
      .prepare('SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count FROM sources s ORDER BY s.created_at')
      .all() as Row[];
    return rows.map((r) => this.rowToSource(r));
  }
  getSource(id: string): (Source & { cursor: string | null }) | null {
    const r = this.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count FROM sources s WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...this.rowToSource(r), cursor: (r.cursor as string) ?? null } : null;
  }
  findSourceByConfig(connector: string, key: string, value: string): Source | null {
    return this.listSources().find((s) => s.connector === connector && String(s.config[key] ?? '').toLowerCase() === value.toLowerCase()) ?? null;
  }
  createSource(s: { connector: string; label: string; platform: string; config: Record<string, unknown>; isDemo?: boolean; status?: string }): Source {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO sources(id, connector, label, platform, config, status, is_demo, created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, s.connector, s.label, s.platform, JSON.stringify(s.config), s.status ?? 'never', s.isDemo ? 1 : 0, new Date().toISOString());
    this.onCreate?.('source', id);
    return this.getSource(id)!;
  }
  updateSource(id: string, patch: Partial<{ label: string; status: string; statusDetail: string | null; lastSyncAt: string; enabled: boolean; cursor: string | null; config: Record<string, unknown> }>) {
    const map: Record<string, string> = { label: 'label', status: 'status', statusDetail: 'status_detail', lastSyncAt: 'last_sync_at', enabled: 'enabled', cursor: 'cursor', config: 'config' };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in map)) continue;
      const val = k === 'enabled' ? (v ? 1 : 0) : k === 'config' ? JSON.stringify(v) : (v as string | null);
      this.db.prepare(`UPDATE sources SET ${map[k]} = ? WHERE id = ?`).run(val, id);
    }
  }
  /**
   * Removes a source and the items only it brought in. Items another source also holds stay,
   * with their reading state, and are reassigned to that source.
   */
  deleteSource(id: string) {
    this.tx(() => {
      this.db.prepare('DELETE FROM item_sources WHERE source_id = ?').run(id);
      this.db
        .prepare('UPDATE items SET source_id = (SELECT source_id FROM item_sources WHERE item_id = items.id LIMIT 1) WHERE source_id = ? AND id IN (SELECT item_id FROM item_sources)')
        .run(id);
      this.db.prepare('DELETE FROM item_state WHERE item_id IN (SELECT id FROM items WHERE source_id = ?)').run(id);
      this.db.prepare('DELETE FROM items WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM sync_runs WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    });
  }

  recoverInterruptedSyncs() {
    this.db.prepare("UPDATE sources SET status = 'error', status_detail = 'The last sync was interrupted. It will run again.' WHERE status = 'syncing'").run();
    this.db.prepare(`UPDATE sync_runs SET finished_at = started_at, ok = 0, errors = '["Interrupted by a restart"]' WHERE finished_at IS NULL`).run();
  }

  // ---------- items
  // The item list is cached. At 100k posts reading and parsing every row takes most of a second,
  // and the library is asked for on every change event. Temporary triggers note which items this
  // connection changed, and PRAGMA data_version notices commits from any other connection (the
  // MCP server, a second process), which forces a full re-read. Unchanged rows keep their Item
  // object, so per-item caches keyed by identity (the filter's WeakMap, wire JSON) stay warm.
  // Items handed out are shared: treat them as immutable, as the UI already does.
  private itemCache?: { db: DatabaseSync; tracked: boolean; dataVersion: number; version: number; items: Item[]; byId: Map<string, Item> };

  /** Changes whenever the item list may have changed. Cheap enough to call per request. */
  itemsVersion(): string {
    this.listItems();
    return `${BOOT_ID}.${this.itemCache!.version}`;
  }

  private trackItemChanges(): boolean {
    try {
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS items_dirty(id TEXT);
        -- No unique key on purpose: the outer statement's conflict policy (an upsert, INSERT OR
        -- REPLACE) overrides a trigger's OR IGNORE, so a key could make ordinary writes fail.
        CREATE TEMP TRIGGER IF NOT EXISTS items_dirty_ins AFTER INSERT ON main.items BEGIN INSERT INTO items_dirty VALUES (NEW.id); END;
        CREATE TEMP TRIGGER IF NOT EXISTS items_dirty_upd AFTER UPDATE ON main.items BEGIN INSERT INTO items_dirty VALUES (NEW.id); INSERT INTO items_dirty SELECT OLD.id WHERE OLD.id IS NOT NEW.id; END;
        CREATE TEMP TRIGGER IF NOT EXISTS items_dirty_del AFTER DELETE ON main.items BEGIN INSERT INTO items_dirty VALUES (OLD.id); END;
        CREATE TEMP TRIGGER IF NOT EXISTS state_dirty_ins AFTER INSERT ON main.item_state BEGIN INSERT INTO items_dirty VALUES (NEW.item_id); END;
        CREATE TEMP TRIGGER IF NOT EXISTS state_dirty_upd AFTER UPDATE ON main.item_state BEGIN INSERT INTO items_dirty VALUES (NEW.item_id); INSERT INTO items_dirty SELECT OLD.item_id WHERE OLD.item_id IS NOT NEW.item_id; END;
        CREATE TEMP TRIGGER IF NOT EXISTS state_dirty_del AFTER DELETE ON main.item_state BEGIN INSERT INTO items_dirty VALUES (OLD.item_id); END;
      `);
      return true;
    } catch {
      // A connection that cannot make temporary objects. That is only safe because such a
      // connection (the read-only MCP one) never writes, so data_version sees every change.
      return false;
    }
  }

  private warming?: Promise<void>;

  /**
   * Fills the item cache without blocking the event loop: the same read as listItems' first
   * pass, in slices of rows with a turn of the event loop between them, so a server that just
   * started keeps answering while 100k posts load (the plain read blocks for most of a second).
   * listItems() stays correct throughout. If anything reads the list first, or another
   * connection commits meanwhile, the warmed copy is dropped. Writes on this connection during
   * the read land in items_dirty and are applied by the next listItems().
   */
  warmItems(sliceMs = 12): Promise<void> {
    if (this.itemCache?.db === this.db) return Promise.resolve();
    this.warming ??= (async () => {
      const tracked = this.trackItemChanges();
      if (tracked) this.db.exec('DELETE FROM items_dirty');
      const dataVersion = (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
      const rows = this.db.prepare(`${ITEM_SELECT} ORDER BY i.rowid DESC`).iterate() as IterableIterator<Row>;
      const items: Item[] = [];
      try {
        for (;;) {
          const end = performance.now() + sliceMs;
          let next = rows.next();
          while (!next.done) {
            items.push(this.rowToItem(next.value));
            if (performance.now() > end) break;
            next = rows.next();
          }
          if (next.done) break;
          await new Promise((r) => setImmediate(r));
          if (this.itemCache) return; // something read the whole list meanwhile
        }
      } finally {
        rows.return?.();
      }
      if (this.itemCache) return;
      if ((this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version !== dataVersion) return;
      items.sort(newestFirst);
      this.itemCache = { db: this.db, tracked, dataVersion, version: 1, items, byId: new Map(items.map((it) => [it.id, it])) };
    })().finally(() => (this.warming = undefined));
    return this.warming;
  }

  listItems(): Item[] {
    const dataVersion = (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    let c = this.itemCache;
    if (!c || c.db !== this.db) c = this.itemCache = { db: this.db, tracked: this.trackItemChanges(), dataVersion: -1, version: (c?.version ?? 0) + 1, items: [], byId: new Map() };
    const select = ITEM_SELECT;
    if (c.dataVersion !== dataVersion) {
      // First read, or another connection committed: read everything.
      if (c.tracked) this.db.exec('DELETE FROM items_dirty');
      const items: Item[] = [];
      for (const r of this.db.prepare(`${select} ORDER BY i.rowid DESC`).iterate() as IterableIterator<Row>) items.push(this.rowToItem(r));
      items.sort(newestFirst);
      Object.assign(c, { dataVersion, items, byId: new Map(items.map((it) => [it.id, it])), version: c.version + 1 });
      return items.slice();
    }
    if (!c.tracked) return c.items.slice();
    const dirty = this.db.prepare('SELECT DISTINCT id FROM items_dirty').all() as { id: string }[];
    if (!dirty.length) return c.items.slice();
    const rows = this.db.prepare(`${select} WHERE i.id IN (SELECT id FROM temp.items_dirty)`).all() as Row[];
    this.db.exec('DELETE FROM items_dirty');
    const found = new Set(rows.map((r) => String(r.id)));
    let reorder = false;
    const replaced = new Map<Item, Item>();
    for (const { id } of dirty) {
      if (!found.has(id) && c.byId.delete(id)) reorder = true;
    }
    for (const r of rows) {
      const item = this.rowToItem(r);
      const prev = c.byId.get(item.id);
      c.byId.set(item.id, item);
      if (!prev || prev.publishedAt !== item.publishedAt) reorder = true;
      else replaced.set(prev, item);
    }
    c.items = reorder
      ? [...c.byId.values()].sort(newestFirst)
      : c.items.map((it) => replaced.get(it) ?? it);
    c.version++;
    return c.items.slice();
  }
  getItem(id: string): Item | null {
    const r = this.db
      .prepare(
        `SELECT i.id, i.source_id, i.data, i.ingested_at, i.dedupe_key, i.is_demo,
                s.read, s.saved, s.archived, s.collections, s.noise_override, s.read_at, s.saved_at
         FROM items i LEFT JOIN item_state s ON s.item_id = i.id WHERE i.id = ?`,
      )
      .get(id) as Row | undefined;
    return r ? this.rowToItem(r) : null;
  }
  private rowToItem(r: Row): Item {
    const data = JSON.parse(String(r.data));
    return {
      ...data,
      id: String(r.id),
      sourceId: String(r.source_id),
      ingestedAt: String(r.ingested_at),
      dedupeKey: String(r.dedupe_key),
      isDemo: Boolean(r.is_demo),
      state:
        r.read === null || r.read === undefined
          ? { ...EMPTY_STATE }
          : {
              read: Boolean(r.read),
              saved: Boolean(r.saved),
              archived: Boolean(r.archived),
              collections: JSON.parse(String(r.collections ?? '[]')),
              noiseOverride: r.noise_override === null || r.noise_override === undefined ? null : Boolean(r.noise_override),
              readAt: (r.read_at as string) ?? null,
              savedAt: (r.saved_at as string) ?? null,
            },
    };
  }
  /** Insert or refresh an item. Returns 'added' | 'updated'. Local state is never touched here. */
  upsertItem(item: Omit<Item, 'state'>): 'added' | 'updated' {
    const { id, sourceId, ingestedAt, dedupeKey, isDemo, ...data } = item;
    const existing = this.db.prepare('SELECT published_at FROM items WHERE id = ?').get(id) as { published_at: string } | undefined;
    if (existing) {
      // Keep the first known publish date: undated feed entries get "now" on every sync.
      data.publishedAt = existing.published_at;
      this.db.prepare('UPDATE items SET data = ?, url = ?, dedupe_key = ? WHERE id = ?').run(JSON.stringify(data), item.url, dedupeKey, id);
      this.db.prepare('INSERT OR IGNORE INTO item_sources(item_id, source_id) VALUES(?, ?)').run(id, sourceId);
      return 'updated';
    }
    this.db
      .prepare('INSERT INTO items(id, source_id, platform, external_id, url, data, published_at, ingested_at, dedupe_key, is_demo) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, sourceId, item.platform, item.externalId, item.url, JSON.stringify(data), item.publishedAt, ingestedAt, dedupeKey, isDemo ? 1 : 0);
    this.db.prepare('INSERT OR IGNORE INTO item_sources(item_id, source_id) VALUES(?, ?)').run(id, sourceId);
    return 'added';
  }
  patchState(ids: string[], patch: Partial<ItemState>): Item[] {
    const now = new Date().toISOString();
    return this.tx(() => {
      const out: Item[] = [];
      for (const id of ids) {
        const cur = this.getItem(id);
        if (!cur) continue;
        const next: ItemState = { ...cur.state };
        if (patch.read !== undefined) {
          next.read = patch.read;
          next.readAt = patch.read ? now : null;
        }
        if (patch.saved !== undefined) {
          next.saved = patch.saved;
          next.savedAt = patch.saved ? now : null;
        }
        if (patch.archived !== undefined) next.archived = patch.archived;
        if (patch.collections !== undefined) next.collections = [...new Set(patch.collections)];
        if (patch.noiseOverride !== undefined) next.noiseOverride = patch.noiseOverride;
        this.db
          .prepare(
            `INSERT INTO item_state(item_id, read, saved, archived, collections, noise_override, read_at, saved_at) VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(item_id) DO UPDATE SET read=excluded.read, saved=excluded.saved, archived=excluded.archived,
             collections=excluded.collections, noise_override=excluded.noise_override, read_at=excluded.read_at, saved_at=excluded.saved_at`,
          )
          .run(id, +next.read, +next.saved, +next.archived, JSON.stringify(next.collections), next.noiseOverride === null || next.noiseOverride === undefined ? null : +next.noiseOverride, next.readAt ?? null, next.savedAt ?? null);
        out.push({ ...cur, state: next });
      }
      return out;
    });
  }

  // ---------- views, topics, collections
  listViews(): SavedView[] {
    return (this.db.prepare('SELECT * FROM views ORDER BY position, created_at').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      spec: JSON.parse(String(r.spec)) as FilterSpec,
      createdAt: String(r.created_at),
    }));
  }
  saveView(v: { id?: string; name: string; spec: FilterSpec }): SavedView {
    const id = v.id ?? randomUUID();
    const exists = this.db.prepare('SELECT created_at FROM views WHERE id = ?').get(id) as Row | undefined;
    const createdAt = exists ? String(exists.created_at) : new Date().toISOString();
    this.db
      .prepare('INSERT INTO views(id, name, spec, created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec')
      .run(id, v.name, JSON.stringify(v.spec), createdAt);
    if (!exists) this.onCreate?.('view', id);
    return { id, name: v.name, spec: v.spec, createdAt };
  }
  deleteView(id: string) {
    this.db.prepare('DELETE FROM views WHERE id = ?').run(id);
  }
  listTopics(): Topic[] {
    return (this.db.prepare('SELECT * FROM topics ORDER BY name').all() as Row[]).map((r) => ({ id: String(r.id), name: String(r.name), terms: JSON.parse(String(r.terms)) }));
  }
  saveTopic(t: Topic) {
    this.db.prepare('INSERT INTO topics(id, name, terms) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, terms = excluded.terms').run(t.id, t.name, JSON.stringify(t.terms));
  }
  deleteTopic(id: string) {
    this.db.prepare('DELETE FROM topics WHERE id = ?').run(id);
  }
  listCollections(): string[] {
    return (this.db.prepare('SELECT name FROM collections ORDER BY created_at').all() as Row[]).map((r) => String(r.name));
  }
  addCollection(name: string) {
    this.db.prepare('INSERT OR IGNORE INTO collections(name, created_at) VALUES(?, ?)').run(name, new Date().toISOString());
  }
  deleteCollection(name: string) {
    this.tx(() => {
      this.db.prepare('DELETE FROM collections WHERE name = ?').run(name);
      const rows = this.db.prepare("SELECT item_id, collections FROM item_state WHERE collections LIKE ?").all(`%${JSON.stringify(name).slice(1, -1)}%`) as Row[];
      for (const r of rows) {
        const cols = (JSON.parse(String(r.collections)) as string[]).filter((c) => c !== name);
        this.db.prepare('UPDATE item_state SET collections = ? WHERE item_id = ?').run(JSON.stringify(cols), String(r.item_id));
      }
    });
  }

  // ---------- sync runs
  startRun(sourceId: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sync_runs(id, source_id, started_at) VALUES(?,?,?)').run(id, sourceId, new Date().toISOString());
    return id;
  }
  finishRun(id: string, r: { ok: boolean; added: number; updated: number; skipped: number; errors: string[] }) {
    this.db
      .prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, added = ?, updated = ?, skipped = ?, errors = ? WHERE id = ?')
      .run(new Date().toISOString(), r.ok ? 1 : 0, r.added, r.updated, r.skipped, JSON.stringify(r.errors.slice(0, 50)), id);
  }
  listRuns(limit = 40): SyncRun[] {
    return (this.db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: String(r.id),
      sourceId: String(r.source_id),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string) ?? null,
      ok: Boolean(r.ok),
      added: Number(r.added),
      updated: Number(r.updated),
      skipped: Number(r.skipped),
      errors: JSON.parse(String(r.errors)),
    }));
  }

  // ---------- pages
  listPages(): Page[] {
    return (this.db.prepare('SELECT * FROM pages ORDER BY position, created_at').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      icon: (r.icon as string) ?? null,
      blocks: JSON.parse(String(r.blocks)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }
  getPage(id: string): Page | null {
    return this.listPages().find((p) => p.id === id) ?? null;
  }
  savePage(p: { id?: string; name: string; icon?: string | null; blocks: unknown[] }): Page {
    const id = p.id ?? randomUUID();
    const now = new Date().toISOString();
    const exists = this.db.prepare('SELECT created_at FROM pages WHERE id = ?').get(id) as Row | undefined;
    this.db
      .prepare('INSERT INTO pages(id, name, icon, blocks, created_at, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, blocks = excluded.blocks, updated_at = excluded.updated_at')
      .run(id, p.name, p.icon ?? null, JSON.stringify(p.blocks), exists ? String(exists.created_at) : now, now);
    if (!exists) this.onCreate?.('page', id);
    return this.getPage(id)!;
  }
  deletePage(id: string) {
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  }

  // ---------- agent threads and events
  private rowToThread(r: Row): AgentThread {
    return {
      id: String(r.id),
      kind: String(r.kind) as AgentThread['kind'],
      title: (r.title as string) ?? null,
      status: String(r.status) as AgentThread['status'],
      parentId: (r.parent_id as string) ?? null,
      meta: JSON.parse(String(r.meta)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  createThread(t: { kind: AgentThread['kind']; title?: string | null; parentId?: string | null; meta?: Record<string, unknown> }): AgentThread {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO agent_threads(id, kind, title, status, parent_id, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, t.kind, t.title ?? null, 'idle', t.parentId ?? null, JSON.stringify(t.meta ?? {}), now, now);
    return this.getThread(id)!;
  }
  getThread(id: string): AgentThread | null {
    const r = this.db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToThread(r) : null;
  }
  listThreads(kind?: string, limit = 50): AgentThread[] {
    const rows = kind
      ? (this.db.prepare('SELECT * FROM agent_threads WHERE kind = ? ORDER BY updated_at DESC LIMIT ?').all(kind, limit) as Row[])
      : (this.db.prepare('SELECT * FROM agent_threads ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]);
    return rows.map((r) => this.rowToThread(r));
  }
  updateThread(id: string, patch: Partial<{ title: string | null; status: string; meta: Record<string, unknown> }>) {
    const now = new Date().toISOString();
    if (patch.title !== undefined) this.db.prepare('UPDATE agent_threads SET title = ? WHERE id = ?').run(patch.title, id);
    if (patch.status !== undefined) this.db.prepare('UPDATE agent_threads SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.meta !== undefined) this.db.prepare('UPDATE agent_threads SET meta = ? WHERE id = ?').run(JSON.stringify(patch.meta), id);
    this.db.prepare('UPDATE agent_threads SET updated_at = ? WHERE id = ?').run(now, id);
  }
  addEvent(threadId: string, type: string, data: unknown): AgentEvent {
    const at = new Date().toISOString();
    const r = this.db.prepare('INSERT INTO agent_events(thread_id, at, type, data) VALUES(?,?,?,?)').run(threadId, at, type, JSON.stringify(data));
    return { id: Number(r.lastInsertRowid), threadId, at, type, data };
  }
  listEvents(threadId: string, afterId = 0): AgentEvent[] {
    return (this.db.prepare('SELECT * FROM agent_events WHERE thread_id = ? AND id > ? ORDER BY id').all(threadId, afterId) as Row[]).map((r) => ({
      id: Number(r.id),
      threadId: String(r.thread_id),
      at: String(r.at),
      type: String(r.type),
      data: JSON.parse(String(r.data)),
    }));
  }

  // ---------- change log (agent changes that can be undone)
  addChange(c: { threadId?: string | null; label: string; undo: unknown }): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO changes(id, thread_id, at, label, undo) VALUES(?,?,?,?,?)').run(id, c.threadId ?? null, new Date().toISOString(), c.label, JSON.stringify(c.undo));
    return id;
  }
  getChange(id: string): { id: string; label: string; undo: any; undone: boolean } | null {
    const r = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: String(r.id), label: String(r.label), undo: JSON.parse(String(r.undo)), undone: Boolean(r.undone) } : null;
  }
  markChangeUndone(id: string) {
    this.db.prepare('UPDATE changes SET undone = 1 WHERE id = ?').run(id);
  }

  // ---------- plain-English rules
  listAiRules(): AiRule[] {
    return (this.db.prepare('SELECT * FROM ai_rules ORDER BY created_at').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      prompt: String(r.prompt),
      action: String(r.action) as AiRule['action'],
      enabled: Boolean(r.enabled),
      createdAt: String(r.created_at),
    }));
  }
  saveAiRule(rule: { id?: string; name: string; prompt: string; action: AiRule['action']; enabled?: boolean }): AiRule {
    const id = rule.id ?? randomUUID();
    const exists = this.db.prepare('SELECT created_at FROM ai_rules WHERE id = ?').get(id) as Row | undefined;
    this.db
      .prepare('INSERT INTO ai_rules(id, name, prompt, action, enabled, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, action = excluded.action, enabled = excluded.enabled')
      .run(id, rule.name, rule.prompt, rule.action, rule.enabled === false ? 0 : 1, exists ? String(exists.created_at) : new Date().toISOString());
    if (exists) this.db.prepare('DELETE FROM item_labels WHERE rule_id = ?').run(id);
    else this.onCreate?.('aiRule', id);
    return this.listAiRules().find((r) => r.id === id)!;
  }
  deleteAiRule(id: string) {
    this.db.prepare('DELETE FROM ai_rules WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM item_labels WHERE rule_id = ?').run(id);
  }
  /** Labels per rule: ruleId -> itemId -> { match, reason }. */
  listLabels(): Record<string, Record<string, { match: boolean; reason: string | null }>> {
    const out: Record<string, Record<string, { match: boolean; reason: string | null }>> = {};
    for (const r of this.db.prepare('SELECT * FROM item_labels').all() as Row[]) {
      (out[String(r.rule_id)] ??= {})[String(r.item_id)] = { match: Boolean(r.match), reason: (r.reason as string) ?? null };
    }
    return out;
  }
  setLabels(ruleId: string, labels: { itemId: string; match: boolean; reason?: string | null }[]) {
    const at = new Date().toISOString();
    this.tx(() => {
      for (const l of labels) {
        this.db
          .prepare('INSERT INTO item_labels(item_id, rule_id, match, reason, at) VALUES(?,?,?,?,?) ON CONFLICT(item_id, rule_id) DO UPDATE SET match = excluded.match, reason = excluded.reason, at = excluded.at')
          .run(l.itemId, ruleId, l.match ? 1 : 0, l.reason ?? null, at);
      }
    });
  }
}
