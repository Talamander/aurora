// In-app login for signed-in sources. The real site runs in the app's own Chromium profile on the
// server; this sheet shows its screen (a live JPEG screencast) and sends the user's mouse,
// keyboard, scroll and paste back. Typed text goes only to the local server and on to the site.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { useDialog } from './useDialog.ts';
import './login.css';

export interface LoginSite {
  site: string;
  cookies: number;
  signedIn: boolean | null;
}
export interface LoginProfile {
  name: string;
  sites: LoginSite[] | null;
  inUse: boolean;
  updatedAt: string | null;
}
export interface LoginResult {
  profile: string;
  sites: LoginSite[] | null;
}

interface Status {
  url: string;
  title: string;
  loading: boolean;
  ended?: string;
}

type Input =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; action: 'down' | 'up'; key: string }
  | { type: 'text'; text: string }
  | { type: 'nav'; action: 'back' | 'forward' | 'reload' }
  | { type: 'goto'; url: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The server wants a JSON body on every non-GET request.
  const res = await fetch(path, method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const loginApi = {
  info: () => call<{ desktop: boolean; cloud: boolean; chromium: boolean }>('GET', '/api/login/info'),
  profiles: () => call<{ profiles: LoginProfile[]; cloud: boolean }>('GET', '/api/login/profiles'),
  signOut: (name: string) => call('DELETE', `/api/login/profiles/${encodeURIComponent(name)}`),
};

/** Sign-in pages for common platforms. The profile name is the platform slug. */
export const LOGIN_URLS: Record<string, string> = {
  facebook: 'https://www.facebook.com/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  threads: 'https://www.threads.net/login',
  x: 'https://x.com/i/flow/login',
  linkedin: 'https://www.linkedin.com/login',
  reddit: 'https://www.reddit.com/login',
  github: 'https://github.com/login',
  tiktok: 'https://www.tiktok.com/login',
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
};
export function loginUrlFor(platform: string): string | null {
  return LOGIN_URLS[platform.toLowerCase()] ?? null;
}

const MODS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Login sheet. Mount it while the user signs in; it starts the server-side browser on mount and
 * closes it when the user presses "I'm signed in" (keeps the sign-in) or Cancel.
 *
 * - profile: app-owned profile name, the platform slug ("facebook", "github"). Session-tier actors
 *   for that platform read with this profile.
 * - url: https sign-in page (see loginUrlFor).
 * - label: human name for the heading ("Facebook"); defaults to the profile name.
 * - onDone(result): the user said they are signed in; result.sites lists sites with cookies.
 * - onClose(): always called last (after done or cancel).
 */
export function LoginSheet({ profile, url, label, onDone, onClose }: { profile: string; url: string; label?: string; onDone?: (r: LoginResult) => void; onClose: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const [id, setId] = useState<string | null>(null);
  const [mode, setMode] = useState<'screencast' | 'window'>('screencast');
  const [desktop, setDesktop] = useState(false);
  const [status, setStatus] = useState<Status>({ url, title: '', loading: true });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const [typeBox, setTypeBox] = useState(false);
  const [typed, setTyped] = useState('');
  const [addr, setAddr] = useState('');
  const [editingAddr, setEditingAddr] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  // Keys and paste land in a hidden textarea: browsers only fire paste reliably on editable elements.
  const sink = useRef<HTMLTextAreaElement>(null);
  const pasted = useRef(0);
  const frameSize = useRef({ w: 1280, h: 800 });
  const idRef = useRef<string | null>(null);
  const endedRef = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingMove = useRef<Input | null>(null);
  const held = useRef(new Set<string>());
  const lastDown = useRef({ t: 0, x: 0, y: 0, n: 0 });

  // Start (or restart in another mode) the server-side browser.
  const start = useCallback(
    async (m: 'screencast' | 'window') => {
      setError(null);
      setNotice(null);
      setHasFrame(false);
      endedRef.current = false;
      const el = screen.current;
      const vp = el ? { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) } : undefined;
      try {
        const r = await call<{ id: string; mode: 'screencast' | 'window' }>('POST', '/api/login', { profile, url, mode: m, viewport: vp });
        idRef.current = r.id;
        setId(r.id);
        setMode(r.mode);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [profile, url],
  );

  useEffect(() => {
    let alive = true;
    // With a display, open a real Chromium window: X and Google refuse sign-in in a headless browser.
    loginApi
      .info()
      .then((i) => {
        if (!alive) return;
        setDesktop(i.desktop);
        void start(i.desktop ? 'window' : 'screencast');
      })
      .catch(() => alive && void start('screencast'));
    return () => {
      alive = false;
      // Unmounting without a decision closes the browser; the profile stays.
      const cur = idRef.current;
      if (cur && !endedRef.current) void call('POST', `/api/login/${cur}/cancel`).catch(() => {});
    };
  }, [start]);

  // Frames and status over SSE.
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/login/${id}/stream`);
    let drawing = false;
    let next: { w: number; h: number; img: string } | null = null;
    const draw = () => {
      const f = next;
      next = null;
      const c = canvas.current;
      if (!f || !c) return;
      drawing = true;
      const img = new Image();
      img.onload = () => {
        if (c.width !== f.w || c.height !== f.h) {
          c.width = f.w;
          c.height = f.h;
        }
        c.getContext('2d')?.drawImage(img, 0, 0, f.w, f.h);
        frameSize.current = { w: f.w, h: f.h };
        drawing = false;
        setHasFrame(true);
        if (next) draw();
      };
      img.onerror = () => {
        drawing = false;
        if (next) draw();
      };
      img.src = `data:image/jpeg;base64,${f.img}`;
    };
    es.addEventListener('frame', (e) => {
      next = JSON.parse((e as MessageEvent).data);
      if (!drawing) draw();
    });
    es.addEventListener('status', (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('notice', (e) => setNotice(JSON.parse((e as MessageEvent).data).text));
    es.addEventListener('end', (e) => {
      endedRef.current = true;
      const reason = JSON.parse((e as MessageEvent).data).reason as string;
      setStatus((s) => ({ ...s, ended: reason }));
      es.close();
    });
    es.onerror = () => {
      if (endedRef.current) es.close();
    };
    return () => es.close();
  }, [id]);

  // One request at a time, in order; consecutive mouse moves collapse into the latest.
  const send = useCallback((ev: Input) => {
    const cur = idRef.current;
    if (!cur || endedRef.current) return;
    if (ev.type === 'mouse' && ev.action === 'move') {
      const queued = pendingMove.current;
      pendingMove.current = ev;
      if (queued) return;
      queue.current = queue.current.then(() => {
        const m = pendingMove.current;
        pendingMove.current = null;
        return m ? call('POST', `/api/login/${cur}/input`, m).catch(() => {}) : undefined;
      });
      return;
    }
    queue.current = queue.current.then(() => call('POST', `/api/login/${cur}/input`, ev).catch(() => {}));
  }, []);

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const { w, h } = frameSize.current;
    return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * h) };
  };
  const buttonOf = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left') as 'left' | 'right' | 'middle';

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    sink.current?.focus({ preventScroll: true });
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const p = point(e);
    const ld = lastDown.current;
    const n = Date.now() - ld.t < 450 && Math.abs(ld.x - p.x) < 6 && Math.abs(ld.y - p.y) < 6 ? Math.min(ld.n + 1, 3) : 1;
    lastDown.current = { t: Date.now(), ...p, n };
    send({ type: 'mouse', action: 'down', ...p, button: buttonOf(e.button), clickCount: n });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    send({ type: 'mouse', action: 'up', ...point(e), button: buttonOf(e.button), clickCount: lastDown.current.n });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => send({ type: 'mouse', action: 'move', ...point(e) });

  // Wheel needs a non-passive listener to stop the sheet from scrolling.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send({ type: 'wheel', ...point(e), dx: e.deltaX * k, dy: e.deltaY * k });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [send, mode]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd+V (and Shift+Insert): let the browser fire a paste event; it arrives as text below.
    // If no paste event shows up (some browsers or desktops), read the clipboard directly.
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) {
      const asked = Date.now();
      setTimeout(() => {
        if (pasted.current >= asked) return;
        navigator.clipboard?.readText?.().then((t) => { if (t && pasted.current < asked) { pasted.current = Date.now(); send({ type: 'text', text: t }); } }).catch(() => setNotice('The browser blocked reading the clipboard. Use the keyboard button to paste instead.'));
      }, 120);
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // keep Tab and Escape for the page, not the sheet
    if (e.key === 'Unidentified' || e.key === 'Dead' || e.key === 'Process') return;
    if (e.repeat && MODS.has(e.key)) return;
    held.current.add(e.key);
    send({ type: 'key', action: 'down', key: e.key });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!held.current.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    held.current.delete(e.key);
    send({ type: 'key', action: 'up', key: e.key });
  };
  const releaseAll = () => {
    setFocused(false);
    for (const k of held.current) send({ type: 'key', action: 'up', key: k });
    held.current.clear();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    pasted.current = Date.now();
    if (text) send({ type: 'text', text });
  };
  const sendTyped = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typed) return;
    send({ type: 'text', text: typed });
    setTyped('');
    sink.current?.focus({ preventScroll: true });
  };

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    let u = addr.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
    if (!/^https:\/\//i.test(u)) return setNotice('Only https pages can be opened here.');
    setEditingAddr(false);
    send({ type: 'goto', url: u });
  };

  const finish = async () => {
    const cur = idRef.current;
    if (!cur) return onClose();
    setBusy(true);
    try {
      const r = await call<LoginResult & { ok: true }>('POST', `/api/login/${cur}/done`);
      endedRef.current = true;
      onDone?.({ profile: r.profile, sites: r.sites });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const cancel = async () => {
    const cur = idRef.current;
    endedRef.current = true;
    if (cur) await call('POST', `/api/login/${cur}/cancel`).catch(() => {});
    onClose();
  };
  const switchMode = async (m: 'screencast' | 'window') => {
    const cur = idRef.current;
    endedRef.current = true;
    if (cur) await call('POST', `/api/login/${cur}/cancel`).catch(() => {});
    idRef.current = null;
    setId(null);
    await start(m);
  };

  const ended = status.ended;
  const name = label ?? profile;

  return (
    <div className="sheet-backdrop login-backdrop">
      <div ref={dlg} className="sheet login-sheet" role="dialog" aria-modal="true" aria-label={`Sign in to ${name}`}>
        <div className="sheet-head">
          <h2>Sign in to {name}</h2>
          {desktop && !ended && (
            <button type="button" className="btn small ghost" onClick={() => void switchMode(mode === 'window' ? 'screencast' : 'window')}>
              {mode === 'window' ? 'Show it here instead' : 'Open a real window'}
            </button>
          )}
          <button className="icon-btn" onClick={() => void cancel()} aria-label="Cancel and close"><Icon name="x" /></button>
        </div>

        <div className="login-bar">
          <button type="button" className="icon-btn small" aria-label="Back" disabled={!!ended || !id} onClick={() => send({ type: 'nav', action: 'back' })}><Icon name="back" size={16} /></button>
          <button type="button" className="icon-btn small" aria-label="Reload" disabled={!!ended || !id} onClick={() => send({ type: 'nav', action: 'reload' })}><Icon name="sync" size={16} /></button>
          <form className="login-addr" onSubmit={go}>
            {status.loading && !ended ? <span className="login-spin" role="img" aria-label="Loading" /> : <Icon name="link" size={14} />}
            <input
              aria-label="Page address"
              value={editingAddr ? addr : status.url}
              onFocus={() => {
                setAddr(status.url);
                setEditingAddr(true);
              }}
              onBlur={() => setEditingAddr(false)}
              onChange={(e) => setAddr(e.target.value)}
              disabled={!!ended || !id}
              spellCheck={false}
            />
          </form>
          {mode === 'screencast' && (
            <button type="button" className={`icon-btn small ${typeBox ? 'on' : ''}`} aria-label="Type or paste text" aria-pressed={typeBox} disabled={!!ended || !id} onClick={() => setTypeBox((v) => !v)}>
              <Icon name="keyboard" size={16} />
            </button>
          )}
        </div>

        {typeBox && mode === 'screencast' && !ended && (
          <form className="login-type" onSubmit={sendTyped}>
            <input type="password" autoComplete="off" placeholder="Text to type into the page (hidden)" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Text to type into the page" />
            <button className="btn small" type="submit" disabled={!typed}>Type it</button>
          </form>
        )}

        <div className="login-stage">
          {mode === 'screencast' ? (
            <div
              ref={screen}
              className={`login-screen ${focused ? 'focused' : ''}`}
            >
              <textarea
                ref={sink}
                className="login-sink"
                aria-label="Remote page. Click to interact; keys and paste go to the page."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value=""
                onChange={() => {}}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onPaste={onPaste}
                onFocus={() => setFocused(true)}
                onBlur={releaseAll}
              />
              <canvas
                ref={canvas}
                width={1280}
                height={800}
                className={hasFrame ? '' : 'waiting'}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerMove={onPointerMove}
                onContextMenu={(e) => e.preventDefault()}
              />
              {!hasFrame && !error && !ended && <p className="login-wait"><span className="login-spin" /> Opening {name}</p>}
            </div>
          ) : (
            <div className="login-window-note">
              <Icon name="external" size={22} />
              <p>A Chromium window is open on your desktop. Sign in there, then come back and press “I’m signed in”.</p>
            </div>
          )}
          {ended && (
            <div className="login-ended" role="status">
              <p>{ended === 'Finished' ? 'Signed in.' : `This window closed: ${ended}.`}</p>
              <button className="btn small" type="button" onClick={() => void switchMode(mode)}>Open again</button>
            </div>
          )}
        </div>

        {(error || notice) && <p className={error ? 'form-error login-msg' : 'f-hint login-msg'} role={error ? 'alert' : 'status'}>{error ?? notice}</p>}

        <div className="sheet-foot login-foot">
          <p className="f-hint">
            You type your password into {name} itself. The sign-in stays in Aurora’s own browser on this computer and is only used to read. If the site asks for a code or a puzzle, solve it here.
          </p>
          <div className="login-actions">
            <button className="btn ghost" type="button" onClick={() => void cancel()}>Cancel</button>
            <button className="btn primary" type="button" disabled={busy || !id || (!!ended && ended !== 'Finished')} onClick={() => void finish()}>{busy ? 'Saving' : 'I’m signed in'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * List of app-owned browser profiles and the sites signed in on each, with sign out.
 * - refreshKey: change it (for example after LoginSheet onDone) to reload the list.
 * - onSignIn(profile): optional; shows a "Sign in again" button per profile.
 */
export function SignedInSites({ refreshKey, onSignIn }: { refreshKey?: unknown; onSignIn?: (profile: string) => void }) {
  const [profiles, setProfiles] = useState<LoginProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    loginApi
      .profiles()
      .then((r) => {
        setProfiles(r.profiles);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load, refreshKey]);

  const signOut = async (name: string) => {
    setBusy(name);
    try {
      await loginApi.signOut(name);
      setConfirm(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !profiles) return <p className="form-error">{error}</p>;
  if (!profiles) return <p className="f-hint">Loading signed-in sites</p>;
  if (!profiles.length) return <p className="f-hint">No signed-in sites. Sources that need an account ask you to sign in when you add them.</p>;

  return (
    <div className="login-profiles">
      {error && <p className="form-error">{error}</p>}
      <ul>
        {profiles.map((p) => {
          const signed = p.sites?.filter((s) => s.signedIn) ?? [];
          const other = p.sites?.filter((s) => !s.signedIn) ?? [];
          return (
            <li key={p.name}>
              <div className="login-profile-main">
                <span className="login-profile-name">{p.name}</span>
                <span className="login-profile-meta">
                  {p.inUse ? (
                    <span className="tag">in use</span>
                  ) : p.sites === null ? (
                    'unknown'
                  ) : signed.length ? (
                    signed.map((s) => <span key={s.site} className="tag login-on">{s.site}</span>)
                  ) : (
                    <span>{other.length ? `${other.length} site${other.length === 1 ? '' : 's'} with cookies, no known sign-in` : 'no sign-in yet'}</span>
                  )}
                  {p.updatedAt && <span className="login-profile-when">{new Date(p.updatedAt).toLocaleDateString()}</span>}
                </span>
              </div>
              {onSignIn && confirm !== p.name && (
                <button className="btn small ghost" type="button" onClick={() => onSignIn(p.name)} disabled={p.inUse}>Sign in again</button>
              )}
              {confirm === p.name ? (
                <span className="login-confirm">
                  <button className="btn small ghost" type="button" onClick={() => setConfirm(null)}>Keep</button>
                  <button className="btn small danger" type="button" disabled={busy === p.name} onClick={() => void signOut(p.name)}>Delete sign-in</button>
                </span>
              ) : (
                <button className="btn small ghost" type="button" disabled={p.inUse} onClick={() => setConfirm(p.name)}>Sign out</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="f-hint">Signing out deletes that profile from Aurora’s own browser. Your other browsers are never touched.</p>
    </div>
  );
}
