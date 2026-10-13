// The friend-to-friend envelope: a valid message opens; tampering, replay, a wrong key, a
// forwarded message, a forged sender and stale timestamps all fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, diffieHellman, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import {
  EnvelopeError,
  MemoryReplay,
  WINDOW_PAST_MS,
  fetchToken,
  fingerprint,
  generateIdentity,
  mailboxId,
  newBody,
  open,
  pad,
  pairwiseBase,
  seal,
  unpad,
  type Envelope,
} from '../server/social/crypto.ts';

const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();
const MBOX = 'mailbox-1';

const fails = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof EnvelopeError && e.code === code, `expected ${code}`);

function flip(s: string, at: number): string {
  const b = Buffer.from(s, 'base64url');
  b[at % b.length] ^= 0x01;
  return b.toString('base64url');
}

test('a sealed message opens for its recipient with the sender identified', () => {
  const body = newBody('share', { note: 'look at this' });
  const env = seal(alice, bob, MBOX, body);
  const out = open(bob, env, new MemoryReplay());
  assert.deepEqual(out.body, body);
  assert.equal(out.from.signPub, alice.signPub);
  assert.equal(out.from.fp, fingerprint(alice));
});

test('the envelope hides the plaintext and pads to a bucket', () => {
  const env = seal(alice, bob, MBOX, newBody('share', { note: 'secret words' }));
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.equal(Buffer.from(env.ct, 'base64url').length, 1024 + 16);
  assert.deepEqual(unpad(pad(Buffer.from('abc'))), Buffer.from('abc'));
});

test('tampering with any part of the envelope fails', () => {
  const env = seal(alice, bob, MBOX, newBody('share', { note: 'x' }));
  for (let i = 0; i < 40; i++) fails(() => open(bob, { ...env, ct: flip(env.ct, i * 37) }, new MemoryReplay()), 'decrypt');
  fails(() => open(bob, { ...env, iv: flip(env.iv, 3) }, new MemoryReplay()), 'decrypt');
  fails(() => open(bob, { ...env, eph: carol.encPub }, new MemoryReplay()), 'decrypt');
  // The mailbox is authenticated data: moving the envelope to another mailbox breaks it.
  fails(() => open(bob, { ...env, to: 'mailbox-2' }, new MemoryReplay()), 'decrypt');
  fails(() => open(bob, { ...env, ct: env.ct.slice(0, 10) }, new MemoryReplay()), 'decrypt');
  fails(() => open(bob, { v: 2 }, new MemoryReplay()), 'malformed');
});

test('a replayed message fails the second time', () => {
  const replay = new MemoryReplay();
  const env = seal(alice, bob, MBOX, newBody('reply', { text: 'hi' }));
  open(bob, env, replay);
  fails(() => open(bob, env, replay), 'replay');
  // Re-sealing the same body (same id) in a fresh envelope is still a replay.
  const body = newBody('reply', { text: 'again' });
  open(bob, seal(alice, bob, MBOX, body), replay);
  fails(() => open(bob, seal(alice, bob, MBOX, body), replay), 'replay');
});

test('timestamps outside the window fail', () => {
  const now = Date.now();
  fails(() => open(bob, seal(alice, bob, MBOX, newBody('x', {}, now - WINDOW_PAST_MS - 1000)), new MemoryReplay(), now), 'stale');
  fails(() => open(bob, seal(alice, bob, MBOX, newBody('x', {}, now + 10 * 60_000)), new MemoryReplay(), now), 'stale');
});

test('the wrong recipient key cannot open it', () => {
  const env = seal(alice, bob, MBOX, newBody('share', {}));
  fails(() => open(carol, env, new MemoryReplay()), 'decrypt');
  fails(() => open(alice, env, new MemoryReplay()), 'decrypt');
});

test('a message signed for one friend cannot be forwarded to another', () => {
  // Bob re-encrypts Alice's signed inner message to Carol. The signature names Bob, so Carol refuses it.
  const env = seal(alice, bob, MBOX, newBody('share', { note: 'for bob only' }));
  const forged = forwardInner(bob, env, carol);
  fails(() => open(carol, forged, new MemoryReplay()), 'signature');
});

test('a forged sender key fails the signature check', () => {
  const env = seal(alice, bob, MBOX, newBody('share', {}));
  const forged = rewriteInner(bob, env, (inner) => ({ ...inner, s: carol.signPub, e: carol.encPub }));
  fails(() => open(bob, forged, new MemoryReplay()), 'signature');
});

test('both friends derive the same rotating mailbox; others cannot', () => {
  const ab = pairwiseBase(alice, bob);
  const ba = pairwiseBase(bob, alice);
  assert.deepEqual(ab, ba);
  const tokenForBob = fetchToken(ab, fingerprint(bob), 100);
  assert.equal(tokenForBob, fetchToken(ba, fingerprint(bob), 100));
  assert.notEqual(tokenForBob, fetchToken(ab, fingerprint(alice), 100), 'each direction has its own mailbox');
  assert.notEqual(tokenForBob, fetchToken(ab, fingerprint(bob), 101), 'mailboxes rotate per epoch');
  assert.notEqual(mailboxId(tokenForBob), tokenForBob);
  assert.notDeepEqual(pairwiseBase(carol, bob), ab);
});

// ---- helpers that decrypt with a known key and re-encrypt, to build attacker-made envelopes

function decryptInner(me: typeof bob, env: Envelope): any {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: me.encPub, d: me.encPriv }, format: 'jwk' }),
    publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: env.eph }, format: 'jwk' }),
  });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([Buffer.from(env.eph, 'base64url'), Buffer.from(me.encPub, 'base64url')]), 'aurora-env-v1', 32));
  const ct = Buffer.from(env.ct, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64url'));
  d.setAAD(Buffer.from(`aurora-env-v1|${env.to}|${env.eph}`));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(unpad(plain).toString('utf8'));
}

function encryptInner(inner: unknown, to: typeof carol, mailbox: string): Envelope {
  const pair = generateKeyPairSync('x25519');
  const eph = pair.publicKey.export({ format: 'jwk' }).x!;
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: to.encPub }, format: 'jwk' }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([Buffer.from(eph, 'base64url'), Buffer.from(to.encPub, 'base64url')]), 'aurora-env-v1', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`aurora-env-v1|${mailbox}|${eph}`));
  const ct = Buffer.concat([c.update(pad(Buffer.from(JSON.stringify(inner)))), c.final(), c.getAuthTag()]);
  return { v: 1, to: mailbox, eph, iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

function forwardInner(holder: typeof bob, env: Envelope, to: typeof carol): Envelope {
  return encryptInner(decryptInner(holder, env), to, MBOX);
}

function rewriteInner(holder: typeof bob, env: Envelope, fn: (inner: any) => any): Envelope {
  return encryptInner(fn(decryptInner(holder, env)), holder, MBOX);
}
