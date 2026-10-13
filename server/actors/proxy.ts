// Egress proxy for actor runs. Every byte an actor sends to the network passes through here.
//
// - One http.Server handles CONNECT tunnels (HTTPS) and absolute-form plain HTTP requests.
// - Each run opens a session. Sandboxed runs reach it through a per-session unix socket
//   (the socket identifies the session); unsandboxed runs use the 127.0.0.1 listener with
//   Proxy-Authorization basic credentials sr:<token>.
// - A request is allowed only when its host matches the session allowlist ("*.x.com" matches
//   subdomains of x.com), the port is 80/443, and every resolved address is public. The
//   upstream socket connects to the address that was checked.
// - Host "sr.internal" (plain http) is served here: POST /browser renders a page in the host
//   browser, restricted to the same allowlist.

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isPrivateAddress } from '../safeFetch.ts';
import type { ProxyLogEntry } from './types.ts';

export const PACKAGE_INDEX_HOSTS = ['pypi.org', 'files.pythonhosted.org'];
const ALLOWED_PORTS = new Set([80, 443]);
const MAX_LOG = 1000;
const MAX_REQUESTS = 3000;
const MAX_BROWSER_CALLS = 30;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 120_000;
const HOP_HEADERS = new Set([
  'proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

export type BrowserHandler = (req: { url: string; waitMs?: number; scroll?: number; capture?: string; allowHosts: string[]; profile?: string }) => Promise<unknown>;

export interface ProxySession {
  id: string;
  hosts: string[];
  packageIndex: boolean;
  log: ProxyLogEntry[];
  /** Unix socket for this session (bind it into the sandbox). */
  socketPath: string;
  /** http://sr:<token>@127.0.0.1:<port>, for runs without a sandbox. */
  proxyUrl: string;
  requestCount: number;
  /** App-owned browser profile for sr.browser (session tier). The actor never sees its cookies. */
  profile?: string;
  close(): Promise<void>;
}

export interface EgressProxy {
  port: number;
  openSession(opts: { hosts: string[]; packageIndex?: boolean; profile?: string }): Promise<ProxySession>;
  close(): Promise<void>;
}

interface SessionState extends ProxySession {
  token: string;
  browserCalls: number;
}

/** True when host matches one of the patterns. "*.x.com" matches a.x.com and a.b.x.com, not x.com. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const p of patterns) {
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1)) && h.length > p.length - 1) return true;
    } else if (h === p) return true;
  }
  return false;
}

async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  if (net.isIP(host)) throw new Error('IP literals are not allowed');
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('DNS lookup failed');
  }
  if (!addrs.length) throw new Error('DNS lookup failed');
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`resolves to private address ${bad.address}`);
  return addrs.find((a) => a.family === 4) ?? addrs[0];
}

function parseAuthority(s: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(s);
  if (!m) return null;
  return { host: m[1].toLowerCase(), port: Number(m[2]) };
}

export async function startProxy(opts: { runDir: string; browser?: BrowserHandler }): Promise<EgressProxy> {
  fs.mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, SessionState>(); // token -> session
  const socketSessions = new WeakMap<net.Socket, SessionState>();
  const server = http.createServer();
  server.keepAliveTimeout = 30_000;

  const sessionFor = (req: http.IncomingMessage): SessionState | null => {
    const bySocket = socketSessions.get(req.socket);
    if (bySocket) return bySocket;
    const auth = req.headers['proxy-authorization'];
    if (typeof auth !== 'string' || !/^basic /i.test(auth)) return null;
    const [, token] = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8').split(':');
    return (token && sessions.get(token)) || null;
  };

  const record = (s: SessionState, e: Omit<ProxyLogEntry, 't'>): ProxyLogEntry => {
    const entry: ProxyLogEntry = { t: new Date().toISOString(), ...e };
    if (s.log.length < MAX_LOG) s.log.push(entry);
    return entry;
  };

  /** Returns a block reason, or null when the host:port may be reached. */
  const policy = (s: SessionState, host: string, port: number): string | null => {
    if (s.requestCount++ > MAX_REQUESTS) return 'request limit reached for this run';
    if (!ALLOWED_PORTS.has(port)) return `port ${port} not allowed`;
    if (hostAllowed(host, s.hosts)) return null;
    if (s.packageIndex && hostAllowed(host, PACKAGE_INDEX_HOSTS)) return null;
    return 'host not in allowlist';
  };

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => {});
    const s = sessionFor(req);
    if (!s) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sr"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const started = Date.now();
    const deny = (reason: string, status = 403) => {
      record(s, { method: 'CONNECT', host: target.host, port: target.port, status, blocked: true, reason });
      const body = `Blocked by Aurora egress proxy: ${target.host} (${reason})\n`;
      client.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Type: text/plain\r\nX-SR-Blocked: ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    const reason = policy(s, target.host, target.port);
    if (reason) return deny(reason);
    let addr: { address: string; family: number };
    try {
      addr = await resolvePublic(target.host);
    } catch (e) {
      return deny((e as Error).message);
    }
    const entry = record(s, { method: 'CONNECT', host: target.host, port: target.port, bytesIn: 0, bytesOut: 0 });
    const upstream = net.connect({ host: addr.address, port: target.port, family: addr.family });
    upstream.setTimeout(CONNECT_TIMEOUT_MS);
    upstream.once('connect', () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      client.setTimeout(IDLE_TIMEOUT_MS);
      entry.status = 200;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('data', (c: Buffer) => (entry.bytesIn = (entry.bytesIn ?? 0) + c.length));
    client.on('data', (c: Buffer) => (entry.bytesOut = (entry.bytesOut ?? 0) + c.length));
    const done = () => {
      entry.ms ??= Date.now() - started;
      upstream.destroy();
      client.destroy();
    };
    upstream.on('timeout', () => {
      if (!entry.status) {
        entry.status = 504;
        entry.reason = 'upstream connect timeout';
        client.end('HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\n\r\n');
      }
      done();
    });
    client.on('timeout', done);
    upstream.on('error', (e: NodeJS.ErrnoException) => {
      if (!entry.status) {
        entry.status = 502;
        entry.reason = e.code ?? e.message;
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      }
      done();
    });
    upstream.on('close', done);
    client.on('close', done);
  });

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const readBody = (req: http.IncomingMessage, max: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > max) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const internal = async (s: SessionState, req: http.IncomingMessage, res: http.ServerResponse, u: URL) => {
    const entry = record(s, { method: req.method ?? 'GET', host: 'sr.internal', port: 80, path: u.pathname });
    if (u.pathname !== '/browser' || req.method !== 'POST') {
      entry.status = 404;
      return sendJson(res, 404, { error: 'not found' });
    }
    if (!opts.browser) {
      entry.status = 501;
      return sendJson(res, 501, { error: 'browser service not available' });
    }
    if (++s.browserCalls > MAX_BROWSER_CALLS) {
      entry.status = 429;
      return sendJson(res, 429, { error: `browser call limit (${MAX_BROWSER_CALLS}) reached for this run` });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024));
    } catch {
      entry.status = 400;
      return sendJson(res, 400, { error: 'body must be JSON {url, wait_ms?, scroll?, capture?}' });
    }
    const url = typeof body.url === 'string' ? body.url : '';
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {}
    entry.path = `/browser ${url.slice(0, 300)}`;
    if (!host || !hostAllowed(host, s.hosts)) {
      entry.status = 403;
      entry.blocked = true;
      entry.reason = 'browser url host not in allowlist';
      return sendJson(res, 403, { error: `host not in allowlist: ${host || url}` });
    }
    const started = Date.now();
    try {
      const out = await opts.browser({
        url,
        waitMs: typeof body.wait_ms === 'number' ? body.wait_ms : undefined,
        scroll: typeof body.scroll === 'number' ? body.scroll : undefined,
        capture: typeof body.capture === 'string' ? body.capture : undefined,
        allowHosts: s.hosts,
        profile: s.profile,
      });
      entry.status = 200;
      entry.ms = Date.now() - started;
      sendJson(res, 200, out);
    } catch (e) {
      entry.status = 502;
      entry.reason = (e as Error).message.slice(0, 300);
      sendJson(res, 502, { error: (e as Error).message });
    }
  };

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const s = sessionFor(req);
    if (!s) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="sr"', 'content-length': '0' });
      return res.end();
    }
    let u: URL;
    try {
      u = new URL(req.url ?? '');
      if (u.protocol !== 'http:') throw new Error();
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Proxy expects absolute http:// URLs (use CONNECT for https)\n');
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'sr.internal') return internal(s, req, res, u);
    const port = Number(u.port || 80);
    const started = Date.now();
    const deny = (reason: string) => {
      record(s, { method: req.method ?? 'GET', host, port, path: u.pathname, status: 403, blocked: true, reason });
      res.writeHead(403, { 'content-type': 'text/plain', 'x-sr-blocked': reason });
      res.end(`Blocked by Aurora egress proxy: ${host} (${reason})\n`);
    };
    const reason = policy(s, host, port);
    if (reason) return deny(reason);
    let addr: { address: string; family: number };
    try {
      addr = await resolvePublic(host);
    } catch (e) {
      return deny((e as Error).message);
    }
    const entry = record(s, { method: req.method ?? 'GET', host, port, path: u.pathname.slice(0, 300), bytesIn: 0, bytesOut: 0 });
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v != null) headers[k] = v;
    headers.host = u.host;
    const up = http.request({
      host: addr.address,
      family: addr.family,
      port,
      method: req.method,
      path: u.pathname + u.search,
      headers,
      agent: false,
      timeout: IDLE_TIMEOUT_MS,
    });
    up.on('response', (ur) => {
      entry.status = ur.statusCode;
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP_HEADERS.has(k) && v != null) out[k] = v;
      res.writeHead(ur.statusCode ?? 502, out);
      ur.on('data', (c: Buffer) => (entry.bytesIn = (entry.bytesIn ?? 0) + c.length));
      ur.on('end', () => (entry.ms = Date.now() - started));
      ur.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e: NodeJS.ErrnoException) => {
      entry.status ??= 502;
      entry.reason = e.code ?? e.message;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Upstream error: ${e.code ?? e.message}\n`);
      } else res.destroy();
    });
    req.on('data', (c: Buffer) => (entry.bytesOut = (entry.bytesOut ?? 0) + c.length));
    req.pipe(up);
  });

  server.on('clientError', (_e, sock: net.Socket) => sock.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const unixServers = new Set<net.Server>();

  return {
    port,
    async openSession({ hosts, packageIndex = false, profile }) {
      const id = crypto.randomBytes(6).toString('hex');
      const token = crypto.randomBytes(18).toString('base64url');
      const socketPath = path.join(opts.runDir, `p-${id}.sock`);
      const unix = net.createServer((sock) => {
        socketSessions.set(sock, s);
        server.emit('connection', sock);
      });
      await new Promise<void>((resolve, reject) => {
        unix.once('error', reject);
        unix.listen(socketPath, resolve);
      });
      fs.chmodSync(socketPath, 0o600);
      unixServers.add(unix);
      const s: SessionState = {
        id,
        token,
        hosts: [...hosts],
        packageIndex,
        profile,
        log: [],
        socketPath,
        proxyUrl: `http://sr:${token}@127.0.0.1:${port}`,
        requestCount: 0,
        browserCalls: 0,
        close: async () => {
          sessions.delete(token);
          unixServers.delete(unix);
          await new Promise<void>((resolve) => unix.close(() => resolve()));
          fs.rmSync(socketPath, { force: true });
        },
      };
      sessions.set(token, s);
      return s;
    },
    async close() {
      for (const u of unixServers) u.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
