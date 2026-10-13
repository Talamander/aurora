// Owner lock: passkeys (WebAuthn) first, a recovery code as the fallback, and cookie sessions.
//
// The lock is required on a hosted instance (SR_CLOUD=1) and when the server is bound to the
// network without SR_TRUST_NETWORK. On localhost it is optional and off until the owner turns it
// on in Settings. There are no passwords and no email.
//
// WebAuthn is verified here with node:crypto only: attestation "none", ES256 and RS256 keys, and
// the usual checks (challenge, origin, rpId hash, user presence, signature counter).
//
// Sessions are an opaque random id in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS).
// Only a SHA-256 of the id is stored. The existing CSRF defences in main.ts (exact JSON media type
// plus the Origin allowlist) still run on every write; SameSite=Strict keeps the cookie off
// cross-site requests on top of that, so the cookie adds no new way in.

import { createHash, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { isLoopbackAddress } from './devices.ts';

type JsonWebKey = { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string };
const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown;
type RouteFn = (method: string, path: string, handler: Handler) => void;
type SecretStore = { getSecret(key: string): string | null; setSecret(key: string, value: string | null): void };

export const IDLE_MS = 7 * 24 * 3600_000;
export const ABSOLUTE_MS = 30 * 24 * 3600_000;
const CHALLENGE_MS = 5 * 60_000;
const SEEN_WRITE_MS = 5 * 60_000;
const ATTEMPTS_PER_MIN = 10;
const MAX_SESSIONS = 50;
const MAX_PASSKEYS = 20;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const K_STATE = 'lock.state';
const K_PASSKEYS = 'lock.passkeys';
const K_SESSIONS = 'lock.sessions';

// ------------------------------------------------------------------ small helpers

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: unknown): Buffer => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('Not base64url');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Crockford base32 without I, L, O, U: easy to read aloud and to type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
/** A human code: `bytes` of randomness in groups of four characters. */
export function humanCode(bytes: number): string {
  return base32(randomBytes(bytes)).match(/.{1,4}/g)!.join('-');
}
/** Uppercases, drops separators and maps look-alike letters, so typos in case or dashes do not matter. */
export function normalizeCode(s: unknown): string {
  return String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

// ------------------------------------------------------------------ CBOR (just enough for WebAuthn)

export function cborDecode(buf: Buffer): { value: unknown; end: number } {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('CBOR truncated');
  };
  function length(info: number): number {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[pos++]; }
    if (info === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer too large');
      return Number(v);
    }
    throw new Error('CBOR indefinite lengths are not supported');
  }
  function item(depth: number): unknown {
    if (depth > 16) throw new Error('CBOR nested too deep');
    need(1);
    const head = buf[pos++];
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0: return length(info);
      case 1: return -1 - length(info);
      case 2: { const n = length(info); need(n); const v = buf.subarray(pos, pos + n); pos += n; return Buffer.from(v); }
      case 3: { const n = length(info); need(n); const v = buf.toString('utf8', pos, pos + n); pos += n; return v; }
      case 4: { const n = length(info); if (n > 1000) throw new Error('CBOR array too long'); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: {
        const n = length(info);
        if (n > 1000) throw new Error('CBOR map too long');
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); }
        return m;
      }
      case 6: length(info); return item(depth + 1); // tag: ignore it, keep the value
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error('CBOR floats are not supported');
    }
    throw new Error('CBOR bad major type');
  }
  const value = item(0);
  return { value, end: pos };
}

// ------------------------------------------------------------------ authenticator data and keys

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  up: boolean;
  uv: boolean;
  signCount: number;
  credentialId?: Buffer;
  cose?: Map<unknown, unknown>;
}

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error('Authenticator data too short');
  const flags = data[32];
  const out: AuthData = { rpIdHash: data.subarray(0, 32), flags, up: !!(flags & 0x01), uv: !!(flags & 0x04), signCount: data.readUInt32BE(33) };
  if (flags & 0x40) {
    if (data.length < 55) throw new Error('Attested credential data too short');
    const idLen = data.readUInt16BE(53);
    if (idLen > 1023 || data.length < 55 + idLen) throw new Error('Bad credential id length');
    out.credentialId = data.subarray(55, 55 + idLen);
    const { value } = cborDecode(data.subarray(55 + idLen));
    if (!(value instanceof Map)) throw new Error('Credential public key is not a COSE map');
    out.cose = value;
  }
  return out;
}

export type Alg = -7 | -257;

/** COSE_Key to a JWK node:crypto can import. Only ES256 (P-256) and RS256 are accepted. */
export function coseToJwk(cose: Map<unknown, unknown>): { alg: Alg; jwk: JsonWebKey } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('Unsupported EC key (P-256 only)');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw new Error('Unsupported RSA key (2048 bits or more)');
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  throw new Error('Unsupported key type (ES256 or RS256 only)');
}

function keyFor(jwk: JsonWebKey): KeyObject {
  return createPublicKey({ key: jwk as import('node:crypto').JsonWebKeyInput['key'], format: 'jwk' });
}

export function verifySignature(alg: Alg, jwk: JsonWebKey, data: Buffer, sig: Buffer): boolean {
  try {
    const key = keyFor(jwk);
    return alg === -7 ? cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig) : cryptoVerify('sha256', data, key, sig);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ ceremonies

export interface Expected {
  challenge: string; // base64url
  origins: string[];
  rpId: string;
}

function checkClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', exp: Expected) {
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    cd = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('clientDataJSON is not JSON');
  }
  if (cd.type !== type) throw new Error('Wrong ceremony type');
  if (typeof cd.challenge !== 'string' || !sameBytes(Buffer.from(cd.challenge), Buffer.from(exp.challenge))) throw new Error('Challenge does not match');
  if (typeof cd.origin !== 'string' || !exp.origins.includes(cd.origin)) throw new Error('Origin does not match');
  if (cd.crossOrigin === true) throw new Error('Cross-origin ceremonies are refused');
}

export interface RegistrationInput {
  clientDataJSON: string;
  attestationObject: string;
}
export interface VerifiedCredential {
  credentialId: string;
  alg: Alg;
  jwk: JsonWebKey;
  signCount: number;
  uv: boolean;
}

export function verifyRegistration(input: RegistrationInput, exp: Expected): VerifiedCredential {
  const clientData = fromB64u(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.create', exp);
  const { value } = cborDecode(fromB64u(input.attestationObject));
  if (!(value instanceof Map)) throw new Error('attestationObject is not a map');
  if (value.get('fmt') !== 'none') throw new Error('Only attestation "none" is accepted');
  const authDataRaw = value.get('authData');
  if (!Buffer.isBuffer(authDataRaw)) throw new Error('authData missing');
  const ad = parseAuthData(authDataRaw);
  if (!sameBytes(ad.rpIdHash, sha256(exp.rpId))) throw new Error('rpId does not match');
  if (!ad.up) throw new Error('User presence flag not set');
  if (!ad.credentialId || !ad.cose) throw new Error('No credential in authenticator data');
  const { alg, jwk } = coseToJwk(ad.cose);
  keyFor(jwk); // throws on a key that is not on the curve
  return { credentialId: b64u(ad.credentialId), alg, jwk, signCount: ad.signCount, uv: ad.uv };
}

export interface AssertionInput {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Verifies a login assertion against a stored credential. Returns the new signature counter. */
export function verifyAssertion(input: AssertionInput, cred: { alg: Alg; jwk: JsonWebKey; signCount: number }, exp: Expected): { signCount: number; uv: boolean } {
  const clientData = fromB64u(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', exp);
  const authData = fromB64u(input.authenticatorData);
  const ad = parseAuthData(authData);
  if (!sameBytes(ad.rpIdHash, sha256(exp.rpId))) throw new Error('rpId does not match');
  if (!ad.up) throw new Error('User presence flag not set');
  const signed = Buffer.concat([authData, sha256(clientData)]);
  if (!verifySignature(cred.alg, cred.jwk, signed, fromB64u(input.signature))) throw new Error('Signature does not verify');
  // A counter that does not go up means a cloned authenticator. Both zero means the
  // authenticator does not count (synced passkeys), which is allowed.
  if ((ad.signCount !== 0 || cred.signCount !== 0) && ad.signCount <= cred.signCount) throw new Error('Signature counter went backwards');
  return { signCount: ad.signCount, uv: ad.uv };
}

// ------------------------------------------------------------------ recovery code

export async function hashCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(normalizeCode(code), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(h)}`;
}
export async function checkCode(code: string, stored: string | undefined): Promise<boolean> {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored ?? '');
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = await scrypt(normalizeCode(code), Buffer.from(m[4], 'base64url'), want.length, { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), maxmem: SCRYPT.maxmem });
  return sameBytes(got, want);
}

// ------------------------------------------------------------------ which requests need a session

/**
 * Paths that stay open while locked. Everything else under /api/ and every widget needs a
 * session. The lock routes check what they need themselves; the image proxy and the RSS feeds
 * keep their own tokens. Feeds skip the session only once a feed token exists: without one the
 * feed routes accept any direct request, so `?token=anything` would otherwise read the library.
 * The X sign-in callback arrives as a cross-site redirect, which never carries the SameSite=Strict
 * cookie; it is safe to let through because it only acts on a single-use state value minted by
 * /api/x/auth/start, which itself needs a session.
 */
export function lockExempt(method: string, url: URL, opts: { feedToken?: boolean } = {}): boolean {
  const p = url.pathname;
  if (p.startsWith('/api/lock/')) return true;
  if (method === 'GET' && p === '/api/img') return true;
  if (method === 'GET' && p === '/api/x/auth/callback') return true;
  if (method === 'GET' && opts.feedToken && url.searchParams.has('token') && /^\/api\/feeds\/(profile\/|view\/|page\/[^/]+\/)?[^/]+$/.test(p)) return true;
  if (p.startsWith('/api/') || p.startsWith('/widget/')) return false;
  return method === 'GET' || method === 'HEAD'; // the app shell and its assets
}

// ------------------------------------------------------------------ the lock

interface LockState {
  enabled: boolean;
  userId: string;
  recovery?: string;
}
export interface Passkey {
  id: string; // credential id, base64url
  name: string;
  alg: Alg;
  jwk: JsonWebKey;
  signCount: number;
  rpId: string;
  createdAt: string;
  lastUsedAt: string | null;
}
interface SessionRecord {
  id: string; // public id for the Settings list
  hash: string; // sha256 of the cookie value, base64url
  createdAt: number;
  lastSeen: number;
  ua: string;
  ip: string;
}

export interface LockDeps {
  store: SecretStore;
  HttpError: new (status: number, message: string) => Error;
  /** SR_CLOUD=1, or bound to the network without SR_TRUST_NETWORK. */
  required: boolean;
  /** Port, so cookies from Aurora instances on other ports of the same host do not collide. */
  port: number;
  /** Trust X-Forwarded-Proto / X-Forwarded-For (behind a TLS-terminating proxy). */
  trustProxy?: boolean;
  /** Where to keep local.key for the terminal client. */
  dataDir?: string;
  /** Whether a feed token is set (feeds with ?token= may then skip the session). */
  feedTokenSet?: () => boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

export function createLock(deps: LockDeps) {
  const { store, HttpError } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const cookieBase = `aurora_sid_${deps.port}`;
  const challenges = new Map<string, { kind: 'create' | 'get'; rpId: string; origin: string; expires: number }>();
  const attempts = new Map<string, { n: number; at: number }>();
  const seenWrites = new Map<string, number>();
  let setupHash: Buffer | null = null;

  const readJson = <T>(key: string, fallback: T): T => {
    try {
      const v = store.getSecret(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const state = (): LockState | null => readJson<LockState | null>(K_STATE, null);
  const saveState = (s: LockState | null) => store.setSecret(K_STATE, s ? JSON.stringify(s) : null);
  const passkeys = (): Passkey[] => readJson<Passkey[]>(K_PASSKEYS, []);
  const savePasskeys = (l: Passkey[]) => store.setSecret(K_PASSKEYS, l.length ? JSON.stringify(l) : null);
  const sessions = (): SessionRecord[] => readJson<SessionRecord[]>(K_SESSIONS, []);
  const saveSessions = (l: SessionRecord[]) => store.setSecret(K_SESSIONS, l.length ? JSON.stringify(l) : null);

  /** An owner exists once a recovery code has been made (it is made with the first credential). */
  const hasOwner = () => Boolean(state()?.recovery);
  const active = () => deps.required || Boolean(state()?.enabled && hasOwner());

  // ---- local key for the terminal client: a file only this user can read, honoured only from loopback
  let localKey: Buffer | null = null;
  function ensureLocalKey() {
    if (!deps.dataDir || localKey) return;
    const file = join(deps.dataDir, 'local.key');
    try {
      if (existsSync(file)) localKey = Buffer.from(readFileSync(file, 'utf8').trim());
      else {
        const k = b64u(randomBytes(32));
        writeFileSync(file, k + '\n', { mode: 0o600 });
        chmodSync(file, 0o600);
        localKey = Buffer.from(k);
      }
    } catch (e) {
      log(`[lock] Could not prepare local.key for the terminal client: ${(e as Error).message}`);
    }
  }

  // ---- setup token for the first claim
  function issueSetupToken(): string {
    const token = humanCode(10);
    setupHash = sha256(normalizeCode(token));
    return token;
  }
  function setupTokenOk(given: unknown): boolean {
    if (!setupHash || typeof given !== 'string' || !given) return false;
    return sameBytes(sha256(normalizeCode(given)), setupHash);
  }
  if (deps.required && !hasOwner()) {
    const token = issueSetupToken();
    log('[lock] Aurora needs an owner. Open it in a browser and enter this one-time setup token:');
    log(`[lock]   ${token}`);
  }

  // ---- request facts
  function clientIp(req: IncomingMessage): string {
    if (deps.trustProxy) {
      // The proxy appends the address it saw; everything left of that came from the client and
      // can be anything, so only the last entry is trusted (one proxy in front).
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop();
      if (xff) return xff.slice(0, 64);
    }
    return req.socket.remoteAddress ?? '?';
  }
  function isHttps(req: IncomingMessage): boolean {
    if ((req.socket as { encrypted?: boolean }).encrypted) return true;
    return Boolean(deps.trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');
  }
  const cookieName = (req: IncomingMessage) => (isHttps(req) ? `__Host-${cookieBase}` : cookieBase);
  function readCookie(req: IncomingMessage): string | null {
    const raw = req.headers.cookie ?? '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      if (k === cookieBase || k === `__Host-${cookieBase}`) {
        const v = part.slice(i + 1).trim();
        if (/^[A-Za-z0-9_-]{43}$/.test(v)) return v;
      }
    }
    return null;
  }
  function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAgeSec: number) {
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('set-cookie', `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
  }

  function limit(req: IncomingMessage, bucket: string, max = ATTEMPTS_PER_MIN) {
    const key = `${bucket}:${clientIp(req)}`;
    const t = now();
    const hit = attempts.get(key);
    if (hit && t - hit.at < 60_000) {
      if (++hit.n > max) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
    } else attempts.set(key, { n: 1, at: t });
    if (attempts.size > 5000) for (const [k, v] of attempts) if (t - v.at > 60_000) attempts.delete(k);
    // Still huge after the sweep means a flood from many addresses: refuse rather than grow.
    if (attempts.size > 20_000) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  }

  // ---- sessions
  function findSession(req: IncomingMessage): SessionRecord | null {
    const v = readCookie(req);
    if (!v) return null;
    const hash = b64u(sha256(v));
    const t = now();
    const list = sessions();
    const s = list.find((x) => sameBytes(Buffer.from(x.hash), Buffer.from(hash)));
    if (!s) return null;
    if (t - s.lastSeen > IDLE_MS || t - s.createdAt > ABSOLUTE_MS) {
      saveSessions(list.filter((x) => x !== s));
      return null;
    }
    if (t - (seenWrites.get(s.id) ?? s.lastSeen) > SEEN_WRITE_MS) {
      seenWrites.set(s.id, t);
      s.lastSeen = t;
      saveSessions(list);
    }
    return s;
  }
  function startSession(req: IncomingMessage, res: ServerResponse): SessionRecord {
    const value = b64u(randomBytes(32));
    const t = now();
    const rec: SessionRecord = {
      id: randomBytes(6).toString('hex'),
      hash: b64u(sha256(value)),
      createdAt: t,
      lastSeen: t,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
      ip: clientIp(req).slice(0, 64),
    };
    const list = sessions().filter((x) => t - x.lastSeen <= IDLE_MS && t - x.createdAt <= ABSOLUTE_MS);
    list.push(rec);
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    saveSessions(list.slice(0, MAX_SESSIONS));
    setCookie(req, res, value, Math.floor(ABSOLUTE_MS / 1000));
    return rec;
  }
  function endSession(req: IncomingMessage, res: ServerResponse) {
    const s = findSession(req);
    if (s) saveSessions(sessions().filter((x) => x.id !== s.id));
    setCookie(req, res, '', 0);
  }

  /** True when the request carries the terminal client's local key from this computer. */
  function localKeyOk(req: IncomingMessage): boolean {
    const given = req.headers['x-aurora-key'];
    if (!localKey || typeof given !== 'string' || !isLoopbackAddress(req.socket.remoteAddress)) return false;
    return sameBytes(Buffer.from(given.trim()), localKey);
  }

  /** Who may manage the lock: a signed-in owner, or anyone already trusted while the lock is off. */
  function requireOwner(req: IncomingMessage) {
    if (!active()) return;
    if (findSession(req) || localKeyOk(req)) return;
    throw lockedError();
  }
  function lockedError() {
    return Object.assign(new HttpError(401, 'Aurora is locked. Sign in to continue.'), { locked: true });
  }

  /**
   * Runs for local (non-device) requests before any route. Throws a 401 with `locked: true`
   * when the lock is on and the request has no valid session.
   */
  function gate(req: IncomingMessage, url: URL) {
    if (!active()) return;
    if (lockExempt(req.method ?? 'GET', url, { feedToken: deps.feedTokenSet?.() ?? false })) return;
    if (findSession(req) || localKeyOk(req)) return;
    throw lockedError();
  }

  // ---- WebAuthn plumbing
  function expectedFor(req: IncomingMessage): { origin: string; rpId: string } {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origin) throw new HttpError(400, 'Passkeys need a browser request with an Origin header');
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new HttpError(400, 'Bad Origin header');
    }
    const rpId = u.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rpId) || rpId.includes(':') || rpId.startsWith('[')) throw new HttpError(400, 'Passkeys need a host name, not an IP address. Open Aurora at localhost or a domain name, or use the recovery code.');
    return { origin: u.origin, rpId };
  }
  function newChallenge(kind: 'create' | 'get', req: IncomingMessage): { challenge: string; rpId: string } {
    const { origin, rpId } = expectedFor(req);
    const t = now();
    for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
    if (challenges.size > 200) challenges.delete(challenges.keys().next().value!);
    const challenge = b64u(randomBytes(32));
    challenges.set(challenge, { kind, rpId, origin, expires: t + CHALLENGE_MS });
    return { challenge, rpId };
  }
  /** Finds and consumes the challenge named in clientDataJSON. Single use. */
  function takeChallenge(kind: 'create' | 'get', req: IncomingMessage, clientDataJSON: unknown): Expected {
    let challenge = '';
    try {
      challenge = String(JSON.parse(fromB64u(clientDataJSON).toString('utf8')).challenge ?? '');
    } catch {
      throw new HttpError(400, 'Bad passkey response');
    }
    const c = challenges.get(challenge);
    challenges.delete(challenge);
    const { origin, rpId } = expectedFor(req);
    if (!c || c.kind !== kind || c.expires < now() || c.rpId !== rpId || c.origin !== origin) throw new HttpError(400, 'This sign-in attempt expired. Try again.');
    return { challenge, origins: [c.origin], rpId: c.rpId };
  }

  async function makeOwner(): Promise<string> {
    const code = humanCode(20);
    const s = state() ?? { enabled: false, userId: b64u(randomBytes(16)) };
    s.recovery = await hashCode(code);
    saveState(s);
    setupHash = null;
    return code;
  }
  /** May this request add the first credential? */
  function claimAllowed(token: unknown): boolean {
    if (hasOwner()) return false;
    return !deps.required || setupTokenOk(token);
  }
  function mayRegister(req: IncomingMessage, body: any): 'owner' | 'claim' {
    if (hasOwner()) {
      requireOwner(req);
      return 'owner';
    }
    limit(req, 'setup');
    if (!claimAllowed(body?.setupToken)) throw new HttpError(403, deps.required ? 'Setup token missing or wrong. It is printed in the server log.' : 'Not allowed');
    return 'claim';
  }

  const publicPasskey = (p: Passkey) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, rpId: p.rpId });

  function status(req: IncomingMessage) {
    const s = state();
    const on = active();
    const signedIn = Boolean(findSession(req));
    return {
      active: on,
      required: deps.required,
      enabled: Boolean(s?.enabled),
      owner: hasOwner(),
      setupNeeded: deps.required && !hasOwner(),
      signedIn,
      unlocked: !on || signedIn || localKeyOk(req),
      passkeys: passkeys().length,
    };
  }

  function register(route: RouteFn) {
    route('GET', '/api/lock/status', (req) => status(req));

    route('POST', '/api/lock/register/options', (req, _res, _p, body) => {
      const mode = mayRegister(req, body);
      const s = state() ?? { enabled: false, userId: b64u(randomBytes(16)) };
      if (!state()) saveState(s);
      const { challenge, rpId } = newChallenge('create', req);
      return {
        mode,
        publicKey: {
          challenge,
          rp: { id: rpId, name: 'Aurora' },
          user: { id: s.userId, name: 'owner', displayName: 'Aurora owner' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 120_000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          excludeCredentials: passkeys().filter((p) => p.rpId === rpId).map((p) => ({ type: 'public-key', id: p.id })),
        },
      };
    });

    route('POST', '/api/lock/register/verify', async (req, res, _p, body) => {
      const mode = mayRegister(req, body);
      const r = body?.credential?.response ?? {};
      const exp = takeChallenge('create', req, r.clientDataJSON);
      let cred: VerifiedCredential;
      try {
        cred = verifyRegistration({ clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject }, exp);
      } catch (e) {
        throw new HttpError(400, `Passkey not accepted: ${(e as Error).message}`);
      }
      const list = passkeys();
      if (list.some((p) => p.id === cred.credentialId)) throw new HttpError(409, 'This passkey is already added');
      if (list.length >= MAX_PASSKEYS) throw new HttpError(400, `Up to ${MAX_PASSKEYS} passkeys`);
      const name = String(body?.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || guessDevice(String(req.headers['user-agent'] ?? ''));
      list.push({ id: cred.credentialId, name, alg: cred.alg, jwk: cred.jwk, signCount: cred.signCount, rpId: exp.rpId, createdAt: new Date(now()).toISOString(), lastUsedAt: null });
      savePasskeys(list);
      let recoveryCode: string | undefined;
      if (mode === 'claim') {
        recoveryCode = await makeOwner();
        startSession(req, res);
        log('[lock] Owner claimed with a passkey.');
      } else if (!findSession(req)) startSession(req, res); // lock off: keep this browser signed in for later
      return { ok: true, recoveryCode, passkey: publicPasskey(list[list.length - 1]) };
    });

    // First claim without a passkey (for example when Aurora is reached by IP address).
    route('POST', '/api/lock/setup/recovery', async (req, res, _p, body) => {
      if (hasOwner()) throw new HttpError(409, 'Aurora already has an owner');
      limit(req, 'setup');
      if (!claimAllowed(body?.setupToken)) throw new HttpError(403, 'Setup token missing or wrong. It is printed in the server log.');
      const recoveryCode = await makeOwner();
      startSession(req, res);
      log('[lock] Owner claimed with a recovery code.');
      return { ok: true, recoveryCode };
    });

    route('POST', '/api/lock/login/options', (req) => {
      limit(req, 'options', 30);
      const { challenge, rpId } = newChallenge('get', req);
      return {
        publicKey: {
          challenge,
          rpId,
          timeout: 120_000,
          userVerification: 'preferred',
          allowCredentials: passkeys().filter((p) => p.rpId === rpId).map((p) => ({ type: 'public-key', id: p.id })),
        },
      };
    });

    route('POST', '/api/lock/login/verify', (req, res, _p, body) => {
      limit(req, 'login');
      const c = body?.credential ?? {};
      const r = c.response ?? {};
      const exp = takeChallenge('get', req, r.clientDataJSON);
      const list = passkeys();
      const pk = list.find((p) => p.id === c.id && p.rpId === exp.rpId);
      if (!pk) throw new HttpError(401, 'This passkey is not registered with Aurora');
      let out: { signCount: number };
      try {
        out = verifyAssertion({ clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature }, pk, exp);
      } catch (e) {
        throw new HttpError(401, `Sign-in refused: ${(e as Error).message}`);
      }
      pk.signCount = out.signCount;
      pk.lastUsedAt = new Date(now()).toISOString();
      savePasskeys(list);
      startSession(req, res);
      return { ok: true };
    });

    route('POST', '/api/lock/login/recovery', async (req, res, _p, body) => {
      limit(req, 'login');
      const ok = await checkCode(String(body?.code ?? ''), state()?.recovery);
      if (!ok) throw new HttpError(401, 'That recovery code is not right');
      startSession(req, res);
      log('[lock] Signed in with the recovery code.');
      return { ok: true };
    });

    route('POST', '/api/lock/logout', (req, res) => {
      endSession(req, res);
      // Library chunks are cached privately by the browser; drop them with the session so the
      // next person at a shared computer cannot read them out of the cache.
      res.setHeader('clear-site-data', '"cache"');
      return { ok: true };
    });

    route('GET', '/api/lock/sessions', (req) => {
      requireOwner(req);
      const cur = findSession(req);
      const t = now();
      return {
        sessions: sessions()
          .filter((s) => t - s.lastSeen <= IDLE_MS && t - s.createdAt <= ABSOLUTE_MS)
          .map((s) => ({ id: s.id, createdAt: new Date(s.createdAt).toISOString(), lastSeenAt: new Date(s.lastSeen).toISOString(), device: guessDevice(s.ua), ip: s.ip, current: s.id === cur?.id })),
      };
    });

    route('POST', '/api/lock/sessions/others', (req) => {
      requireOwner(req);
      const cur = findSession(req);
      const before = sessions().length;
      saveSessions(sessions().filter((s) => s.id === cur?.id));
      return { ok: true, signedOut: before - (cur ? 1 : 0) };
    });

    route('DELETE', '/api/lock/sessions/:id', (req, _res, p) => {
      requireOwner(req);
      saveSessions(sessions().filter((s) => s.id !== p.id));
      return { ok: true };
    });

    route('GET', '/api/lock/passkeys', (req) => {
      requireOwner(req);
      return { passkeys: passkeys().map(publicPasskey) };
    });

    route('DELETE', '/api/lock/passkeys/:id', (req, _res, p) => {
      requireOwner(req);
      savePasskeys(passkeys().filter((k) => k.id !== p.id));
      return { ok: true };
    });

    route('POST', '/api/lock/recovery', async (req) => {
      requireOwner(req);
      if (!hasOwner()) throw new HttpError(400, 'Set up sign-in first');
      return { recoveryCode: await makeOwner() };
    });

    route('PUT', '/api/lock/enabled', (req, res, _p, body) => {
      requireOwner(req);
      if (deps.required) throw new HttpError(400, 'The lock is always on for this server (hosted or on the network).');
      const s = state();
      if (!s || !hasOwner()) throw new HttpError(400, 'Add a passkey or a recovery code first');
      s.enabled = body?.enabled === true;
      saveState(s);
      if (s.enabled) {
        ensureLocalKey();
        if (!findSession(req)) startSession(req, res);
      }
      log(`[lock] Sign-in on this computer is now ${s.enabled ? 'required' : 'off'}.`);
      return status(req);
    });
  }

  /** Clears the owner, passkeys and sessions (SR_RESET_LOCK=1 at startup). */
  function reset() {
    saveState(null);
    savePasskeys([]);
    saveSessions([]);
    log('[lock] Lock reset: owner, passkeys and sessions removed.');
    if (deps.required) {
      const token = issueSetupToken();
      log(`[lock] New setup token: ${token}`);
    }
  }

  if (active()) ensureLocalKey();

  return { active, required: deps.required, gate, register, status, reset, issueSetupToken, startSession, findSession };
}

function guessDevice(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Electron|Aurora/.test(ua) ? 'Aurora app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Terminal';
  return `${app} on ${os}`;
}
