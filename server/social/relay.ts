// Store-and-forward relay for Aurora friends. Opt-in: SR_RELAY=1 starts it inside Aurora, or run
// it alone with `node server/social/relay.ts`.
//
// The relay runs on its own port (SR_RELAY_PORT, default 4334) and serves nothing but these
// endpoints, so it can be put behind a public reverse proxy without exposing the private /api of
// the Aurora it lives in. It only ever sees sealed envelopes addressed to opaque, rotating
// mailbox ids. Posting needs the mailbox id; fetching and deleting need its preimage (the fetch
// token), which only the two friends can compute. No accounts, no handles, no plaintext.
//
//   POST /relay/v1/put    { to, env }                    store one envelope
//   POST /relay/v1/fetch  { tokens: [...] }              envelopes for those mailboxes
//   POST /relay/v1/ack    { acks: [{ token, ids }] }     delete delivered envelopes
//   GET  /relay/v1/info                                  limits, for clients
//
// Caps: envelope size, messages and bytes per mailbox, total bytes, per-IP request rate and a
// 14-day expiry. JSON content type is required on POST, which keeps browsers on other sites from
// posting without a CORS preflight that this server never answers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mailboxId, parseEnvelope } from './crypto.ts';

export const RELAY_LIMITS = {
  maxEnvelopeBytes: 360_000,
  maxPerMailbox: 500,
  maxBytesPerMailbox: 16 * 1024 * 1024,
  maxTotalBytes: Number(process.env.SR_RELAY_MAX_MB ?? 256) * 1024 * 1024,
  maxTokensPerFetch: 64,
  maxReturnBytes: 4 * 1024 * 1024,
  ttlMs: 14 * 24 * 3600_000,
  putsPerMinute: 120,
  fetchesPerMinute: 120,
  /** Bytes one address may store per day, so one sender cannot fill the whole relay. */
  maxBytesPerIpPerDay: Number(process.env.SR_RELAY_IP_MB_PER_DAY ?? 32) * 1024 * 1024,
  /** Distinct addresses tracked by the rate limiter before the oldest are forgotten. */
  maxTrackedIps: 50_000,
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class RelayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RelayHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startRelay(opts: { port: number; host: string; dataDir: string; log?: (m: string) => void }): Promise<RelayHandle> {
  const dir = resolve(opts.dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'relay.db');
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS envelopes (id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, env TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS envelopes_mailbox ON envelopes(mailbox, at);`);
  const L = RELAY_LIMITS;
  const trustProxy = process.env.SR_RELAY_TRUST_PROXY === '1';

  const buckets = new Map<string, { put: number[]; fetch: number[] }>();
  function rate(ip: string, kind: 'put' | 'fetch') {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
      // Bounded: a flood of new addresses evicts the oldest entries instead of growing memory.
      if (buckets.size >= L.maxTrackedIps) buckets.delete(buckets.keys().next().value!);
      buckets.set(ip, (b = { put: [], fetch: [] }));
    }
    const list = b[kind].filter((t) => now - t < 60_000);
    b[kind] = list;
    if (list.length >= (kind === 'put' ? L.putsPerMinute : L.fetchesPerMinute)) throw new RelayError(429, 'Slow down');
    list.push(now);
  }

  // Bytes stored per address today. Without this, one address at the request rate limit fills the
  // total cap in under an hour, and every friend's delivery fails until the envelopes expire.
  let quotaDay = Math.floor(Date.now() / 86400_000);
  const stored = new Map<string, number>();
  function chargeBytes(ip: string, n: number) {
    const day = Math.floor(Date.now() / 86400_000);
    if (day !== quotaDay) {
      quotaDay = day;
      stored.clear();
    }
    const used = stored.get(ip) ?? 0;
    if (used + n > L.maxBytesPerIpPerDay) throw new RelayError(429, 'Daily storage quota reached for this address');
    if (!stored.has(ip) && stored.size >= L.maxTrackedIps) stored.delete(stored.keys().next().value!);
    stored.set(ip, used + n);
  }

  function sweep() {
    db.prepare('DELETE FROM envelopes WHERE at < ?').run(Date.now() - L.ttlMs);
    const now = Date.now();
    for (const [ip, b] of buckets) if (!b.put.some((t) => now - t < 60_000) && !b.fetch.some((t) => now - t < 60_000)) buckets.delete(ip);
  }
  sweep();
  const sweeper = setInterval(sweep, 3600_000);
  sweeper.unref();

  function put(body: any, ip: string) {
    const env = parseEnvelope(body?.env);
    const to = String(body?.to ?? '');
    if (!TOKEN_RE.test(to) || env.to !== to) throw new RelayError(400, 'Bad mailbox');
    const json = JSON.stringify(env);
    if (json.length > L.maxEnvelopeBytes) throw new RelayError(413, 'Envelope too large');
    const box = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM envelopes WHERE mailbox = ?').get(to) as { n: number; b: number };
    if (box.n >= L.maxPerMailbox || box.b + json.length > L.maxBytesPerMailbox) throw new RelayError(507, 'Mailbox full');
    const total = (db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM envelopes').get() as { b: number }).b;
    if (total + json.length > L.maxTotalBytes) throw new RelayError(507, 'Relay full');
    chargeBytes(ip, json.length);
    const id = randomUUID();
    db.prepare('INSERT INTO envelopes(id, mailbox, env, bytes, at) VALUES(?,?,?,?,?)').run(id, to, json, json.length, Date.now());
    return { ok: true, id };
  }

  function tokensOf(list: unknown): string[] {
    if (!Array.isArray(list) || list.length > L.maxTokensPerFetch) throw new RelayError(400, 'Bad tokens');
    return list.map((t) => {
      if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw new RelayError(400, 'Bad token');
      return t;
    });
  }

  function fetchBoxes(body: any) {
    const tokens = tokensOf(body?.tokens);
    const boxes: Record<string, { id: string; env: unknown }[]> = {};
    let budget = L.maxReturnBytes;
    let more = false;
    const q = db.prepare('SELECT id, env, bytes FROM envelopes WHERE mailbox = ? ORDER BY at LIMIT 200');
    for (const t of tokens) {
      const rows = q.all(mailboxId(t)) as { id: string; env: string; bytes: number }[];
      const out: { id: string; env: unknown }[] = [];
      for (const r of rows) {
        if (r.bytes > budget) {
          more = true;
          break;
        }
        budget -= r.bytes;
        out.push({ id: r.id, env: JSON.parse(r.env) });
      }
      if (out.length) boxes[t] = out;
    }
    return { boxes, more };
  }

  function ack(body: any) {
    const acks = body?.acks;
    if (!Array.isArray(acks) || acks.length > L.maxTokensPerFetch) throw new RelayError(400, 'Bad acks');
    let deleted = 0;
    const del = db.prepare('DELETE FROM envelopes WHERE id = ? AND mailbox = ?');
    for (const a of acks) {
      const [token] = tokensOf([a?.token]);
      const ids = Array.isArray(a?.ids) ? a.ids.slice(0, 500) : [];
      const box = mailboxId(token);
      for (const id of ids) if (typeof id === 'string') deleted += Number(del.run(id, box).changes);
    }
    return { ok: true, deleted };
  }

  async function readJson(req: IncomingMessage): Promise<any> {
    if (!/application\/json/.test(req.headers['content-type'] ?? '')) throw new RelayError(415, 'Send JSON');
    const limit = L.maxEnvelopeBytes + 4096;
    if (Number(req.headers['content-length']) > limit) throw new RelayError(413, 'Too large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) throw new RelayError(413, 'Too large');
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new RelayError(400, 'Bad JSON');
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      // Behind a proxy, only the last X-Forwarded-For entry was written by that proxy. Earlier
      // entries come from the client, so trusting the first one let anyone pick a fresh address
      // per request and skip the rate limit.
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() : '';
      const ip = forwarded || req.socket.remoteAddress || '?';
      const path = new URL(req.url ?? '/', 'http://relay').pathname;
      if (req.method === 'GET' && path === '/relay/v1/info') return send(res, 200, { relay: 'aurora', v: 1, limits: { ...L } });
      if (req.method !== 'POST') throw new RelayError(404, 'Not found');
      if (path === '/relay/v1/put') {
        rate(ip, 'put');
        return send(res, 200, put(await readJson(req), ip));
      }
      if (path === '/relay/v1/fetch') {
        rate(ip, 'fetch');
        return send(res, 200, fetchBoxes(await readJson(req)));
      }
      if (path === '/relay/v1/ack') {
        rate(ip, 'fetch');
        return send(res, 200, ack(await readJson(req)));
      }
      throw new RelayError(404, 'Not found');
    } catch (e) {
      const status = e instanceof RelayError ? e.status : (e as { code?: string }).code === 'malformed' ? 400 : 500;
      if (status === 500) opts.log?.(`[relay] ${(e as Error).message}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Relay error' : (e as Error).message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      opts.log?.(`Aurora relay listening on http://${opts.host}:${port}/relay/v1 (store: ${path})`);
      resolveStart({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(sweeper);
            server.close(() => {
              db.close();
              r();
            });
          }),
      });
    });
  });
}

// Standalone: node server/social/relay.ts
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.SR_RELAY_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.ALLOW_NON_LOCAL !== '1') {
    console.error(`Refusing to bind the relay to ${host}. Set ALLOW_NON_LOCAL=1 if you mean it.`);
    process.exit(1);
  }
  void startRelay({ port: Number(process.env.SR_RELAY_PORT ?? 4334), host, dataDir: process.env.SR_RELAY_DATA ?? './data-relay', log: (m) => console.log(m) });
}
