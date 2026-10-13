// Browser side of the owner lock: status, passkey ceremonies and recovery codes.
// The server does all verification (server/lock.ts); this only shuttles bytes.

export interface LockStatus {
  active: boolean;
  required: boolean;
  enabled: boolean;
  owner: boolean;
  setupNeeded: boolean;
  signedIn: boolean;
  unlocked: boolean;
  passkeys: number;
}
export interface PasskeyInfo { id: string; name: string; createdAt: string; lastUsedAt: string | null; rpId: string }
export interface SessionInfo { id: string; createdAt: string; lastSeenAt: string; device: string; ip: string; current: boolean }

export async function lockCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const lockStatus = () => lockCall<LockStatus>('GET', '/api/lock/status');

const toBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const toB64u = (buf: ArrayBuffer) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Why passkeys cannot work on this page, or null when they can. */
export function passkeyBlocker(): string | null {
  const host = location.hostname;
  if (!('PublicKeyCredential' in window) || !navigator.credentials) return 'This browser does not support passkeys.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host.startsWith('[')) return 'Passkeys need a host name, not an IP address. Open Aurora at localhost or its domain name, or use the recovery code.';
  if (!window.isSecureContext) return 'Passkeys need HTTPS (or localhost). Use the recovery code here.';
  return null;
}

const HERE = 'aurora.passkeyHere';
/** Remembers that this browser holds a passkey, so the lock screen may offer it without a click. */
function markHere() {
  try { localStorage.setItem(HERE, '1'); } catch { /* storage blocked */ }
}
export function passkeyHere(): boolean {
  try { return localStorage.getItem(HERE) === '1'; } catch { return false; }
}

/** Registers a new passkey. Returns the recovery code when this was the first claim. */
export async function addPasskey(opts: { setupToken?: string; name?: string } = {}): Promise<{ recoveryCode?: string }> {
  const { publicKey } = await lockCall<{ publicKey: any }>('POST', '/api/lock/register/options', { setupToken: opts.setupToken });
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...publicKey,
      challenge: toBytes(publicKey.challenge),
      user: { ...publicKey.user, id: toBytes(publicKey.user.id) },
      excludeCredentials: publicKey.excludeCredentials.map((c: { id: string; type: 'public-key' }) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created');
  const r = cred.response as AuthenticatorAttestationResponse;
  markHere();
  return lockCall('POST', '/api/lock/register/verify', {
    setupToken: opts.setupToken,
    name: opts.name,
    credential: { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) } },
  });
}

export async function signInWithPasskey(): Promise<void> {
  const { publicKey } = await lockCall<{ publicKey: any }>('POST', '/api/lock/login/options', {});
  const cred = (await navigator.credentials.get({
    publicKey: { ...publicKey, challenge: toBytes(publicKey.challenge), allowCredentials: publicKey.allowCredentials.map((c: { id: string; type: 'public-key' }) => ({ ...c, id: toBytes(c.id) })) },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was chosen');
  const r = cred.response as AuthenticatorAssertionResponse;
  await lockCall('POST', '/api/lock/login/verify', {
    credential: { id: cred.id, type: cred.type, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature) } },
  });
  markHere();
}

/** Friendlier words for the browser's WebAuthn errors. */
export function passkeyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for Aurora.';
  if (name === 'SecurityError') return 'The browser refused passkeys on this address.';
  return (e as Error)?.message || 'Something went wrong';
}

/**
 * Watches every same-origin fetch: a 401 marked `locked` means the session ended, so the app
 * swaps to the lock screen instead of showing a pile of errors.
 */
let watching = false;
export function watchForLock() {
  if (watching) return;
  watching = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await orig(...args);
    if (res.status === 401) {
      res.clone().json().then((d) => { if (d?.locked) window.dispatchEvent(new Event('aurora:locked')); }).catch(() => {});
    }
    return res;
  };
}
