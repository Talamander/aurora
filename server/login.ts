// In-app login for the session tier. The user signs in to the real site themselves, inside the
// app's own Chromium profile (<dataDir>/browser-profiles/<name>). Two modes:
//
// - screencast (default, works headless, on a server or in Docker): Chromium runs headless, its
//   page is streamed to the web UI as JPEG frames (CDP Page.startScreencast over SSE), and the
//   user's mouse, keyboard, scroll and paste come back as POSTs and are replayed with Playwright's
//   input API.
// - window (desktop only: macOS, Windows, or Linux with DISPLAY or WAYLAND_DISPLAY set): a plain
//   Chromium process on the app's profile, with no automation attached. The user drives it like any
//   browser. Sites such as X and Google refuse to sign in inside a headless or automated browser
//   ("An unexpected error occurred"), so this is the default wherever there is a display.
//
// Lines held here: only app-owned profiles are touched; cookie values, typed text and URL query
// strings are never logged or returned (the profile list reads cookie host and name columns only);
// no CAPTCHA solving or evasion, the human solves whatever the site shows; https start URLs only;
// in cloud mode (SR_CLOUD=1) Meta and X profiles and hosts are refused.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import {
  LAUNCH_ARGS,
  PROFILE_RE,
  acquireProfile,
  assertCloudAllowed,
  findChromium,
  guardContext,
  isCloud,
  isMetaOrX,
  launchProfileContext,
  profileBusy,
  profileDirFor,
  profileRoot,
} from './actors/browser.ts';

const MAX_SESSIONS = 3;
const IDLE_MS = 15 * 60_000;
const MAX_AGE_MS = 45 * 60_000;
const LOCK_WAIT_MS = 30_000;
const TEXT_CAP = 5000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export type LoginMode = 'screencast' | 'window';

export interface LoginStatus {
  /** Origin and path only; query strings and fragments can carry tokens. */
  url: string;
  title: string;
  loading: boolean;
  /** Set once the session has ended. */
  ended?: string;
}

export interface ProfileSite {
  site: string;
  cookies: number;
  /** true/false when we know the site's sign-in cookie name; null otherwise. */
  signedIn: boolean | null;
}

export interface ProfileInfo {
  name: string;
  /** null while the profile is open (Chromium locks its cookie store). */
  sites: ProfileSite[] | null;
  inUse: boolean;
  updatedAt: string | null;
}

export type LoginInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; action: 'down' | 'up'; key: string }
  | { type: 'text'; text: string }
  | { type: 'nav'; action: 'back' | 'forward' | 'reload' }
  | { type: 'goto'; url: string };

interface Session {
  id: string;
  profile: string;
  mode: LoginMode;
  /** Screencast mode: the Playwright context. Window mode: null. */
  ctx: BrowserContext | null;
  /** Window mode: the plain Chromium process. */
  proc: ChildProcess | null;
  page: Page | null;
  cdp: CDPSession | null;
  viewport: { width: number; height: number };
  clients: Set<ServerResponse>;
  lastFrame: string | null;
  status: LoginStatus;
  release: () => void;
  createdAt: number;
  lastActive: number;
  ended: string | null;
}

export class LoginError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A desktop session can show a real browser window: always on macOS and Windows, X11/Wayland on Linux. */
export function hasDisplay(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return !env.SSH_CONNECTION;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Origin + path; drops credentials, query and fragment. */
export function safeDisplayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

function httpsUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    throw new LoginError(400, 'Give the login page as a full https:// link');
  }
  if (u.protocol !== 'https:') throw new LoginError(400, 'Login pages must use https');
  if (u.username || u.password) throw new LoginError(400, 'Links with embedded credentials are not allowed');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':')) throw new LoginError(400, 'Login pages must be public sites');
  return u.toString();
}

// Cookie names that mean "signed in" on common platforms. Names only, never values.
const AUTH_COOKIES: Record<string, string[]> = {
  'facebook.com': ['c_user', 'xs'],
  'instagram.com': ['sessionid'],
  'threads.net': ['sessionid'],
  'threads.com': ['sessionid'],
  'x.com': ['auth_token'],
  'twitter.com': ['auth_token'],
  'github.com': ['user_session'],
  'reddit.com': ['reddit_session', 'token_v2'],
  'linkedin.com': ['li_at'],
  'tiktok.com': ['sessionid'],
  'youtube.com': ['SID', '__Secure-3PSID'],
  'google.com': ['SID', '__Secure-3PSID'],
  'pinterest.com': ['_pinterest_sess'],
  'tumblr.com': ['logged_in'],
  'medium.com': ['sid'],
  'substack.com': ['substack.sid'],
  'patreon.com': ['session_id'],
  'discord.com': ['__Secure-recent_mfa'],
};

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or']);
export function siteOf(hostKey: string): string {
  const parts = hostKey.replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts.length;
  if (parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** Asks Chromium to quit (it saves its cookie store on SIGTERM), then forces it after 10 s. */
function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    proc.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

// Chromium time: microseconds since 1601-01-01.
const chromiumNow = () => BigInt(Date.now()) * 1000n + 11644473600000000n;

/** Sites with live cookies in an app-owned profile. Reads host_key and name only. */
export function profileSites(dir: string): ProfileSite[] | null {
  const file = [path.join(dir, 'Default', 'Network', 'Cookies'), path.join(dir, 'Default', 'Cookies')].find((f) => fs.existsSync(f));
  if (!file) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare('SELECT host_key AS host, name FROM cookies WHERE has_expires = 0 OR expires_utc > ?')
      .all(chromiumNow()) as { host: string; name: string }[];
    const by = new Map<string, { cookies: number; names: Set<string> }>();
    for (const r of rows) {
      const site = siteOf(String(r.host));
      if (!site) continue;
      const e = by.get(site) ?? { cookies: 0, names: new Set<string>() };
      e.cookies++;
      e.names.add(String(r.name));
      by.set(site, e);
    }
    return [...by.entries()]
      .map(([site, e]) => {
        const auth = AUTH_COOKIES[site];
        return { site, cookies: e.cookies, signedIn: auth ? auth.some((n) => e.names.has(n)) : null };
      })
      .sort((a, b) => Number(b.signedIn === true) - Number(a.signedIn === true) || b.cookies - a.cookies)
      .slice(0, 60);
  } catch {
    return null; // locked by a running Chromium, or not a cookie store yet
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function createLoginService(opts: { dataDir: string }) {
  const sessions = new Map<string, Session>();
  const wired = new WeakSet<Page>();
  const starting = new Map<string, Promise<{ id: string; mode: LoginMode; profile: string; reused?: boolean }>>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.lastActive > IDLE_MS) void end(s, 'Closed after 15 minutes without input');
      else if (now - s.createdAt > MAX_AGE_MS) void end(s, 'Closed after 45 minutes');
    }
  }, 30_000);
  sweep.unref();

  const sse = (s: Session, event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of s.clients) c.write(msg);
    return msg;
  };

  const pushStatus = async (s: Session) => {
    if (s.ended || !s.page || !s.ctx) return;
    const title = await s.page.title().catch(() => '');
    s.status = { url: safeDisplayUrl(s.page.url()), title: title.slice(0, 200), loading: s.status.loading };
    sse(s, 'status', s.status);
  };

  const stopCast = async (s: Session) => {
    const cdp = s.cdp;
    s.cdp = null;
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  };

  /** Make `page` the one shown and driven (the newest popup wins, e.g. "Sign in with Google"). */
  const attach = async (s: Session, page: Page) => {
    if (s.ended || (s.page === page && (s.cdp || s.mode !== 'screencast'))) return;
    s.page = page;
    if (wired.has(page)) return void switchCast(s, page);
    wired.add(page);
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && s.page === page) void pushStatus(s);
    });
    page.on('domcontentloaded', () => {
      if (s.page !== page) return;
      s.status.loading = false;
      void pushStatus(s);
    });
    page.on('close', () => {
      if (s.ended || s.page !== page) return;
      const rest = (s.ctx?.pages() ?? []).filter((p) => !p.isClosed());
      if (rest.length) void attach(s, rest[rest.length - 1]);
      else if (s.mode === 'window') void end(s, 'The window was closed');
    });
    await switchCast(s, page);
  };

  const switchCast = async (s: Session, page: Page) => {
    if (s.mode !== 'screencast' || !s.ctx) return void pushStatus(s);
    await stopCast(s);
    await page.setViewportSize(s.viewport).catch(() => {});
    const cdp = await s.ctx.newCDPSession(page);
    s.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (s.cdp !== cdp) return;
      s.lastFrame = sse(s, 'frame', { w: f.metadata.deviceWidth, h: f.metadata.deviceHeight, img: f.data });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: s.viewport.width, maxHeight: s.viewport.height, everyNthFrame: 1 });
    void pushStatus(s);
  };

  async function end(s: Session, reason: string) {
    if (s.ended) return;
    s.ended = reason;
    sessions.delete(s.id);
    s.status = { ...s.status, ended: reason };
    sse(s, 'end', { reason });
    for (const c of s.clients) c.end();
    s.clients.clear();
    await stopCast(s);
    // Closing the context (or letting Chromium shut down cleanly) flushes the cookie store to disk.
    await s.ctx?.close().catch(() => {});
    if (s.proc) await stopProcess(s.proc);
    s.release();
  }

  async function startSession(profile: string, body: { url?: unknown; mode?: unknown; viewport?: unknown }): Promise<{ id: string; mode: LoginMode; profile: string; reused?: boolean }> {
    const url = httpsUrl(body.url);
    try {
      assertCloudAllowed(profile, [url]);
    } catch (e) {
      throw new LoginError(403, (e as Error).message);
    }
    const mode: LoginMode = body.mode === 'window' ? 'window' : 'screencast';
    if (mode === 'window' && !hasDisplay()) throw new LoginError(409, 'No desktop display here. Use the in-app window instead.');
    const existing = [...sessions.values()].find((s) => s.profile === profile);
    if (existing) return { id: existing.id, mode: existing.mode, profile, reused: true };
    if (sessions.size >= MAX_SESSIONS) throw new LoginError(429, 'Too many login windows are open. Finish one first.');
    if (!findChromium()) throw new LoginError(501, 'Chromium or Google Chrome is not installed. Install one (on macOS, Google Chrome in /Applications works) or set CHROMIUM_PATH.');

    const vp = body.viewport as { width?: unknown; height?: unknown } | undefined;
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Math.round(Number(v)), lo), hi) : d);
    const viewport = { width: clamp(vp?.width, 360, 1600, DEFAULT_VIEWPORT.width), height: clamp(vp?.height, 480, 1200, DEFAULT_VIEWPORT.height) };

    // An actor run may hold the profile for a minute; wait a little, then give up.
    const lock = acquireProfile(opts.dataDir, profile);
    const release = await Promise.race([lock, new Promise<null>((r) => setTimeout(() => r(null), LOCK_WAIT_MS))]);
    if (!release) {
      void lock.then((r) => r());
      throw new LoginError(409, 'That profile is busy (a sync is using it). Try again in a minute.');
    }
    if (mode === 'window') return startWindow(profile, url, viewport, release);
    let ctx: BrowserContext;
    try {
      ctx = await launchProfileContext(profileDirFor(opts.dataDir, profile), { headless: mode === 'screencast', viewport: mode === 'screencast' ? viewport : null });
      // Any public https site may load (login flows hop between hosts), never private addresses.
      await guardContext(ctx, { allowHosts: null, skipMedia: false, deny: isCloud() ? isMetaOrX : undefined }, new Set());
    } catch (e) {
      release();
      throw new LoginError(500, `Could not start Chromium: ${(e as Error).message.split('\n')[0]}`);
    }
    const s: Session = {
      id: randomUUID(),
      profile,
      mode,
      ctx,
      proc: null,
      page: null,
      cdp: null,
      viewport,
      clients: new Set(),
      lastFrame: null,
      status: { url: safeDisplayUrl(url), title: '', loading: true },
      release,
      createdAt: Date.now(),
      lastActive: Date.now(),
      ended: null,
    };
    sessions.set(s.id, s);
    ctx.on('close', () => void end(s, 'The browser closed'));
    ctx.on('page', (p) => {
      if (p !== s.page) void attach(s, p).catch(() => {});
    });
    try {
      const pages = ctx.pages();
      const page = pages[0] ?? (await ctx.newPage());
      for (const p of pages.slice(1)) await p.close().catch(() => {});
      await attach(s, page);
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {
        if (!s.ended) sse(s, 'notice', { text: 'The page is slow to load or was blocked.' });
      });
    } catch (e) {
      await end(s, 'Failed to start');
      throw new LoginError(500, `Could not open the login page: ${(e as Error).message.split('\n')[0]}`);
    }
    return { id: s.id, mode, profile };
  }

  /** A plain Chromium window on the app's profile. No CDP, no Playwright: the user drives it. */
  function startWindow(profile: string, url: string, viewport: { width: number; height: number }, release: () => void) {
    const exe = findChromium()!;
    const dir = profileDirFor(opts.dataDir, profile);
    let proc: ChildProcess;
    try {
      proc = spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', ...LAUNCH_ARGS, '--new-window', url], {
        stdio: 'ignore',
        env: process.env,
      });
    } catch (e) {
      release();
      throw new LoginError(500, `Could not start Chromium: ${(e as Error).message.split('\n')[0]}`);
    }
    const s: Session = {
      id: randomUUID(),
      profile,
      mode: 'window',
      ctx: null,
      proc,
      page: null,
      cdp: null,
      viewport,
      clients: new Set(),
      lastFrame: null,
      status: { url: safeDisplayUrl(url), title: '', loading: false },
      release,
      createdAt: Date.now(),
      lastActive: Date.now(),
      ended: null,
    };
    sessions.set(s.id, s);
    proc.on('error', () => void end(s, 'Chromium could not start'));
    proc.on('exit', () => void end(s, 'The window was closed'));
    return { id: s.id, mode: 'window' as const, profile };
  }

  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new LoginError(404, 'This login window has closed');
    return s;
  };

  return {
    info() {
      return { desktop: hasDisplay(), cloud: isCloud(), chromium: !!findChromium(), sessions: [...sessions.values()].map((s) => ({ id: s.id, profile: s.profile, mode: s.mode })) };
    },

    start(body: { profile?: unknown; url?: unknown; mode?: unknown; viewport?: unknown }): Promise<{ id: string; mode: LoginMode; profile: string; reused?: boolean }> {
      const profile = String(body.profile ?? '').trim().toLowerCase();
      if (!PROFILE_RE.test(profile)) return Promise.reject(new LoginError(400, 'Profile names are lowercase letters, digits and dashes (for example "facebook")'));
      // A second request while the first is still launching gets the same session.
      const inflight = starting.get(profile);
      if (inflight) return inflight.then((r) => ({ ...r, reused: true }));
      const p = startSession(profile, body).finally(() => starting.delete(profile));
      starting.set(profile, p);
      return p;
    },

    stream(id: string, req: IncomingMessage, res: ServerResponse) {
      const s = get(id);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ id: s.id, profile: s.profile, mode: s.mode, viewport: s.viewport })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify(s.status)}\n\n`);
      if (s.lastFrame) res.write(s.lastFrame);
      s.clients.add(res);
      s.lastActive = Date.now();
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        s.clients.delete(res);
      });
    },

    /** Replays one input event. Never logs the event (it can hold typed passwords). */
    async input(id: string, ev: LoginInput) {
      const s = get(id);
      s.lastActive = Date.now();
      const page = s.page;
      if (!page || page.isClosed()) throw new LoginError(409, 'No page to send input to');
      const num = (v: unknown, hi: number) => Math.min(Math.max(Number(v) || 0, 0), hi);
      try {
        switch (ev?.type) {
          case 'mouse': {
            if (s.mode !== 'screencast') break;
            const x = num(ev.x, s.viewport.width);
            const y = num(ev.y, s.viewport.height);
            const button = ev.button === 'right' || ev.button === 'middle' ? ev.button : 'left';
            await page.mouse.move(x, y);
            if (ev.action === 'down') await page.mouse.down({ button, clickCount: Math.min(Math.max(Number(ev.clickCount) || 1, 1), 3) });
            else if (ev.action === 'up') await page.mouse.up({ button, clickCount: Math.min(Math.max(Number(ev.clickCount) || 1, 1), 3) });
            break;
          }
          case 'wheel': {
            if (s.mode !== 'screencast') break;
            await page.mouse.move(num(ev.x, s.viewport.width), num(ev.y, s.viewport.height));
            const d = (v: unknown) => Math.min(Math.max(Number(v) || 0, -3000), 3000);
            await page.mouse.wheel(d(ev.dx), d(ev.dy));
            break;
          }
          case 'key': {
            if (s.mode !== 'screencast') break;
            const key = String(ev.key ?? '').slice(0, 40);
            if (!key) break;
            if (ev.action === 'down') {
              await page.keyboard.down(key).catch(async () => {
                // Characters outside Playwright's US layout table (é, ß, emoji) arrive as text.
                if ([...key].length === 1) await page.keyboard.insertText(key);
              });
            } else await page.keyboard.up(key).catch(() => {});
            break;
          }
          case 'text': {
            const text = String(ev.text ?? '').slice(0, TEXT_CAP);
            if (text && s.mode === 'screencast') await page.keyboard.insertText(text);
            break;
          }
          case 'nav':
            if (ev.action === 'back') await page.goBack({ timeout: 15_000 }).catch(() => {});
            else if (ev.action === 'forward') await page.goForward({ timeout: 15_000 }).catch(() => {});
            else if (ev.action === 'reload') await page.reload({ timeout: 30_000 }).catch(() => {});
            break;
          case 'goto': {
            const url = httpsUrl(ev.url);
            try {
              assertCloudAllowed(s.profile, [url]);
            } catch (e) {
              throw new LoginError(403, (e as Error).message);
            }
            s.status.loading = true;
            void page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
            break;
          }
          default:
            throw new LoginError(400, 'Unknown input');
        }
      } catch (e) {
        if (e instanceof LoginError) throw e;
        // Swallow the detail: Playwright errors can echo the typed key.
        throw new LoginError(409, 'The page did not take that input');
      }
      return { ok: true };
    },

    /** Closes the browser and keeps the profile (and the sign-in it now holds). */
    async done(id: string) {
      const s = get(id);
      const profile = s.profile;
      await end(s, 'Finished');
      const dir = profileDirFor(opts.dataDir, profile, false);
      return { ok: true, profile, sites: profileSites(dir) };
    },

    async cancel(id: string) {
      const s = sessions.get(id);
      if (s) await end(s, 'Cancelled');
      return { ok: true };
    },

    profiles(): ProfileInfo[] {
      const root = profileRoot(opts.dataDir);
      let names: string[] = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && PROFILE_RE.test(d.name)).map((d) => d.name);
      } catch {
        return [];
      }
      return names.sort().map((name) => {
        const dir = path.join(root, name);
        const open = [...sessions.values()].some((s) => s.profile === name);
        const inUse = open || profileBusy(opts.dataDir, name);
        let updatedAt: string | null = null;
        for (const f of [path.join(dir, 'Default', 'Network', 'Cookies'), path.join(dir, 'Default', 'Cookies')]) {
          try {
            updatedAt = fs.statSync(f).mtime.toISOString();
            break;
          } catch {}
        }
        return { name, sites: inUse ? null : profileSites(dir), inUse, updatedAt };
      });
    },

    /** Sign out: delete one app-owned profile folder. Refuses anything outside browser-profiles/. */
    deleteProfile(name: string) {
      if (!PROFILE_RE.test(name)) throw new LoginError(400, 'Invalid profile name');
      if ([...sessions.values()].some((s) => s.profile === name) || profileBusy(opts.dataDir, name)) throw new LoginError(409, 'That profile is in use. Close its login window or wait for the sync to finish.');
      const root = profileRoot(opts.dataDir);
      const dir = profileDirFor(opts.dataDir, name, false);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(dir);
      } catch {
        throw new LoginError(404, 'No such profile');
      }
      if (st.isSymbolicLink()) {
        fs.unlinkSync(dir); // never follow a link out of the data folder
        return { ok: true };
      }
      const real = fs.realpathSync(dir);
      if (path.dirname(real) !== fs.realpathSync(root)) throw new LoginError(400, 'Refusing to delete a folder outside the app profiles');
      fs.rmSync(real, { recursive: true, force: true });
      return { ok: true };
    },

    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => end(s, 'Server stopped')));
    },
  };
}

export type LoginService = ReturnType<typeof createLoginService>;

type RouteFn = (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown) => void;
type HttpErrorCtor = new (status: number, message: string) => Error;

/** Wires /api/login/* into the server's router. Returns the service (close it on shutdown). */
export function registerLoginRoutes(route: RouteFn, deps: { dataDir: string; HttpError: HttpErrorCtor }): LoginService {
  const svc = createLoginService({ dataDir: deps.dataDir });
  const wrap =
    <A extends unknown[]>(fn: (...a: A) => unknown) =>
    async (...a: A) => {
      try {
        return await fn(...a);
      } catch (e) {
        if (e instanceof LoginError) throw new deps.HttpError(e.status, e.message);
        throw e;
      }
    };
  route('GET', '/api/login/info', () => svc.info());
  route('GET', '/api/login/profiles', () => ({ profiles: svc.profiles(), cloud: isCloud() }));
  route('DELETE', '/api/login/profiles/:name', wrap((_q: IncomingMessage, _s: ServerResponse, p: Record<string, string>) => svc.deleteProfile(p.name)));
  route('POST', '/api/login', wrap((_q: IncomingMessage, _s: ServerResponse, _p: Record<string, string>, body: any) => svc.start(body ?? {})));
  route('GET', '/api/login/:id/stream', wrap((req: IncomingMessage, res: ServerResponse, p: Record<string, string>) => svc.stream(p.id, req, res)));
  route('POST', '/api/login/:id/input', wrap((_q: IncomingMessage, _s: ServerResponse, p: Record<string, string>, body: any) => svc.input(p.id, body)));
  route('POST', '/api/login/:id/done', wrap((_q: IncomingMessage, _s: ServerResponse, p: Record<string, string>) => svc.done(p.id)));
  route('POST', '/api/login/:id/cancel', wrap((_q: IncomingMessage, _s: ServerResponse, p: Record<string, string>) => svc.cancel(p.id)));
  return svc;
}
