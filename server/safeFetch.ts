// SSRF-resistant HTTP client used by every connector that fetches a user-supplied URL.
//
// - Only http: and https: URLs, never with credentials in the URL.
// - Every hostname is resolved and *all* resolved addresses must be public. The
//   check runs inside the socket's DNS lookup hook, so the address that gets
//   validated is the address that gets connected to (this closes the usual
//   DNS-rebinding window for the connection itself). IP literals are checked
//   directly because Node skips the lookup hook for them.
// - Redirects are followed manually (max 4) and each hop is re-validated.
// - Timeout (default 15 s) covers the whole request including redirects.
// - Response bodies are capped (default 8 MB, measured after decompression).
//
// Known limitation: HTTP proxies configured via environment variables are not
// used; requests always go direct.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import type { SafeFetch, SafeFetchOptions, SafeFetchResult } from './connectors/types.ts';

export const USER_AGENT = 'SocialReader/0.1 (+local personal reader)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export class SafeFetchError extends Error {
  code: string;
  constructor(message: string, code = 'SAFE_FETCH') {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIPv4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Expand an IPv6 address (optionally with embedded IPv4 tail) into 8 16-bit groups. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const v4tail = s.slice(lastColon + 1);
  if (v4tail.includes('.')) {
    const v4 = parseIPv4(v4tail);
    if (!v4) return null;
    const hex = (((v4[0] << 8) | v4[1]).toString(16)) + ':' + (((v4[2] << 8) | v4[3]).toString(16));
    s = s.slice(0, lastColon + 1) + hex;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (!h) return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  const want = 8;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/**
 * True when an IP address must not be fetched: loopback, private, link-local,
 * CGNAT, unspecified, multicast, reserved, unique-local IPv6, and IPv4-mapped /
 * NAT64 / 6to4 forms of those. Unparseable input counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const raw = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(raw);
  if (v4) return isPrivateIPv4(v4);
  const g = parseIPv6(raw);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(embedded(g[6], g[7]));
  // IPv4-translated ::ffff:0:a.b.c.d
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(embedded(g[6], g[7]));
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embedded(g[6], g[7]));
  // 6to4 2002::/16 embeds an IPv4 address in groups 1-2
  if (g[0] === 0x2002) return isPrivateIPv4(embedded(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only 100::/64
  return false;
}

function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError('Invalid URL', 'BAD_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError(`Blocked URL scheme "${u.protocol}"`, 'BAD_SCHEME');
  if (u.username || u.password) throw new SafeFetchError('URLs with embedded credentials are not allowed', 'CREDENTIALS');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new SafeFetchError('URL has no host', 'BAD_URL');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SafeFetchError(`Blocked host "${host}" (local network)`, 'PRIVATE_HOST');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new SafeFetchError(`Blocked private address ${host}`, 'PRIVATE_HOST');
  if (!net.isIP(host) && !host.includes('.')) throw new SafeFetchError(`Blocked host "${host}" (not a public domain name)`, 'PRIVATE_HOST');
  return u;
}

/** DNS lookup hook that refuses to hand a private address to the socket. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: unknown, f?: number) => void)(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length) return (callback as (e: Error | null, a: unknown, f?: number) => void)(new SafeFetchError(`No address for ${hostname}`, 'DNS'), '', 0);
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      return (callback as (e: Error | null, a: unknown, f?: number) => void)(
        new SafeFetchError(`Blocked: ${hostname} resolves to a private address (${bad.address})`, 'PRIVATE_HOST'),
        '',
        0,
      );
    }
    if ((options as { all?: boolean }).all) return (callback as (e: Error | null, a: unknown) => void)(null, list);
    return (callback as (e: Error | null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

/** Pre-flight DNS check (all addresses) so errors are clear before a socket opens. */
async function assertPublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return; // already checked in validateUrl
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError(`Could not resolve host ${host}`, 'DNS');
  }
  if (!addrs.length) throw new SafeFetchError(`Could not resolve host ${host}`, 'DNS');
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new SafeFetchError(`Blocked: ${host} resolves to a private address (${bad.address})`, 'PRIVATE_HOST');
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function requestOnce(u: URL, opts: SafeFetchOptions, maxBytes: number, signal: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
    };
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    if (opts.body != null) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = mod.request(
      u,
      { method: opts.method ?? 'GET', headers, lookup: guardedLookup, signal, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        const declared = Number(outHeaders['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new SafeFetchError(`Response too large (${declared} bytes, limit ${maxBytes})`, 'TOO_LARGE'));
          return;
        }
        const enc = (outHeaders['content-encoding'] ?? '').trim().toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const fail = (e: Error) => {
          if (done) return;
          done = true;
          res.destroy();
          reject(e);
        };
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            fail(new SafeFetchError(`Response too large (over ${maxBytes} bytes)`, 'TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          if (done) return;
          done = true;
          resolve({ status, headers: outHeaders, body: Buffer.concat(chunks) });
        });
        stream.on('error', (e: Error) => fail(e));
        res.on('error', (e: Error) => fail(e));
      },
    );
    req.on('error', (e: Error) => reject(e));
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function decodeBody(body: Buffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    // XML prolog or HTML meta charset in the first bytes.
    const head = body.subarray(0, 1024).toString('latin1');
    charset = /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export const safeFetch: SafeFetch = async (url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> => {
  const r = await safeFetchBytes(url, opts);
  return { status: r.status, url: r.url, headers: r.headers, text: decodeBody(r.body, r.headers['content-type'] ?? '') };
};

/** Same guards as safeFetch, but returns the raw body bytes (for images and other binary media). */
export async function safeFetchBytes(url: string, opts: SafeFetchOptions = {}): Promise<{ status: number; url: string; headers: Record<string, string>; body: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = validateUrl(url);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(current);
      const res = await requestOnce(current, { ...opts, method, body }, maxBytes, signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new SafeFetchError(`Too many redirects (limit ${MAX_REDIRECTS})`, 'REDIRECTS');
        let next: string;
        try {
          next = new URL(res.headers.location, current).toString();
        } catch {
          throw new SafeFetchError('Invalid redirect location', 'BAD_URL');
        }
        const nextUrl = validateUrl(next);
        // Do not carry caller-supplied auth headers to a different origin.
        if (nextUrl.origin !== current.origin && opts.headers) {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(opts.headers)) if (!/^(authorization|cookie)$/i.test(k)) h[k] = v;
          opts = { ...opts, headers: h };
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        current = nextUrl;
        continue;
      }
      return { status: res.status, url: current.toString(), headers: res.headers, body: res.body };
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    if (signal.aborted) throw new SafeFetchError(`Request timed out after ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + "s" : timeoutMs + "ms"}`, 'TIMEOUT');
    const err = e as NodeJS.ErrnoException;
    throw new SafeFetchError(`Fetch failed: ${err.code ?? err.message}`, 'NETWORK');
  }
}
