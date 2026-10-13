// The rest of the settings: phones, the daily edition, archiving saved posts, and your feed elsewhere
// (RSS/JSON feeds and the MCP server for other AI tools).

import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { resetImgProxy } from './imgProxy.ts';
import { LOGIN_URLS, LoginSheet, SignedInSites, loginUrlFor } from './Login.tsx';
import { Phones } from './Phones.tsx';
import { LockSettings } from './Lock.tsx';
import { setThreadsEnabled, useThreadsEnabled } from './threads.ts';

interface FeedsInfo { tokenSet: boolean; feeds: { name: string; rss: string; json: string }[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn small ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ } }}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function MoreSettings({ toast }: { toast: (text: string, opts?: { tone?: 'info' | 'error' }) => void }) {
  const [edition, setEdition] = useState<{ enabled?: boolean; hour?: number }>({});
  const [archive, setArchive] = useState<{ saved: boolean; ytDlp: boolean } | null>(null);
  const [feeds, setFeeds] = useState<FeedsInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [root, setRoot] = useState('<path to social-reader>');
  const [login, setLogin] = useState<string | null>(null);
  const [loginTick, setLoginTick] = useState(0);
  const [imgProxy, setImgProxy] = useState<boolean | null>(null);
  const threadsOn = useThreadsEnabled();

  useEffect(() => {
    api.getSetting<boolean>('ui.imageProxy').then((x) => setImgProxy(x.value !== false)).catch(() => {});
    api.getSetting<{ enabled?: boolean; hour?: number }>('ui.edition').then((x) => setEdition(x.value ?? {})).catch(() => {});
    call<{ saved: boolean; ytDlp: boolean }>('GET', '/api/archive/settings').then(setArchive).catch(() => {});
    call<FeedsInfo>('GET', '/api/feeds').then(setFeeds).catch(() => {});
    call<{ root: string }>('GET', '/api/about').then((a) => setRoot(a.root)).catch(() => {});
  }, []);

  const saveEdition = (next: { enabled?: boolean; hour?: number }) => {
    setEdition(next);
    void api.putSetting('ui.edition', next);
  };
  const editionOn = edition.enabled !== false;
  const hour = Number.isFinite(edition.hour) ? Number(edition.hour) : 7;
  const mcpCmd = `claude mcp add social-reader -- node ${root}/server/mcp.ts`;
  const q = token ? `?token=${token}` : '';

  return (
    <div className="more-settings">
      <LockSettings toast={toast} />

      <Phones toast={toast} />

      <section className="f-sec">
        <h3>Morning edition</h3>
        <label className="more-row">
          <span>Write it every morning at</span>
          <select className="f-input small" value={hour} disabled={!editionOn} onChange={(e) => saveEdition({ ...edition, hour: Number(e.target.value) })} aria-label="Hour">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
          <span className="switch"><input type="checkbox" checked={editionOn} onChange={() => saveEdition({ ...edition, enabled: !editionOn })} aria-label="Daily edition" /></span>
        </label>
        <p className="f-hint">The AI reads what arrived overnight and writes a page with sections and the posts behind them. Uses your AI provider once a day.</p>
      </section>

      <section className="f-sec">
        <h3>Keep saved posts</h3>
        <label className="more-row">
          <span>Download photos and videos of posts you save</span>
          <span className="switch"><input type="checkbox" checked={!!archive?.saved} disabled={!archive} onChange={async () => {
            const next = !archive?.saved;
            try { await call('PUT', '/api/archive/settings', { saved: next }); setArchive((a) => (a ? { ...a, saved: next } : a)); toast(next ? 'Saved posts will be kept on this computer' : 'Stopped keeping copies of saved posts'); } catch (e) { toast((e as Error).message, { tone: 'error' }); }
          }} aria-label="Archive saved posts" /></span>
        </label>
        <p className="f-hint">So a saved post survives if the original is deleted. Files stay in your data folder.{archive && !archive.ytDlp ? ' Videos need yt-dlp, which is not installed.' : ''}</p>
      </section>

      <section className="f-sec">
        <h3>Threads</h3>
        <label className="more-row">
          <span>Show threads as one card</span>
          <span className="switch"><input type="checkbox" checked={threadsOn} onChange={async () => {
            const next = !threadsOn;
            try { await setThreadsEnabled(next); toast(next ? 'Threads now show as one card' : 'Thread posts now show one by one'); } catch (e) { toast((e as Error).message, { tone: 'error' }); }
          }} aria-label="Show threads as one card" /></span>
        </label>
        <p className="f-hint">When one person posts a numbered chain or replies to themselves, the posts fold into one card that opens as a single article. Nothing changes on the site.</p>
      </section>

      <section className="f-sec">
        <h3>Private pictures</h3>
        <label className="more-row">
          <span>Load pictures through Aurora</span>
          <span className="switch"><input type="checkbox" checked={imgProxy !== false} disabled={imgProxy === null} onChange={async () => {
            const next = !imgProxy;
            try { await api.putSetting('ui.imageProxy', next); setImgProxy(next); resetImgProxy(); toast(next ? 'Pictures now load through Aurora' : 'Pictures now load straight from their sites'); setTimeout(() => location.reload(), 700); } catch (e) { toast((e as Error).message, { tone: 'error' }); }
          }} aria-label="Load pictures through Aurora" /></span>
        </label>
        <p className="f-hint">Sites that host images never see when you look at a post. Pictures are cached in your data folder, so they also load faster the second time.</p>
      </section>

      <section className="f-sec">
        <h3>Signed-in sites</h3>
        <p className="f-hint">For things that need an account, you sign in yourself in the app's own private browser. Your everyday browser is never touched, and the AI only reads.</p>
        <SignedInSites refreshKey={loginTick} onSignIn={(p) => setLogin(p)} />
        <label className="more-row">
          <span>Sign in to</span>
          <select className="f-input small" value="" onChange={(e) => e.target.value && setLogin(e.target.value)} aria-label="Sign in to a site">
            <option value="">Choose a site…</option>
            {Object.keys(LOGIN_URLS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        {login && <LoginSheet profile={login} url={loginUrlFor(login) ?? 'https://'} onDone={() => setLoginTick((t) => t + 1)} onClose={() => setLogin(null)} />}
      </section>

      <section className="f-sec">
        <h3>Your feed elsewhere</h3>
        <p className="f-hint">Read your filtered feeds in any feed reader, or let other AI tools search your library through MCP. Read-only.</p>
        {feeds && (
          <ul className="feed-list">
            {feeds.feeds.slice(0, 8).map((f) => (
              <li key={f.rss}>
                <span className="feed-name">{f.name}</span>
                <Copy text={f.rss + q} label="RSS" />
                <Copy text={f.json + q} label="JSON" />
              </li>
            ))}
          </ul>
        )}
        <div className="more-row">
          <span>{feeds?.tokenSet ? 'Feeds need a token.' : 'No token: feeds only answer on this computer.'}</span>
          <button type="button" className="btn small ghost" onClick={async () => {
            try { const r = await call<{ token?: string }>('POST', '/api/feeds/token', {}); setToken(r.token ?? null); setFeeds((f) => (f ? { ...f, tokenSet: true } : f)); toast('New feed token made. Copy the links now: it is shown once.'); } catch (e) { toast((e as Error).message, { tone: 'error' }); }
          }}>{feeds?.tokenSet ? 'New token' : 'Make a token'}</button>
        </div>
        <div className="mcp-box">
          <code tabIndex={0} aria-label="MCP command">{mcpCmd}</code>
          <Copy text={mcpCmd} label="Copy" />
        </div>
        <p className="f-hint"><Icon name="code" size={13} /> Works with Claude Code, Claude Desktop and Cursor. See docs/mcp.md.</p>
      </section>
    </div>
  );
}
