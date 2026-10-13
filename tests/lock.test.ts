// Owner lock: WebAuthn verification with real keys and hand-made authenticator data, sessions
// and their expiry, the first-run setup token, and 401s for unauthenticated API calls.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ABSOLUTE_MS, IDLE_MS, cborDecode, checkCode, createLock, hashCode, lockExempt, normalizeCode, verifyAssertion, verifyRegistration } from '../server/lock.ts';

// ---------------------------------------------------------------- a tiny CBOR encoder for fixtures

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('fixture type');
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');
const RP = 'localhost';
const ORIGIN = 'http://localhost:4400';

function makeKey(kind: 'es256' | 'rs256') {
  if (kind === 'es256') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
    return { privateKey, cose, sign: (data: Buffer) => sign('sha256', data, { key: privateKey, dsaEncoding: 'der' }) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const cose = new Map<unknown, unknown>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  return { privateKey: privateKey as KeyObject, cose, sign: (data: Buffer) => sign('sha256', data, privateKey) };
}

function clientData(type: string, challenge: string, origin = ORIGIN) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}
function attestation(key: ReturnType<typeof makeKey>, credId: Buffer, opts: { rpId?: string; flags?: number; fmt?: string } = {}) {
  const counter = Buffer.alloc(4);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([sha(opts.rpId ?? RP), Buffer.from([opts.flags ?? 0x45]), counter, Buffer.alloc(16), idLen, credId, cbor(key.cose)]);
  return cbor(new Map<unknown, unknown>([['fmt', opts.fmt ?? 'none'], ['attStmt', new Map()], ['authData', authData]]));
}
function assertion(key: ReturnType<typeof makeKey>, challenge: string, count: number, opts: { rpId?: string; origin?: string; flags?: number } = {}) {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(count);
  const authData = Buffer.concat([sha(opts.rpId ?? RP), Buffer.from([opts.flags ?? 0x05]), c]);
  const cd = clientData('webauthn.get', challenge, opts.origin);
  return { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(key.sign(Buffer.concat([authData, sha(cd)]))) };
}

for (const kind of ['es256', 'rs256'] as const) {
  test(`WebAuthn ${kind}: register, sign in, and refuse tampering`, () => {
    const key = makeKey(kind);
    const credId = Buffer.from('cred-' + kind);
    const challenge = b64u(Buffer.from('register-challenge-0123456789abcdef'));
    const exp = { challenge, origins: [ORIGIN], rpId: RP };
    const reg = { clientDataJSON: b64u(clientData('webauthn.create', challenge)), attestationObject: b64u(attestation(key, credId)) };
    const cred = verifyRegistration(reg, exp);
    assert.equal(cred.credentialId, b64u(credId));
    assert.equal(cred.alg, kind === 'es256' ? -7 : -257);

    assert.throws(() => verifyRegistration(reg, { ...exp, challenge: b64u(Buffer.from('other')) }), /Challenge/);
    assert.throws(() => verifyRegistration(reg, { ...exp, origins: ['http://evil.test'] }), /Origin/);
    assert.throws(() => verifyRegistration(reg, { ...exp, rpId: 'example.com' }), /rpId/);
    assert.throws(() => verifyRegistration({ ...reg, attestationObject: b64u(attestation(key, credId, { fmt: 'packed' })) }, exp), /attestation/);
    assert.throws(() => verifyRegistration({ ...reg, attestationObject: b64u(attestation(key, credId, { flags: 0x40 })) }, exp), /presence/);
    assert.throws(() => verifyRegistration({ ...reg, clientDataJSON: b64u(clientData('webauthn.get', challenge)) }, exp), /type/);

    const stored = { alg: cred.alg, jwk: cred.jwk, signCount: 0 };
    const ch2 = b64u(Buffer.from('login-challenge-0123456789abcdef'));
    const exp2 = { challenge: ch2, origins: [ORIGIN], rpId: RP };
    const ok = verifyAssertion(assertion(key, ch2, 5), stored, exp2);
    assert.equal(ok.signCount, 5);
    // Synced passkeys report 0 forever; that is fine when the stored counter is 0 too.
    assert.equal(verifyAssertion(assertion(key, ch2, 0), stored, exp2).signCount, 0);
    assert.throws(() => verifyAssertion(assertion(key, ch2, 5), { ...stored, signCount: 5 }, exp2), /counter/);
    assert.throws(() => verifyAssertion(assertion(key, ch2, 3), { ...stored, signCount: 5 }, exp2), /counter/);

    const a = assertion(key, ch2, 6);
    const flipped = Buffer.from(a.authenticatorData, 'base64url');
    flipped[36] ^= 1; // the counter byte, so the signature no longer covers it
    assert.throws(() => verifyAssertion({ ...a, authenticatorData: b64u(flipped) }, stored, exp2), /Signature/);
    assert.throws(() => verifyAssertion(assertion(key, ch2, 7, { origin: 'http://evil.test' }), stored, exp2), /Origin/);
    assert.throws(() => verifyAssertion(assertion(key, ch2, 7, { rpId: 'evil.test' }), stored, exp2), /rpId/);
    assert.throws(() => verifyAssertion(assertion(key, ch2, 7, { flags: 0x04 }), stored, exp2), /presence/);
    assert.throws(() => verifyAssertion(assertion(key, b64u(Buffer.from('stale')), 7), stored, exp2), /Challenge/);
    const other = makeKey(kind);
    assert.throws(() => verifyAssertion(assertion(other, ch2, 8), stored, exp2), /Signature/);
  });
}

test('CBOR decoder handles nesting and refuses truncation', () => {
  const v = cborDecode(cbor(new Map<unknown, unknown>([['a', 1], [-2, Buffer.from([1, 2])], [3, 'x']]))).value as Map<unknown, unknown>;
  assert.equal(v.get('a'), 1);
  assert.deepEqual(v.get(-2), Buffer.from([1, 2]));
  assert.throws(() => cborDecode(Buffer.from([0x5a, 0, 0, 0, 9, 1])), /truncated/);
});

test('recovery codes are scrypt-hashed and forgiving about case and dashes', async () => {
  const stored = await hashCode('ABCD-EFGH-0000');
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('ABCD'));
  assert.equal(await checkCode('abcd efgh oooo', stored), true);
  assert.equal(await checkCode('ABCD-EFGH-0001', stored), false);
  assert.equal(normalizeCode('il-o'), '110');
});

test('only the lock, image proxy, tokened feeds and the app shell skip the session', () => {
  const u = (p: string) => new URL(p, 'http://localhost');
  assert.equal(lockExempt('GET', u('/api/lock/status')), true);
  assert.equal(lockExempt('GET', u('/api/img?u=x&t=y')), true);
  assert.equal(lockExempt('GET', u('/api/feeds/all.xml?token=abc'), { feedToken: true }), true);
  assert.equal(lockExempt('GET', u('/api/feeds/page/p1/all.json?token=abc'), { feedToken: true }), true);
  assert.equal(lockExempt('GET', u('/api/feeds/all.xml?token=abc')), false, 'no feed token set: a feed needs a session');
  assert.equal(lockExempt('GET', u('/api/feeds/all.xml')), false);
  assert.equal(lockExempt('GET', u('/api/feeds?token=abc')), false);
  assert.equal(lockExempt('GET', u('/api/img/config')), false);
  assert.equal(lockExempt('GET', u('/api/library')), false);
  assert.equal(lockExempt('GET', u('/api/events')), false);
  assert.equal(lockExempt('GET', u('/widget/p1/0')), false);
  assert.equal(lockExempt('GET', u('/')), true);
  assert.equal(lockExempt('GET', u('/assets/index.js')), true);
});

// ---------------------------------------------------------------- the lock object with a fake store

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function memStore() {
  const m = new Map<string, string>();
  return { getSecret: (k: string) => m.get(k) ?? null, setSecret: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)), m };
}
function fakeReq(headers: Record<string, string> = {}, method = 'GET'): any {
  return { method, headers: { origin: ORIGIN, 'user-agent': 'test Chrome/1 Linux', ...headers }, socket: { remoteAddress: '127.0.0.1' } };
}
function fakeRes(): any {
  const h: Record<string, string> = {};
  return { h, setHeader: (k: string, v: string) => { h[k] = v; } };
}
const cookieOf = (res: any) => String(res.h['set-cookie']).split(';')[0];

test('sessions expire when idle and at the absolute limit', () => {
  let t = 1_000_000;
  const lock = createLock({ store: memStore(), HttpError, required: true, port: 4400, now: () => t });
  const res = fakeRes();
  lock.startSession(fakeReq(), res);
  const set = String(res.h['set-cookie']);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.doesNotMatch(set, /Secure/); // plain http
  const req = () => fakeReq({ cookie: cookieOf(res) });
  assert.ok(lock.findSession(req()));
  t += IDLE_MS + 1;
  assert.equal(lock.findSession(req()), null, 'idle session should expire');

  const res2 = fakeRes();
  lock.startSession(fakeReq(), res2);
  const req2 = () => fakeReq({ cookie: cookieOf(res2) });
  const start = t;
  while (t - start < ABSOLUTE_MS - 24 * 3600_000) {
    t += 24 * 3600_000;
    assert.ok(lock.findSession(req2()), 'daily use keeps the session alive');
  }
  t += 2 * 24 * 3600_000;
  assert.equal(lock.findSession(req2()), null, 'absolute limit ends it anyway');
});

test('cookies are Secure behind a trusted HTTPS proxy', () => {
  const lock = createLock({ store: memStore(), HttpError, required: true, port: 4400, trustProxy: true });
  const res = fakeRes();
  lock.startSession(fakeReq({ 'x-forwarded-proto': 'https' }), res);
  assert.match(String(res.h['set-cookie']), /^__Host-aurora_sid_4400=.*; Secure$/);
});

test('first claim needs the setup token from the log, once', async () => {
  const logs: string[] = [];
  const store = memStore();
  const lock = createLock({ store, HttpError, required: true, port: 4400, log: (m) => logs.push(m) });
  const token = logs.map((l) => /\[lock\]\s+([0-9A-Z]{4}(-[0-9A-Z]{1,4})+)$/.exec(l)?.[1]).find(Boolean)!;
  assert.ok(token, 'setup token printed');
  const routes = new Map<string, Function>();
  lock.register((m, p, h) => routes.set(`${m} ${p}`, h));
  const claim = routes.get('POST /api/lock/setup/recovery')!;

  // Locked: the API answers 401 with locked: true.
  assert.throws(() => lock.gate(fakeReq(), new URL('http://localhost/api/library')), (e: any) => e.status === 401 && e.locked === true);

  await assert.rejects(Promise.resolve().then(() => claim(fakeReq({}, 'POST'), fakeRes(), {}, { setupToken: 'WRONG-TOKEN' })), (e: any) => e.status === 403);
  const res = fakeRes();
  const out = await claim(fakeReq({}, 'POST'), res, {}, { setupToken: token.toLowerCase() });
  assert.match(out.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  assert.ok(![...store.m.values()].some((v) => v.includes(out.recoveryCode)), 'recovery code is not stored in clear');
  await assert.rejects(Promise.resolve().then(() => claim(fakeReq({}, 'POST'), fakeRes(), {}, { setupToken: token })), (e: any) => e.status === 409);

  // The new session opens the API; the recovery code signs in again later.
  lock.gate(fakeReq({ cookie: cookieOf(res) }), new URL('http://localhost/api/library'));
  const login = routes.get('POST /api/lock/login/recovery')!;
  await assert.rejects(login(fakeReq({}, 'POST'), fakeRes(), {}, { code: 'nope' }), (e: any) => e.status === 401);
  const res2 = fakeRes();
  await login(fakeReq({}, 'POST'), res2, {}, { code: out.recoveryCode });
  lock.gate(fakeReq({ cookie: cookieOf(res2) }), new URL('http://localhost/api/library'));

  // Sign out other sessions keeps only the current one.
  const others = routes.get('POST /api/lock/sessions/others')!;
  assert.deepEqual(others(fakeReq({ cookie: cookieOf(res2) }, 'POST')), { ok: true, signedOut: 1 });
  assert.throws(() => lock.gate(fakeReq({ cookie: cookieOf(res) }), new URL('http://localhost/api/library')), (e: any) => e.status === 401);
});

test('login attempts are rate limited', async () => {
  const lock = createLock({ store: memStore(), HttpError, required: true, port: 4400 });
  const routes = new Map<string, Function>();
  lock.register((m, p, h) => routes.set(`${m} ${p}`, h));
  const login = routes.get('POST /api/lock/login/recovery')!;
  let limited = false;
  for (let i = 0; i < 12; i++) {
    try {
      await login(fakeReq({}, 'POST'), fakeRes(), {}, { code: 'AAAA' });
    } catch (e: any) {
      if (e.status === 429) limited = true;
    }
  }
  assert.ok(limited);
});

// ---------------------------------------------------------------- the real server, locked

const PORT = 5100 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'aurora-lock-test-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('a hosted server answers 401 until the owner claims it', async () => {
  let out = '';
  const child: ChildProcess = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), SOCIAL_READER_DATA: dataDir, AUTO_SYNC_MINUTES: '0', HOST: '127.0.0.1', SR_CLOUD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
      child.stdout!.on('data', (d) => {
        out += String(d);
        if (out.includes(`:${PORT}`)) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    const token = /\[lock\]\s+([0-9A-Z]{4}(?:-[0-9A-Z]{1,4})+)\s*$/m.exec(out)?.[1];
    assert.ok(token, 'setup token in the log');

    const lib = await fetch(`${base}/api/library`);
    assert.equal(lib.status, 401);
    assert.deepEqual(await lib.json(), { error: 'Aurora is locked. Sign in to continue.', locked: true });
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    assert.equal((await fetch(`${base}/api/img/config`)).status, 401);
    const st = await (await fetch(`${base}/api/lock/status`)).json();
    assert.equal(st.setupNeeded, true);
    assert.equal(st.unlocked, false);

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/lock/setup/recovery', { setupToken: token }, { origin: 'http://evil.test' })).status, 403, 'Origin check still applies');
    const claim = await post('/api/lock/setup/recovery', { setupToken: token });
    assert.equal(claim.status, 200);
    const cookie = claim.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, new RegExp(`^aurora_sid_${PORT}=`));

    assert.equal((await fetch(`${base}/api/library`, { headers: { cookie } })).status, 200);
    // The cookie does not get a cross-site write past the Origin check.
    assert.equal((await post('/api/views', { name: 'x' }, { cookie, origin: 'http://evil.test' })).status, 403);
    // Without the cookie, still locked.
    assert.equal((await fetch(`${base}/api/library`)).status, 401);
    // Sign out ends it.
    assert.equal((await post('/api/lock/logout', {}, { cookie })).status, 200);
    assert.equal((await fetch(`${base}/api/library`, { headers: { cookie } })).status, 401);
  } finally {
    await new Promise<void>((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); });
  }
});
