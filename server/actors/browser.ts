// Browser service for actors and the builder AI: renders pages in the system Chromium via
// playwright-core. Every request is checked against the caller's host allowlist and the
// private-address rules; images, fonts and media are skipped. No stealth or CAPTCHA tricks:
// the only change from stock Chromium is dropping "Headless" from the user agent.
//
// Known gap: Chromium resolves DNS itself after our check, so a host that rebinds between the
// check and the connection is not caught here (the actor sandbox proxy does not have this gap).

import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Response, Route } from 'playwright-core';
import { isPrivateAddress } from '../safeFetch.ts';
import { hostAllowed } from './proxy.ts';

const HTML_CAP = 1_500_000;
const RAW_HTML_CAP = 8_000_000; // probe looks for embedded JSON past the returned cap
const TEXT_CAP = 100_000;
const LINKS_CAP = 500;
const JSON_BODY_CAP = 300_000;
const JSON_MAX = 25;
const IDLE_CLOSE_MS = 60_000;
const MAX_CONCURRENT = 3;
const SKIP_TYPES = new Set(['image', 'font', 'media']);
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export interface RenderOptions {
  waitMs?: number;
  /** Number of times to scroll down by one viewport. */
  scroll?: number;
  /** Regex for response URLs to capture. Default: every JSON / XHR / fetch response. */
  capture?: string;
  allowHosts: string[];
  /** Persistent profile name (the "session" tier). */
  profile?: string;
  timeoutMs?: number;
}

export interface CapturedJson {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated?: boolean;
}

export interface RenderResult {
  url: string;
  status: number;
  title: string;
  html: string;
  text: string;
  links: { href: string; text: string }[];
  json: CapturedJson[];
  blocked: string[];
}

export interface ProbeJson {
  url: string;
  status: number;
  contentType: string;
  size: number;
  shape: unknown;
  /** Arrays of objects found inside the body (candidate post lists). */
  lists: { path: string; length: number; keys: string[] }[];
}

export interface ProbeResult {
  url: string;
  status: number;
  title: string;
  text: string;
  json: ProbeJson[];
  embedded: (Omit<ProbeJson, 'url' | 'status' | 'contentType'> & { name: string })[];
  links: { href: string; text: string }[];
  blocked: string[];
}

export interface BrowserService {
  render(url: string, opts: RenderOptions): Promise<RenderResult>;
  probe(url: string, opts: RenderOptions): Promise<ProbeResult>;
  openLoginWindow(profile: string, url: string): Promise<void>;
  close(): Promise<void>;
}

/** Where Chromium or Chrome usually lives on each platform; CHROMIUM_PATH wins everywhere. */
export function chromiumCandidates(platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  if (platform === 'darwin') {
    const apps = [
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return [...apps.map((a) => path.join('/Applications', a)), ...apps.map((a) => path.join(home, 'Applications', a))];
  }
  if (platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Chromium', 'Application', 'chrome.exe')]);
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium'];
}

export function findChromium(): string | null {
  for (const c of [process.env.CHROMIUM_PATH, ...chromiumCandidates()]) if (c && fs.existsSync(c)) return c;
  return null;
}

async function hostIsPublic(host: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  if (net.isIP(host)) return !isPrivateAddress(host);
  let p = cache.get(host);
  if (!p) {
    p = dns.promises
      .lookup(host, { all: true, verbatim: true })
      .then((a) => a.length > 0 && !a.some((x) => isPrivateAddress(x.address)))
      .catch(() => false);
    cache.set(host, p);
  }
  return p;
}

let cachedUa: string | null = null;
/** UA from `chromium --version`, for persistent contexts that need it before launch. */
function versionUa(exe: string): string {
  if (!cachedUa) {
    let v = '';
    try {
      v = /(\d+\.\d+\.\d+\.\d+)/.exec(execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 10_000 }))?.[1] ?? '';
    } catch {}
    cachedUa = chromeUa(v);
  }
  return cachedUa;
}

function chromeUa(version: string): string {
  const major = version.split('.')[0] || '140';
  // Match the real OS: sites compare the UA with navigator.platform.
  const osPart = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const LAUNCH_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=DnsOverHttps'];

// ---------------------------------------------------------------- app-owned profiles (session tier)
// Signed-in sources use profiles that live only under <dataDir>/browser-profiles/<name>. Nothing
// here ever reads the user's own browser profiles, and cookie values are never read or returned.

export { PROFILE_RE };

/** Root folder of the app's own Chromium profiles. */
export function profileRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'browser-profiles');
}

/** Folder of one app-owned profile (created on demand). Throws on a bad name. */
export function profileDirFor(dataDir: string, profile: string, create = true): string {
  if (!PROFILE_RE.test(profile)) throw new Error('Invalid profile name');
  const root = profileRoot(dataDir);
  const d = path.join(root, profile);
  if (path.dirname(d) !== root) throw new Error('Invalid profile name');
  if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Profile name a session-tier actor uses: its platform label as a slug (e.g. "facebook"). */
export function sessionProfileFor(manifest: { platform?: string; id: string }): string {
  const slug = String(manifest.platform ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61);
  return PROFILE_RE.test(slug) ? slug : manifest.id;
}

// Chromium locks a profile directory, so every user of one profile (actor renders, login
// sessions) takes turns. Module level so separate services in one process share it.
const profileLocks = new Map<string, Promise<unknown>>();
const profileHolders = new Map<string, number>();

/** Waits for the profile, returns a release function. */
export async function acquireProfile(dataDir: string, profile: string): Promise<() => void> {
  const key = profileDirFor(dataDir, profile, false);
  const prev = profileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.catch(() => {}).then(() => mine);
  profileLocks.set(key, chained);
  profileHolders.set(key, (profileHolders.get(key) ?? 0) + 1);
  await prev.catch(() => {});
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    const n = (profileHolders.get(key) ?? 1) - 1;
    if (n <= 0) profileHolders.delete(key);
    else profileHolders.set(key, n);
    if (profileLocks.get(key) === chained) profileLocks.delete(key);
  };
}

/** True while a login session or a render holds (or waits for) the profile. */
export function profileBusy(dataDir: string, profile: string): boolean {
  return (profileHolders.get(profileDirFor(dataDir, profile, false)) ?? 0) > 0;
}

// Cloud mode must never hold Meta or X sessions.
const CLOUD_BLOCKED_DOMAINS = ['facebook.com', 'fb.com', 'fbcdn.net', 'messenger.com', 'instagram.com', 'cdninstagram.com', 'threads.net', 'threads.com', 'meta.com', 'x.com', 'twitter.com', 'twimg.com'];
const CLOUD_BLOCKED_PROFILES = /^(facebook|fb|meta|messenger|instagram|ig|threads|x|twitter)(-|$)/;

export function isCloud(): boolean {
  return process.env.SR_CLOUD === '1';
}

/** True when this host (or a profile name) is a Meta / X property. */
export function isMetaOrX(hostOrProfile: string): boolean {
  const h = hostOrProfile.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.')) return CLOUD_BLOCKED_PROFILES.test(h);
  return CLOUD_BLOCKED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/** Throws in cloud mode when a profile, URL or host list touches Meta or X. */
export function assertCloudAllowed(profile: string, hostsOrUrls: string[] = []): void {
  if (!isCloud()) return;
  const hosts = hostsOrUrls.map((h) => {
    try {
      return /^[a-z]+:\/\//i.test(h) ? new URL(h).hostname : h.replace(/^\*\./, '');
    } catch {
      return h;
    }
  });
  if (isMetaOrX(profile) || hosts.some(isMetaOrX)) throw new Error('Cloud mode does not keep signed-in sessions for Facebook, Instagram, Threads or X. Run Aurora on your own machine for those.');
}

export interface GuardOptions {
  /** Host allowlist; null allows any public host (login windows). */
  allowHosts: string[] | null;
  /** Skip images, fonts and media (default true). */
  skipMedia?: boolean;
  /** Extra hosts to refuse even when allowed (cloud mode Meta / X block). */
  deny?: (host: string) => boolean;
}

/** Route every request and WebSocket of a context through the allowlist and private-address checks. */
export async function guardContext(context: BrowserContext, o: GuardOptions, blocked: Set<string>): Promise<void> {
  const dnsCache = new Map<string, Promise<boolean>>();
  const skipMedia = o.skipMedia ?? true;
  const check = async (raw: string): Promise<string | null> => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return 'bad url';
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return null;
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return `scheme ${u.protocol}`;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (o.allowHosts && !hostAllowed(host, o.allowHosts)) return 'host not in allowlist';
    if (o.deny?.(host)) return 'host refused';
    if (!(await hostIsPublic(host, dnsCache))) return 'private or unresolvable address';
    return null;
  };
  const note = (url: string, reason: string) => {
    if (blocked.size >= 100) return;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {}
    blocked.add(`${host}: ${reason}`);
  };
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    if (skipMedia && SKIP_TYPES.has(req.resourceType())) return route.abort('blockedbyclient').catch(() => {});
    const reason = await check(req.url());
    if (reason) {
      note(req.url(), reason);
      return route.abort('blockedbyclient').catch(() => {});
    }
    return route.continue().catch(() => {});
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const reason = await check(ws.url());
    if (reason) {
      note(ws.url(), reason);
      return ws.close();
    }
    ws.connectToServer();
  });
}

/** Persistent context for an app-owned profile. Hold the profile lock while it is open. */
export function launchProfileContext(dir: string, o: { headless: boolean; viewport?: { width: number; height: number } | null }): Promise<BrowserContext> {
  const exe = findChromium();
  if (!exe) throw new Error('Chromium not found (set CHROMIUM_PATH)');
  return chromium.launchPersistentContext(dir, {
    executablePath: exe,
    headless: o.headless,
    args: LAUNCH_ARGS,
    userAgent: o.headless ? versionUa(exe) : undefined,
    serviceWorkers: 'block',
    acceptDownloads: false,
    locale: 'en-US',
    viewport: o.viewport === undefined ? { width: 1280, height: 900 } : o.viewport,
  });
}

export function createBrowserService(opts: { dataDir: string }): BrowserService {
  let browser: Promise<Browser> | null = null;
  let ua = '';
  let active = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  const waiters: (() => void)[] = [];

  const executablePath = () => {
    const p = findChromium();
    if (!p) throw new Error('Chromium not found (set CHROMIUM_PATH)');
    return p;
  };

  const getBrowser = (): Promise<Browser> => {
    if (!browser) {
      browser = chromium.launch({ executablePath: executablePath(), headless: true, args: LAUNCH_ARGS }).then((b) => {
        ua = chromeUa(b.version());
        b.on('disconnected', () => (browser = null));
        return b;
      });
      browser.catch(() => (browser = null));
    }
    return browser;
  };

  const acquire = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiters.shift()?.();
    if (active === 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        const b = browser;
        browser = null;
        b?.then((x) => x.close()).catch(() => {});
      }, IDLE_CLOSE_MS);
      idleTimer.unref();
    }
  };

  const profileDir = (profile: string) => profileDirFor(opts.dataDir, profile);

  /** Serialise use of one persistent profile (Chromium locks the directory). */
  const withProfile = async <T>(profile: string, fn: () => Promise<T>): Promise<T> => {
    const done = await acquireProfile(opts.dataDir, profile);
    try {
      return await fn();
    } finally {
      done();
    }
  };

  const guard = (context: BrowserContext, allowHosts: string[], blocked: Set<string>) =>
    guardContext(context, { allowHosts, deny: isCloud() ? isMetaOrX : undefined }, blocked);

  async function renderIn(context: BrowserContext, url: string, o: RenderOptions): Promise<RenderResult> {
    const timeoutMs = Math.min(Math.max(o.timeoutMs ?? 45_000, 5_000), 120_000);
    const waitMs = Math.min(Math.max(o.waitMs ?? 1500, 0), 15_000);
    const scroll = Math.min(Math.max(Math.trunc(o.scroll ?? 0), 0), 20);
    let captureRe: RegExp | null = null;
    if (o.capture) {
      try {
        captureRe = new RegExp(o.capture);
      } catch {
        throw new Error('capture must be a valid regular expression');
      }
    }
    const blocked = new Set<string>();
    await guard(context, o.allowHosts, blocked);
    const json: CapturedJson[] = [];
    const pending: Promise<void>[] = [];
    const page: Page = await context.newPage();
    page.on('response', (res: Response) => {
      if (json.length + pending.length >= JSON_MAX) return;
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      const rt = res.request().resourceType();
      if (captureRe ? !captureRe.test(res.url()) : !(ct.includes('json') && (rt === 'xhr' || rt === 'fetch' || rt === 'other'))) return;
      if (res.status() >= 300 && res.status() < 400) return;
      const p = res
        .text()
        .then((body) => {
          const item: CapturedJson = { url: res.url(), status: res.status(), contentType: ct, body: body.slice(0, JSON_BODY_CAP) };
          if (body.length > JSON_BODY_CAP) item.truncated = true;
          if (json.length < JSON_MAX) json.push(item);
        })
        .catch(() => {});
      pending.push(p);
    });
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.max(waitMs, 1000) + 2000 }).catch(() => {});
      if (waitMs) await page.waitForTimeout(waitMs);
      for (let i = 0; i < scroll; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
        await page.waitForTimeout(900);
      }
      if (scroll) await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 5000))]);
      const [title, html, text, links] = await Promise.all([
        page.title().catch(() => ''),
        page.content().catch(() => ''),
        page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
        page
          .evaluate(
            (cap) =>
              Array.from(document.querySelectorAll('a[href]'))
                .slice(0, cap * 2)
                .map((a) => ({ href: (a as HTMLAnchorElement).href, text: ((a as HTMLElement).innerText || '').trim().slice(0, 200) }))
                .filter((l) => /^https?:/.test(l.href)),
            LINKS_CAP,
          )
          .catch(() => [] as { href: string; text: string }[]),
      ]);
      const seen = new Set<string>();
      return {
        url: page.url(),
        status: resp?.status() ?? 0,
        title,
        html: html.slice(0, RAW_HTML_CAP),
        text: text.slice(0, TEXT_CAP),
        links: links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, LINKS_CAP),
        json: [...json],
        blocked: [...blocked],
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  const renderFull = async (url: string, o: RenderOptions): Promise<RenderResult> => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {}
    if (!/^https?:\/\//i.test(url) || !host) throw new Error('render needs an http(s) URL');
    if (!hostAllowed(host, o.allowHosts)) throw new Error(`Host not in allowlist: ${host}`);
    if (o.profile) {
      assertCloudAllowed(o.profile, [url, ...o.allowHosts]);
      // Renders never create a profile; only the user signing in does.
      const dir = profileDirFor(opts.dataDir, o.profile, false);
      if (!fs.existsSync(dir)) throw new Error(`No signed-in browser profile "${o.profile}". The user needs to sign in to it in Aurora first.`);
      return withProfile(o.profile, async () => {
        const ctx = await launchProfileContext(dir, { headless: true });
        try {
          await Promise.all(ctx.pages().map((p) => p.close().catch(() => {})));
          return await renderIn(ctx, url, o);
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    }
    await acquire();
    try {
      const b = await getBrowser();
      const ctx = await b.newContext({
        userAgent: ua,
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      try {
        return await renderIn(ctx, url, o);
      } finally {
        await ctx.close().catch(() => {});
      }
    } finally {
      release();
    }
  };

  const render: BrowserService['render'] = async (url, o) => {
    const r = await renderFull(url, o);
    return { ...r, html: r.html.slice(0, HTML_CAP) };
  };

  const probe: BrowserService['probe'] = async (url, o) => {
    const r = await renderFull(url, o);
    const json: ProbeJson[] = [];
    for (const j of r.json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripXssi(j.body));
      } catch {
        parsed = undefined;
      }
      json.push({
        url: j.url.slice(0, 500),
        status: j.status,
        contentType: j.contentType,
        size: j.body.length,
        shape: parsed === undefined ? `unparsed: ${j.body.slice(0, 120)}` : shapeOf(parsed),
        lists: parsed === undefined ? [] : findLists(parsed),
      });
    }
    return {
      url: r.url,
      status: r.status,
      title: r.title,
      text: r.text.slice(0, 3000),
      json,
      embedded: embeddedJson(r.html),
      links: r.links.slice(0, 40),
      blocked: r.blocked,
    };
  };

  const openLoginWindow: BrowserService['openLoginWindow'] = async (profile, url) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Login URL must be https');
    assertCloudAllowed(profile, [url]);
    const dir = profileDir(profile);
    await withProfile(profile, async () => {
      const ctx = await launchProfileContext(dir, { headless: false, viewport: null });
      await guardContext(ctx, { allowHosts: null, skipMedia: false, deny: isCloud() ? isMetaOrX : undefined }, new Set());
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url).catch(() => {});
      // Done when the user closes the window (the last page) or the browser.
      await new Promise<void>((resolve) => {
        ctx.on('close', () => resolve());
        const check = () => {
          if (ctx.pages().length === 0) resolve();
        };
        ctx.on('page', (p) => p.on('close', check));
        for (const p of ctx.pages()) p.on('close', check);
      });
      await ctx.close().catch(() => {});
    });
  };

  return {
    render,
    probe,
    openLoginWindow,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      const b = browser;
      browser = null;
      await b?.then((x) => x.close()).catch(() => {});
    },
  };
}

function stripXssi(s: string): string {
  return s.replace(/^\)\]\}',?\s*/, '').replace(/^for\s*\(;;\);/, '');
}

/** Shallow description of a JSON value: keys, array lengths, short string samples. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return depth >= 3 ? `array(${v.length})` : { array: v.length, first: v.length ? shapeOf(v[0], depth + 1) : null };
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object);
    if (depth >= 3) return `{${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}}`;
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, depth === 0 ? 25 : 12)) out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    if (keys.length > (depth === 0 ? 25 : 12)) out['…'] = `${keys.length} keys`;
    return out;
  }
  if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 60)) + '…' : JSON.stringify(v);
  return v === null ? null : typeof v;
}

/** Paths to the largest arrays of 3+ objects, up to depth 12 (where post lists usually live). */
export function findLists(root: unknown, max = 8): { path: string; length: number; keys: string[] }[] {
  const out: { path: string; length: number; keys: string[] }[] = [];
  let visited = 0;
  const walk = (v: unknown, p: string, depth: number) => {
    if (++visited > 20_000 || depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 3) out.push({ path: p || '$', length: v.length, keys: Object.keys(objs[0] as object).slice(0, 20) });
      for (let i = 0; i < Math.min(v.length, 10); i++) walk(v[i], `${p}[${i}]`, depth + 1);
      return;
    }
    for (const [k, c] of Object.entries(v as Record<string, unknown>).slice(0, 80)) walk(c, p ? `${p}.${k}` : k, depth + 1);
  };
  walk(root, '', 0);
  return out.sort((a, b) => b.length - a.length).slice(0, max);
}

/** JSON embedded in the HTML: <script type=application/json|ld+json> and `var|window.NAME = {...};` blobs. */
function embeddedJson(html: string): ProbeResult['embedded'] {
  const out: ProbeResult['embedded'] = [];
  const add = (name: string, raw: string) => {
    if (out.length >= 8 || raw.length < 200) return;
    try {
      const parsed = JSON.parse(raw);
      out.push({ name, size: raw.length, shape: shapeOf(parsed), lists: findLists(parsed) });
    } catch {}
  };
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const body = m[2].trim();
    const type = /type\s*=\s*["']([^"']+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type === 'application/json' || type === 'application/ld+json') {
      add(`script${/id\s*=\s*["']([^"']+)/i.exec(attrs)?.[1] ? '#' + /id\s*=\s*["']([^"']+)/i.exec(attrs)![1] : `[type=${type}]`}`, body);
      continue;
    }
    const a = /^(?:var\s+|window\.|self\.)?([A-Za-z_$][\w$]*)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(body) ??
      /(?:var\s+|window\[["']|window\.)([A-Za-z_$][\w$]*)["']?\]?\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|$|var |window)/.exec(body);
    if (a) add(a[1], a[2]);
  }
  return out;
}
