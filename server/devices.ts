// Phones paired with this Aurora. The desktop web app starts a pairing and shows a QR code; the
// phone scans it, claims the pairing with the one-time secret from the code, and waits. Nothing
// is issued until the person approves the phone on this computer. The phone then gets a random
// device token, which it sends as `Authorization: Bearer <token>`. Only a SHA-256 hash of each
// token is kept (in the secrets table), and any device can be revoked from the desktop.
//
// Network rules (enforced in main.ts through gate()):
// - The default bind stays 127.0.0.1. Phones on the LAN can only reach Aurora when HOST is set
//   explicitly to a non-loopback address (with ALLOW_NON_LOCAL=1, as before).
// - In that mode, requests from other machines must carry a valid device token, except the two
//   claim endpoints, which need the one-time secret from the QR code instead. Everything else
//   (the web app, the full API) answers only to this computer, unless SR_TRUST_NETWORK=1 (set in
//   the container image, where the published port is the boundary).
// - Device tokens unlock a reader's subset of the API (DEVICE_ROUTES), never AI keys, sources,
//   sign-in browsers, actors or pairing itself.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import qrcode from './vendor/qrcode.mjs';
import type { Store } from './db.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  hash: string;
  createdAt: string;
  lastSeenAt?: string;
}
export type PublicDevice = Omit<DeviceRecord, 'hash'>;

interface PairSession {
  id: string;
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  claim?: { name: string; platform: string; check: string; keyHash: string; at: number; ip: string };
  state: 'waiting' | 'claimed' | 'approved' | 'denied';
  token?: string;
  deviceId?: string;
}

const SECRET_KEY = 'devices.v1';
const PAIR_TTL_MS = 5 * 60_000;
const APPROVED_TTL_MS = 2 * 60_000;
const MAX_SESSIONS = 4;
const SEEN_WRITE_MS = 5 * 60_000;

/**
 * What a device token may call. Reading, saving and hiding posts, the agent, pages and the
 * edition. Anything that changes sources, keys, sign-ins, actors or devices stays on the desktop.
 */
export const DEVICE_ROUTES: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/(library|events|health|agent\/status|agent\/threads|taste|devices\/me|week)$/ },
  { method: 'GET', path: /^\/api\/agent\/threads\/[^/]+$/ },
  // Fast sync, search and More like this: the library's chunks by key (the manifest is
  // /api/library?items=chunks above), full-text search and related posts. All reads.
  { method: 'GET', path: /^\/api\/library\/chunks\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/search$/ },
  // Time well spent: daily reading totals per profile, read and reported by the phone too.
  { method: 'GET', path: /^\/api\/time$/ },
  { method: 'POST', path: /^\/api\/time\/tick$/ },
  { method: 'GET', path: /^\/api\/items\/[^/]+\/related$/ },
  { method: 'GET', path: /^\/api\/settings\/ui\.[\w.-]+$/ },
  { method: 'GET', path: /^\/api\/archive\/[^/]+(\/[^/]+)?$/ },
  { method: 'POST', path: /^\/api\/(items\/state|agent\/threads|catchup|edition|person\/about|sync)$/ },
  { method: 'POST', path: /^\/api\/agent\/threads\/[^/]+\/(messages|stop)$/ },
  { method: 'POST', path: /^\/api\/sources\/[^/]+\/sync$/ },
  { method: 'POST', path: /^\/api\/archive\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/taste\/[^/]+\/(accept|dismiss)$/ },
  { method: 'DELETE', path: /^\/api\/devices\/me$/ },
  // Pictures through the image proxy, so the phone does not tell image hosts when it looks either.
  // /api/img only serves images already in the library; the config holds nothing but the proxy token.
  { method: 'GET', path: /^\/api\/img(\/config)?$/ },
  // Long-form reading: the article (extracted by the server's SSRF-safe fetcher, for library items
  // only), reading position, the Read later queue and highlights. Not the AI helpers, imports,
  // subscriptions or the EPUB export.
  { method: 'GET', path: /^\/api\/articles\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/articles\/[^/]+\/extract$/ },
  { method: 'PUT', path: /^\/api\/reading\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/(longform\/queue|highlights)$/ },
  { method: 'POST', path: /^\/api\/highlights$/ },
  // Friends: one share's conversation, a reply and a reaction. Never the overview (identity and
  // invites), invites, friend management, circles, setup or sharing new posts out.
  { method: 'GET', path: /^\/api\/social\/thread\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/social\/(reply|react)$/ },
  // Alerts: the phone sees what fired and can mark hits seen. Creating, editing or deleting
  // alerts and changing quiet hours stay on the computer.
  { method: 'GET', path: /^\/api\/alerts\/hits$/ },
  { method: 'POST', path: /^\/api\/alerts\/seen$/ },
  // Routines: the phone reads the list, with each routine's schedule and last run. Writing,
  // planning (an AI call), turning on and running routines stay on the computer.
  { method: 'GET', path: /^\/api\/routines$/ },
];

/** Whether a paired device's token may call this method and path. */
export function deviceMayCall(method: string, path: string): boolean {
  return DEVICE_ROUTES.some((r) => r.method === method && r.path.test(path));
}

/** Endpoints a phone may call before it has a token. Both need the one-time secret from the QR code. */
const CLAIM_ROUTES = new Set(['POST /api/devices/claim', 'POST /api/devices/claim/status']);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const cleanLabel = (v: unknown, fallback: string, max = 60) =>
  (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '') || fallback;

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || /^127\./.test(addr) || /^::ffff:127\./.test(addr);
}
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Private IPv4 addresses of this machine, for the URL in the QR code. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** The QR code as a compact SVG (one path, dark modules on a white quiet zone). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b0d12"/></svg>`;
}

export type GateResult = { kind: 'local' } | { kind: 'device'; device: PublicDevice } | { kind: 'claim' };

export function createDevices(deps: {
  store: Store;
  host: string;
  port: number;
  HttpError: new (status: number, message: string) => Error;
  log?: (msg: string) => void;
  /** When the owner lock is on, other machines reach the sign-in page instead of a 403. */
  lockActive?: () => boolean;
}) {
  const { store, HttpError } = deps;
  /** Phones on the LAN are possible only when HOST was set to a non-loopback address. */
  const lan = !isLoopbackHost(deps.host);
  const trustNetwork = process.env.SR_TRUST_NETWORK === '1';
  const sessions = new Map<string, PairSession>();
  const seenAt = new Map<string, number>();
  const claimHits = new Map<string, { n: number; at: number }>();

  const load = (): DeviceRecord[] => {
    try {
      const v = JSON.parse(store.getSecret(SECRET_KEY) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const save = (list: DeviceRecord[]) => store.setSecret(SECRET_KEY, list.length ? JSON.stringify(list) : null);
  const strip = ({ hash: _h, ...d }: DeviceRecord): PublicDevice => d;

  function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
  }

  /** Looks up a bearer token. Tokens look like aur_<deviceId>_<secret>. */
  function verify(header: string | undefined): DeviceRecord | null {
    const m = /^Bearer\s+(aur_([a-z0-9]{12})_[A-Za-z0-9_-]{32,})\s*$/.exec(header ?? '');
    if (!m) return null;
    const dev = load().find((d) => d.id === m[2]);
    if (!dev || !sameHash(sha256(m[1]), dev.hash)) return null;
    const now = Date.now();
    if (now - (seenAt.get(dev.id) ?? 0) > SEEN_WRITE_MS) {
      seenAt.set(dev.id, now);
      const list = load();
      const row = list.find((d) => d.id === dev.id);
      if (row) {
        row.lastSeenAt = new Date(now).toISOString();
        save(list);
      }
    }
    return dev;
  }

  /**
   * Decides who is asking before any route runs. `hostAllowed` is main.ts's existing Host check
   * (loopback names plus SR_ALLOWED_HOSTS). Throws an HttpError when the request is refused.
   */
  function gate(req: IncomingMessage, res: ServerResponse, url: URL, hostAllowed: boolean): GateResult {
    const method = req.method ?? 'GET';
    const isApi = url.pathname.startsWith('/api/');
    const auth = req.headers.authorization;
    const bearerish = typeof auth === 'string' && /^Bearer\s/i.test(auth);
    const preflight = method === 'OPTIONS' && isApi;
    const corsOk = (bearerish || preflight || CLAIM_ROUTES.has(`${method} ${url.pathname}`)) && (hostAllowed || lan);
    if (corsOk) {
      // Bearer requests carry no ambient credentials, so any origin may make them (the Expo web
      // build in development runs on its own port). Nothing here sets or reads cookies.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('access-control-max-age', '600');
    }
    if (preflight) {
      if (!corsOk) throw new HttpError(421, 'Unknown host');
      res.writeHead(204);
      res.end();
      return { kind: 'claim' };
    }
    if (bearerish) {
      const dev = verify(auth);
      if (!dev) throw new HttpError(401, 'This phone is not paired, or it was unpaired on your computer');
      if (!hostAllowed && !lan) throw new HttpError(421, 'Unknown host');
      if (!isApi || !deviceMayCall(method, url.pathname)) throw new HttpError(403, 'Phones cannot do this. Use Aurora on your computer.');
      return { kind: 'device', device: strip(dev) };
    }
    if (CLAIM_ROUTES.has(`${method} ${url.pathname}`) && (hostAllowed || lan)) {
      const ip = req.socket.remoteAddress ?? '?';
      const now = Date.now();
      const hit = claimHits.get(ip);
      if (hit && now - hit.at < 60_000) {
        if (++hit.n > 30) throw new HttpError(429, 'Too many pairing attempts. Wait a minute.');
      } else claimHits.set(ip, { n: 1, at: now });
      return { kind: 'claim' };
    }
    if (!hostAllowed) throw new HttpError(421, 'Unknown host');
    // Bound to the network: only this computer gets the unauthenticated app and API. With the owner
    // lock on, other machines get through to main.ts, which then asks them to sign in.
    if (lan && !trustNetwork && !deps.lockActive?.() && !isLoopbackAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, 'Only this computer can use Aurora without pairing. Pair a phone from Settings on this computer.');
    }
    return { kind: 'local' };
  }

  function serverUrls(): string[] {
    const extra = (process.env.SR_PUBLIC_URL ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\//.test(s));
    if (!lan) return extra;
    const hosts = deps.host === '0.0.0.0' || deps.host === '::' ? lanAddresses() : [deps.host];
    return [...extra, ...hosts.map((h) => `http://${h.includes(':') ? `[${h}]` : h}:${deps.port}`)];
  }

  function register(route: RouteFn) {
    // ---- desktop side (local only: gate() refuses device tokens here via DEVICE_ROUTES)
    route('GET', '/api/devices', () => ({ devices: load().map(strip), lan, urls: serverUrls() }));

    route('POST', '/api/devices/pair', () => {
      sweep();
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        sessions.delete(oldest.id);
      }
      const id = randomBytes(6).toString('hex');
      const secret = randomBytes(18).toString('base64url');
      const now = Date.now();
      sessions.set(id, { id, secretHash: sha256(secret), createdAt: now, expiresAt: now + PAIR_TTL_MS, state: 'waiting' });
      const name = cleanLabel(hostname(), 'Aurora', 40);
      const options = serverUrls().map((u) => {
        const link = `aurora://pair?v=1&u=${encodeURIComponent(u)}&p=${id}.${secret}&n=${encodeURIComponent(name)}`;
        return { url: u, link, svg: qrSvg(link) };
      });
      return { id, code: `${id}.${secret}`, name, lan, options, expiresAt: new Date(now + PAIR_TTL_MS).toISOString() };
    });

    route('GET', '/api/devices/pair/:id', (_q, _s, p) => {
      sweep();
      const s = sessions.get(p.id);
      if (!s) return { state: 'expired' };
      return { state: s.state, claim: s.claim ? { name: s.claim.name, platform: s.claim.platform, check: s.claim.check } : null, expiresAt: new Date(s.expiresAt).toISOString() };
    });

    route('POST', '/api/devices/pair/:id/approve', (_q, _s, p, body) => {
      sweep();
      const s = sessions.get(p.id);
      if (!s) throw new HttpError(404, 'This pairing expired. Start again.');
      if (s.state !== 'claimed' || !s.claim) throw new HttpError(409, 'No phone has scanned this code yet');
      if (body?.approve !== true) {
        s.state = 'denied';
        s.expiresAt = Date.now() + APPROVED_TTL_MS;
        return { state: s.state };
      }
      const deviceId = randomBytes(6).toString('hex');
      const token = `aur_${deviceId}_${randomBytes(32).toString('base64url')}`;
      const list = load();
      list.push({ id: deviceId, name: s.claim.name, platform: s.claim.platform, hash: sha256(token), createdAt: new Date().toISOString() });
      save(list);
      s.state = 'approved';
      s.token = token;
      s.deviceId = deviceId;
      s.expiresAt = Date.now() + APPROVED_TTL_MS;
      deps.log?.(`devices: paired ${s.claim.name} (${deviceId})`);
      return { state: s.state, device: strip(list[list.length - 1]) };
    });

    route('DELETE', '/api/devices/me', (req) => {
      const dev = verify(req.headers.authorization);
      if (!dev) throw new HttpError(401, 'Not a paired phone');
      save(load().filter((d) => d.id !== dev.id));
      return { ok: true };
    });

    route('GET', '/api/devices/me', (req) => {
      const dev = verify(req.headers.authorization);
      if (!dev) throw new HttpError(401, 'Not a paired phone');
      return { device: strip(dev), server: cleanLabel(hostname(), 'Aurora', 40) };
    });

    route('DELETE', '/api/devices/:id', (_q, _s, p) => {
      const list = load();
      if (!list.some((d) => d.id === p.id)) throw new HttpError(404, 'No such device');
      save(list.filter((d) => d.id !== p.id));
      seenAt.delete(p.id);
      return { ok: true };
    });

    // ---- phone side (before it has a token)
    const session = (pair: unknown): PairSession => {
      sweep();
      const m = /^([a-f0-9]{12})\.([A-Za-z0-9_-]{20,})$/.exec(typeof pair === 'string' ? pair : '');
      const s = m ? sessions.get(m[1]) : undefined;
      if (!s || !m || !sameHash(sha256(m[2]), s.secretHash)) throw new HttpError(404, 'This code expired or is not valid. Show a new one on your computer.');
      return s;
    };

    route('POST', '/api/devices/claim', (req, _s, _p, body) => {
      const s = session(body?.pair);
      if (s.state !== 'waiting') throw new HttpError(409, 'Another phone already scanned this code. Show a new one.');
      const key = randomBytes(24).toString('base64url');
      const check = String(randomInt(0, 10_000)).padStart(4, '0');
      s.claim = { name: cleanLabel(body?.name, 'Phone'), platform: cleanLabel(body?.platform, 'unknown', 20), check, keyHash: sha256(key), at: Date.now(), ip: req.socket.remoteAddress ?? '' };
      s.state = 'claimed';
      return { state: s.state, check, claimKey: key, expiresAt: new Date(s.expiresAt).toISOString() };
    });

    route('POST', '/api/devices/claim/status', (_q, _s, _p, body) => {
      const s = session(body?.pair);
      if (!s.claim || typeof body?.claimKey !== 'string' || !sameHash(sha256(body.claimKey), s.claim.keyHash)) throw new HttpError(403, 'This phone did not claim the code');
      if (s.state === 'approved' && s.token) {
        const token = s.token;
        // Hand the token out exactly once.
        sessions.delete(s.id);
        return { state: 'approved', token, deviceId: s.deviceId, server: cleanLabel(hostname(), 'Aurora', 40) };
      }
      return { state: s.state };
    });
  }

  return { register, gate, verify, deviceMayCall, lan, serverUrls };
}
