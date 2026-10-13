// End-to-end envelopes between Aurora instances. node:crypto only, no dependencies.
//
// Each instance has two long-term keys: Ed25519 to sign and X25519 to receive. A message is
// signed by the sender, then sealed to the recipient with a fresh ephemeral X25519 key:
//
//   key   = HKDF-SHA256(ECDH(ephemeral, recipient.enc), salt = eph || recipient.enc, info = "aurora-env-v1")
//   ct    = AES-256-GCM(key, iv, pad(inner), aad = "aurora-env-v1|" || to || "|" || eph)
//   inner = { s: sender sign key, e: sender enc key, b: body bytes, g: Ed25519 signature }
//   g     = Sign("aurora-msg-v1\0" || recipient fingerprint || "\0" || body bytes)
//
// The signature names the recipient, so a friend cannot forward a signed message to a third
// person as if it had been written to them. The body carries a random id and a timestamp; the
// receiver refuses timestamps outside its window and ids it has already seen (replay).
// Plaintext is padded to fixed buckets so the relay learns little from sizes.
//
// Mailboxes: two friends derive a shared secret from their static X25519 keys. The address a
// message is posted to rotates weekly and differs per direction. Posting needs only the mailbox
// id; fetching needs its preimage (the fetch token), which only the two friends can compute.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export interface Identity {
  /** Raw 32-byte public keys and private scalars, base64url. */
  signPub: string;
  signPriv: string;
  encPub: string;
  encPriv: string;
}

export interface PublicKeys {
  signPub: string;
  encPub: string;
}

export interface Envelope {
  v: 1;
  to: string;
  eph: string;
  iv: string;
  ct: string;
}

export interface Body {
  id: string;
  ts: number;
  type: string;
  payload: unknown;
}

export interface Opened {
  from: PublicKeys & { fp: string };
  body: Body;
}

export interface ReplayStore {
  seen(id: string): boolean;
  remember(id: string, ts: number): void;
}

export class EnvelopeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export const WINDOW_PAST_MS = 14 * 24 * 3600_000;
export const WINDOW_FUTURE_MS = 5 * 60_000;
export const PAD_BUCKETS = [1024, 4096, 16384, 65536, 262144];
export const MAX_PLAINTEXT = PAD_BUCKETS[PAD_BUCKETS.length - 1] - 4;
const ENV_INFO = 'aurora-env-v1';
const MSG_CONTEXT = 'aurora-msg-v1\0';

export function isKey(s: unknown): s is string {
  return typeof s === 'string' && KEY_RE.test(s);
}

// ---------------------------------------------------------------- keys

export function generateIdentity(): Identity {
  const s = generateKeyPairSync('ed25519');
  const e = generateKeyPairSync('x25519');
  const sj = s.privateKey.export({ format: 'jwk' });
  const ej = e.privateKey.export({ format: 'jwk' });
  return { signPub: sj.x!, signPriv: sj.d!, encPub: ej.x!, encPriv: ej.d! };
}

const pub = (crv: 'Ed25519' | 'X25519', x: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
const priv = (crv: 'Ed25519' | 'X25519', x: string, d: string): KeyObject => createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' });

/** SHA-256 over both public keys, hex. People compare the grouped form to verify each other. */
export function fingerprint(k: PublicKeys): string {
  return createHash('sha256').update(unb64(k.signPub)).update(unb64(k.encPub)).digest('hex');
}

/** "3f2a 91c0 …": the first 16 bytes in groups of four hex digits, enough to compare by eye. */
export function groupFingerprint(fp: string): string {
  return fp.slice(0, 32).match(/.{4}/g)!.join(' ');
}

// ---------------------------------------------------------------- padding

export function pad(data: Buffer): Buffer {
  if (data.length > MAX_PLAINTEXT) throw new EnvelopeError('too_large', `Message too large (${data.length} bytes, limit ${MAX_PLAINTEXT})`);
  const size = PAD_BUCKETS.find((b) => b >= data.length + 4)!;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(data.length, 0);
  data.copy(out, 4);
  return out;
}

export function unpad(buf: Buffer): Buffer {
  if (buf.length < 4 || !PAD_BUCKETS.includes(buf.length)) throw new EnvelopeError('bad_padding', 'Bad padding');
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) throw new EnvelopeError('bad_padding', 'Bad padding');
  return buf.subarray(4, 4 + n);
}

// ---------------------------------------------------------------- seal / open

function envKey(shared: Buffer, eph: string, recipientEnc: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([unb64(eph), unb64(recipientEnc)]), ENV_INFO, 32));
}

function signedBytes(recipientFp: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(MSG_CONTEXT + recipientFp + '\0'), body]);
}

export function newBody(type: string, payload: unknown, now = Date.now()): Body {
  return { id: randomUUID(), ts: now, type, payload };
}

/** Sign `body` as `me`, then encrypt it so only `to` can read it, addressed to `mailbox`. */
export function seal(me: Identity, to: PublicKeys, mailbox: string, body: Body): Envelope {
  const bodyBytes = Buffer.from(JSON.stringify(body));
  const sig = sign(null, signedBytes(fingerprint(to), bodyBytes), priv('Ed25519', me.signPub, me.signPriv));
  const inner = Buffer.from(JSON.stringify({ s: me.signPub, e: me.encPub, b: b64(bodyBytes), g: b64(sig) }));
  const plain = pad(inner);
  const ephPair = generateKeyPairSync('x25519');
  const eph = ephPair.publicKey.export({ format: 'jwk' }).x!;
  const shared = diffieHellman({ privateKey: ephPair.privateKey, publicKey: pub('X25519', to.encPub) });
  const key = envKey(shared, eph, to.encPub);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${ENV_INFO}|${mailbox}|${eph}`));
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, to: mailbox, eph, iv: b64(iv), ct: b64(ct) };
}

export function parseEnvelope(x: unknown): Envelope {
  const e = x as Envelope;
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.to !== 'string' || !isKey(e.eph) || typeof e.iv !== 'string' || typeof e.ct !== 'string')
    throw new EnvelopeError('malformed', 'Malformed envelope');
  if (e.to.length > 64 || e.iv.length !== 16 || e.ct.length > 360_000) throw new EnvelopeError('malformed', 'Malformed envelope');
  return { v: 1, to: e.to, eph: e.eph, iv: e.iv, ct: e.ct };
}

/**
 * Decrypt, verify and replay-check an envelope. Throws EnvelopeError on any failure: wrong key,
 * tampering, bad signature, a signature meant for someone else, a stale timestamp or a replay.
 * The id is remembered only after everything else passed.
 */
export function open(me: Identity, raw: unknown, replay: ReplayStore, now = Date.now()): Opened {
  const env = parseEnvelope(raw);
  let plain: Buffer;
  try {
    const shared = diffieHellman({ privateKey: priv('X25519', me.encPub, me.encPriv), publicKey: pub('X25519', env.eph) });
    const key = envKey(shared, env.eph, me.encPub);
    const ct = unb64(env.ct);
    if (ct.length < 17) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(env.iv));
    decipher.setAAD(Buffer.from(`${ENV_INFO}|${env.to}|${env.eph}`));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  } catch {
    throw new EnvelopeError('decrypt', 'Could not decrypt (wrong key or tampered)');
  }
  let inner: { s: string; e: string; b: string; g: string };
  try {
    inner = JSON.parse(unpad(plain).toString('utf8'));
  } catch {
    throw new EnvelopeError('malformed', 'Malformed message');
  }
  if (!isKey(inner?.s) || !isKey(inner?.e) || typeof inner.b !== 'string' || typeof inner.g !== 'string') throw new EnvelopeError('malformed', 'Malformed message');
  const bodyBytes = unb64(inner.b);
  const myFp = fingerprint(me);
  let ok = false;
  try {
    ok = verify(null, signedBytes(myFp, bodyBytes), pub('Ed25519', inner.s), unb64(inner.g));
  } catch {
    ok = false;
  }
  if (!ok) throw new EnvelopeError('signature', 'Bad signature');
  let body: Body;
  try {
    body = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    throw new EnvelopeError('malformed', 'Malformed body');
  }
  if (!body || typeof body.id !== 'string' || body.id.length > 64 || typeof body.ts !== 'number' || typeof body.type !== 'string') throw new EnvelopeError('malformed', 'Malformed body');
  if (body.ts < now - WINDOW_PAST_MS || body.ts > now + WINDOW_FUTURE_MS) throw new EnvelopeError('stale', 'Message timestamp outside the accepted window');
  if (replay.seen(body.id)) throw new EnvelopeError('replay', 'Message already received');
  replay.remember(body.id, body.ts);
  const from = { signPub: inner.s, encPub: inner.e };
  return { from: { ...from, fp: fingerprint(from) }, body };
}

/** In-memory replay store, for tests and the relay-less path. Forgets ids older than the window. */
export class MemoryReplay implements ReplayStore {
  private ids = new Map<string, number>();
  seen(id: string) {
    return this.ids.has(id);
  }
  remember(id: string, ts: number) {
    this.ids.set(id, ts);
    const cutoff = Date.now() - WINDOW_PAST_MS - 86400_000;
    if (this.ids.size > 10_000) for (const [k, t] of this.ids) if (t < cutoff) this.ids.delete(k);
  }
}

// ---------------------------------------------------------------- mailboxes

export const EPOCH_MS = 7 * 24 * 3600_000;
export const epochOf = (now = Date.now()) => Math.floor(now / EPOCH_MS);

/** Shared secret between two friends from their static X25519 keys. Both sides get the same bytes. */
export function pairwiseBase(me: Identity, them: PublicKeys): Buffer {
  const shared = diffieHellman({ privateKey: priv('X25519', me.encPub, me.encPriv), publicKey: pub('X25519', them.encPub) });
  const fps = [fingerprint(me), fingerprint(them)].sort().join('|');
  return Buffer.from(hkdfSync('sha256', shared, 'aurora-pair-v1', fps, 32));
}

/** The secret a recipient presents to the relay to fetch; its hash is the public mailbox id. */
export function fetchToken(base: Buffer, recipientFp: string, epoch: number): string {
  return b64(createHmac('sha256', base).update(`mbox|${recipientFp}|${epoch}`).digest());
}

export function mailboxId(token: string): string {
  return b64(createHash('sha256').update(unb64(token)).digest());
}

/** Invite mailbox: derived from the one-time invite secret, so only the invitee can find it. */
export function inviteToken(inviteSecret: string): string {
  return b64(Buffer.from(hkdfSync('sha256', unb64(inviteSecret), 'aurora-invite-v1', 'mbox', 32)));
}

/** Proof that a hello came from someone holding the invite, bound to their own keys. */
export function inviteProof(inviteSecret: string, senderFp: string): string {
  return b64(createHmac('sha256', unb64(inviteSecret)).update(`proof|${senderFp}`).digest());
}

export const randomSecret = () => b64(randomBytes(16));
