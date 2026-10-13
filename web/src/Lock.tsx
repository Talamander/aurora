// The owner lock in the browser: the lock screen (sign in, or claim a new server with the setup
// token from the log) and the "Lock" section in Settings.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { addPasskey, lockCall, lockStatus, passkeyBlocker, passkeyError, passkeyHere, signInWithPasskey, watchForLock, type LockStatus, type PasskeyInfo, type SessionInfo } from './lockClient.ts';
import './lock.css';

const KeyIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.85 12.15 19 4M15 8l3 3M17.5 5.5 20 8" />
  </svg>
);

/** Renders the app only when the lock is off or this browser is signed in. */
export function LockGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<LockStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    watchForLock();
    const refresh = () => lockStatus().then((s) => { setSt(s); setFailed(false); }).catch(() => setFailed(true));
    void refresh();
    addEventListener('aurora:locked', refresh);
    return () => removeEventListener('aurora:locked', refresh);
  }, []);
  if (failed) return <>{children}</>; // older server or offline: let the app show its own errors
  if (!st) return <div className="lk lk-boot" aria-busy="true" />;
  if (!st.unlocked) return <LockScreen status={st} onUnlocked={() => lockStatus().then(setSt).catch(() => setFailed(true))} />;
  return <>{children}</>;
}

function LockScreen({ status, onUnlocked }: { status: LockStatus; onUnlocked: () => void }) {
  const blocker = passkeyBlocker();
  const [mode, setMode] = useState<'passkey' | 'recovery'>(blocker || (!status.setupNeeded && status.passkeys === 0) ? 'recovery' : 'passkey');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState<string | null>(null);
  const tried = useRef(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(passkeyError(e));
    } finally {
      setBusy(false);
    }
  };
  const passkey = () => run(async () => { await signInWithPasskey(); onUnlocked(); });
  const recovery = (e: FormEvent) => { e.preventDefault(); void run(async () => { await lockCall('POST', '/api/lock/login/recovery', { code }); onUnlocked(); }); };
  const claimPasskey = () => run(async () => { const r = await addPasskey({ setupToken: token }); setReveal(r.recoveryCode ?? null); if (!r.recoveryCode) onUnlocked(); });
  const claimRecovery = () => run(async () => { const r = await lockCall<{ recoveryCode: string }>('POST', '/api/lock/setup/recovery', { setupToken: token }); setReveal(r.recoveryCode); });

  // In a browser that has used its passkey before, offer it right away (browsers allow that on a
  // fresh load). Elsewhere wait for a click, so nobody gets a surprise passkey dialog.
  useEffect(() => {
    if (tried.current || status.setupNeeded || blocker || status.passkeys === 0 || !passkeyHere()) return;
    tried.current = true;
    const t = setTimeout(() => { void signInWithPasskey().then(onUnlocked).catch(() => {}); }, 350);
    return () => clearTimeout(t);
  }, []);

  return (
    <main className="lk" aria-labelledby="lk-title">
      <div className="lk-sky" aria-hidden="true"><i /><i /><i /></div>
      <section className="lk-card">
        <img className="lk-mark" src="/icon.svg" alt="" width="84" height="84" />
        {reveal ? (
          <RecoveryReveal code={reveal} onDone={onUnlocked} first />
        ) : status.setupNeeded ? (
          <>
            <h1 id="lk-title">Claim this Aurora</h1>
            <p className="lk-sub">This server has no owner yet. Enter the one-time setup token printed in the server log, then make a passkey.</p>
            <label className="lk-field">
              <span>Setup token</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="one-time-code" spellCheck={false} autoFocus />
            </label>
            <button type="button" className="lk-btn primary" disabled={busy || !token.trim() || !!blocker} onClick={claimPasskey}><KeyIcon /> Create a passkey</button>
            <button type="button" className="lk-link" disabled={busy || !token.trim()} onClick={claimRecovery}>Use a recovery code only</button>
            {blocker && <p className="lk-hint">{blocker}</p>}
          </>
        ) : (
          <>
            <h1 id="lk-title">Aurora is locked</h1>
            <p className="lk-sub">Only the owner can come in.</p>
            {mode === 'passkey' ? (
              <>
                <button type="button" className="lk-btn primary" disabled={busy} onClick={passkey}><KeyIcon /> Unlock with a passkey</button>
                <button type="button" className="lk-link" onClick={() => { setMode('recovery'); setErr(null); }}>Use the recovery code</button>
              </>
            ) : (
              <form onSubmit={recovery} className="lk-form">
                <label className="lk-field">
                  <span>Recovery code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-…" autoComplete="off" spellCheck={false} autoFocus />
                </label>
                <button type="submit" className="lk-btn primary" disabled={busy || code.replace(/[^0-9a-z]/gi, '').length < 8}>Unlock</button>
                {!blocker && status.passkeys > 0 && <button type="button" className="lk-link" onClick={() => { setMode('passkey'); setErr(null); }}>Use a passkey instead</button>}
              </form>
            )}
            {blocker && <p className="lk-hint">{blocker}</p>}
          </>
        )}
        {err && <p className="lk-err" role="alert">{err}</p>}
      </section>
      <p className="lk-foot">Passkeys stay on your devices. Aurora never asks for a password.</p>
    </main>
  );
}

function RecoveryReveal({ code, onDone, first }: { code: string; onDone: () => void; first?: boolean }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="lk-reveal">
      <h2 id="lk-title">{first ? 'Save your recovery code' : 'Your new recovery code'}</h2>
      <p className="lk-sub">It unlocks Aurora if you lose your passkeys. It is shown only now{first ? '' : ', and the old one has stopped working'}.</p>
      <code className="lk-code" aria-label="Recovery code">{code}</code>
      <div className="lk-row">
        <button type="button" className="lk-btn" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* clipboard blocked */ } }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <label className="lk-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved it somewhere safe</label>
      <button type="button" className="lk-btn primary" disabled={!saved} onClick={onDone}>Continue</button>
    </div>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

/** Settings > Lock: turn sign-in on, manage passkeys, the recovery code and sessions. */
export function LockSettings({ toast }: { toast: (text: string, opts?: { tone?: 'info' | 'error' }) => void }) {
  const [st, setSt] = useState<LockStatus | null>(null);
  const [keys, setKeys] = useState<PasskeyInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [reveal, setReveal] = useState<{ code: string; first: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocker = passkeyBlocker();

  const refresh = async () => {
    try {
      const s = await lockStatus();
      setSt(s);
      if (s.owner) {
        const [k, ss] = await Promise.all([lockCall<{ passkeys: PasskeyInfo[] }>('GET', '/api/lock/passkeys'), lockCall<{ sessions: SessionInfo[] }>('GET', '/api/lock/sessions')]);
        setKeys(k.passkeys);
        setSessions(ss.sessions);
      }
    } catch {
      /* not available */
    }
  };
  useEffect(() => { void refresh(); }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(passkeyError(e), { tone: 'error' });
    } finally {
      setBusy(false);
      setConfirm(null);
      void refresh();
    }
  };

  if (!st) return null;
  const add = () => act(async () => { const r = await addPasskey(); if (r.recoveryCode) setReveal({ code: r.recoveryCode, first: true }); }, 'Passkey added');
  const recoveryOnly = () => act(async () => { const r = await lockCall<{ recoveryCode: string }>('POST', '/api/lock/setup/recovery', {}); setReveal({ code: r.recoveryCode, first: true }); });
  const toggle = () => act(() => lockCall('PUT', '/api/lock/enabled', { enabled: !st.enabled }), st.enabled ? 'Sign-in turned off on this computer' : 'Aurora now asks for sign-in');

  return (
    <section className="f-sec lk-set">
      <h3>Lock</h3>
      {st.required ? (
        <p className="f-hint">Sign-in is always on here, because this Aurora is hosted or reachable from your network.</p>
      ) : (
        <>
          <label className="more-row">
            <span>Require sign-in on this computer</span>
            <span className="switch"><input type="checkbox" checked={st.enabled} disabled={busy || !st.owner} onChange={toggle} aria-label="Require sign-in on this computer" /></span>
          </label>
          <p className="f-hint">{st.enabled ? 'Anyone at this computer needs your passkey or recovery code to open Aurora. Paired phones and the terminal client keep working.' : st.owner ? 'Off. Turn it on to ask for your passkey or recovery code when Aurora opens.' : 'Off. Add a passkey first; you get a recovery code as a backup.'}</p>
        </>
      )}

      {reveal && <div className="lk-inline"><RecoveryReveal code={reveal.code} onDone={() => setReveal(null)} first={reveal.first} /></div>}

      <h4 className="lk-h4">Passkeys</h4>
      {keys.length > 0 && (
        <ul className="lk-list">
          {keys.map((k) => (
            <li key={k.id}>
              <KeyIcon />
              <div className="lk-li-main">
                <span className="lk-li-name">{k.name}</span>
                <span className="lk-li-meta">Added {when(k.createdAt)} · last used {when(k.lastUsedAt)} · {k.rpId}</span>
              </div>
              {confirm === `pk:${k.id}` ? (
                <button type="button" className="btn small danger" disabled={busy} onClick={() => act(() => lockCall('DELETE', `/api/lock/passkeys/${encodeURIComponent(k.id)}`), 'Passkey removed')}>Remove it</button>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => setConfirm(`pk:${k.id}`)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="lk-actions">
        <button type="button" className="btn small" disabled={busy || !!blocker} onClick={add}>Add a passkey</button>
        {!st.owner && <button type="button" className="btn small ghost" disabled={busy} onClick={recoveryOnly}>Use a recovery code only</button>}
      </div>
      {blocker && <p className="f-hint">{blocker}</p>}

      {st.owner && (
        <>
          <h4 className="lk-h4">Recovery code</h4>
          <div className="more-row">
            <span>Shown once when made. Making a new one stops the old one.</span>
            {confirm === 'recovery' ? (
              <button type="button" className="btn small danger" disabled={busy} onClick={() => act(async () => { const r = await lockCall<{ recoveryCode: string }>('POST', '/api/lock/recovery', {}); setReveal({ code: r.recoveryCode, first: false }); })}>Replace it</button>
            ) : (
              <button type="button" className="btn small" onClick={() => setConfirm('recovery')}>New recovery code</button>
            )}
          </div>

          <h4 className="lk-h4">Signed-in browsers</h4>
          <ul className="lk-list">
            {sessions.length === 0 && <li className="lk-li-meta">None yet.</li>}
            {sessions.map((s) => (
              <li key={s.id}>
                <div className="lk-li-main">
                  <span className="lk-li-name">{s.device}{s.current && <span className="tag lk-tag">this browser</span>}</span>
                  <span className="lk-li-meta">Active {when(s.lastSeenAt)} · {s.ip.replace(/^::ffff:/, '')}</span>
                </div>
                {s.current ? (
                  <button type="button" className="btn small ghost" disabled={busy} onClick={() => act(() => lockCall('POST', '/api/lock/logout', {}).then(() => window.dispatchEvent(new Event('aurora:locked'))))}>Sign out</button>
                ) : (
                  <button type="button" className="btn small ghost" disabled={busy} onClick={() => act(() => lockCall('DELETE', `/api/lock/sessions/${s.id}`), 'Signed out')}>Sign out</button>
                )}
              </li>
            ))}
          </ul>
          {sessions.filter((s) => !s.current).length > 0 && (
            <div className="lk-actions">
              <button type="button" className="btn small" disabled={busy} onClick={() => act(() => lockCall('POST', '/api/lock/sessions/others', {}), 'Other sessions signed out')}>Sign out other sessions</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
