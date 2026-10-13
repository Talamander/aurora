// Performance check for a running Aurora. Prints server, wire and browser numbers.
//
//   npm run perf -- --url http://127.0.0.1:4390 [--chromium /usr/bin/chromium]
//
// Use it against a scratch server (see scripts/synth-library.ts for a 100k-post library), never
// against one holding data you care about: it types into search but changes nothing.

import { chromium } from 'playwright-core';

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const base = (arg('url', process.env.AURORA_URL ?? 'http://127.0.0.1:4317') as string).replace(/\/+$/, '');
const exe = arg('chromium', process.env.CHROMIUM ?? '/usr/bin/chromium');
const out: [string, string][] = [];
const row = (k: string, v: string) => {
  out.push([k, v]);
  console.log(`${k.padEnd(34)} ${v}`);
};
const ms = (n: number) => `${Math.round(n)} ms`;
const mb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

async function timeFetch(path: string, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const res = await fetch(base + path, { headers });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { ms: performance.now() - t0, status: res.status, bytes: Number(res.headers.get('content-length') ?? 0) || buf.length, etag: res.headers.get('etag') };
}

// ---- wire. Node's fetch decodes br transparently, so sizes come from a raw request.
async function wireSize(path: string) {
  const { request } = await import('node:http');
  return new Promise<{ bytes: number; ms: number }>((resolveP, reject) => {
    const t0 = performance.now();
    const req = request(base + path, { headers: { 'accept-encoding': 'br' } }, (res) => {
      let n = 0;
      res.on('data', (c) => (n += c.length));
      res.on('end', () => resolveP({ bytes: n, ms: performance.now() - t0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

const full = await wireSize('/api/library');
row('GET /api/library (br, cold)', `${mb(full.bytes)} in ${ms(full.ms)}`);
const full2 = await wireSize('/api/library');
row('GET /api/library (br, again)', `${mb(full2.bytes)} in ${ms(full2.ms)}`);
const first = await timeFetch('/api/library');
if (first.etag) {
  const revalidate = await timeFetch('/api/library', { 'if-none-match': first.etag });
  row('GET /api/library (304)', `${revalidate.status} in ${ms(revalidate.ms)}`);
}
// The web app's chunked sync: a small manifest, then one request per week of posts.
const manifest = (await (await fetch(base + '/api/library?items=chunks')).json()) as { itemChunks?: { key: string; n: number; hash: string }[]; itemsTotal?: number };
if (manifest.itemChunks) {
  const m = await wireSize('/api/library?items=chunks');
  row('GET manifest (br)', `${mb(m.bytes)} in ${ms(m.ms)}`);
  const c0 = manifest.itemChunks[0];
  if (c0) {
    const c = await wireSize(`/api/library/chunks/${c0.key}?h=${c0.hash}`);
    row(`GET newest chunk (${c0.n} posts, br)`, `${mb(c.bytes)} in ${ms(c.ms)}`);
  }
  row('Chunks / posts', `${manifest.itemChunks.length} / ${manifest.itemsTotal}`);
}

// ---- full-text search (server/search.ts), when this server has it
type Status = { indexed: number; total: number; building: boolean };
let hasFts = false;
const status = async () => {
  const r = await fetch(base + '/api/search/status').catch(() => null);
  return r?.ok ? ((await r.json()) as Status) : null;
};
if (await status()) {
  hasFts = true;
  const w0 = Date.now();
  let s = (await status())!;
  while (s.building || s.indexed < s.total) {
    if (Date.now() - w0 > 600_000) break;
    await new Promise((r) => setTimeout(r, 250));
    s = (await status())!;
  }
  row('Search index ready', `${s.indexed} posts (waited ${ms(Date.now() - w0)})`);
  const median = async (path: string) => {
    const t: number[] = [];
    let body: any = null;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      body = await (await fetch(base + path)).json();
      t.push(performance.now() - t0);
    }
    return { ms: t.sort((a, b) => a - b)[3], body };
  };
  let firstId: string | undefined;
  for (const q of ['sqlite', 'garden -giveaway', '"release paper"', 'compil', 'zzqx']) {
    const r = await median(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
    firstId ??= r.body.results?.[0]?.id;
    row(`GET /api/search "${q}"`, `${ms(r.ms)} median, ${r.body.matched} matched`);
  }
  if (firstId) {
    const r = await median(`/api/items/${encodeURIComponent(firstId)}/related?limit=10`);
    row('GET related (More like this)', `${ms(r.ms)} median, ${r.body.results?.length ?? 0} results`);
  }
}

// ---- browser
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  const w = window as any;
  w.__lt = { total: 0, max: 0 };
  new PerformanceObserver((l) => l.getEntries().forEach((e) => ((w.__lt.total += e.duration), (w.__lt.max = Math.max(w.__lt.max, e.duration))))).observe({ type: 'longtask', buffered: true });
});
const t0 = Date.now();
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article.post, .post', { timeout: 120_000 });
row('First post visible', ms(Date.now() - t0));
if (manifest.itemChunks) {
  await page.waitForFunction(() => !document.querySelector('.feed-count-more'), null, { timeout: 120_000 }).catch(() => {});
  row('Whole library loaded', ms(Date.now() - t0));
}
await page.waitForTimeout(1500);
const lt = await page.evaluate(() => (window as any).__lt as { total: number; max: number });
row('Long tasks during load (sum / max)', `${ms(lt.total)} / ${ms(lt.max)}`);
const heap = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);
if (heap) row('JS heap after load', mb(heap));

// Search: time from the last keystroke until the feed count settles.
const search = page.locator('label.search input');
const typeAndSettle = async (q: string) => {
  await search.fill('');
  await page.waitForTimeout(300);
  const before = await page.locator('.feed-count').first().textContent().catch(() => '');
  const s = Date.now();
  await search.fill(q);
  await page.waitForFunction((b) => document.querySelector('.feed-count')?.textContent !== b, before, { timeout: 60_000 }).catch(() => {});
  return Date.now() - s;
};
row('Search "sqlite" settles', ms(await typeAndSettle('sqlite')));
row('Search "garden -giveaway" settles', ms(await typeAndSettle('garden -giveaway')));
if (hasFts) {
  // Best matches: time from the last keystroke until the ranked block shows (includes its debounce).
  await search.fill('');
  await page.waitForTimeout(400);
  const s = Date.now();
  await search.fill('sourdough espresso');
  await page.waitForSelector('.best-matches', { timeout: 30_000 }).catch(() => {});
  row('Best matches visible', ms(Date.now() - s));
}
// Clearing the search re-filters the whole library (one long task). Let it finish before the
// scroll test starts, or that task lands in the scroll numbers some runs and not others.
{
  const before = await page.locator('.feed-count').first().textContent().catch(() => '');
  await search.fill('');
  await page.waitForFunction((b) => document.querySelector('.feed-count')?.textContent !== b, before, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

// Long tasks while scrolling the feed.
const scroll = await page.evaluate(async () => {
  let total = 0;
  let max = 0;
  const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => ((total += e.duration), (max = Math.max(max, e.duration)))));
  obs.observe({ type: 'longtask', buffered: false });
  // The feed scrolls inside main.feed on desktop; fall back to the page.
  const feed = document.querySelector('main.feed') as HTMLElement | null;
  const sc = feed && feed.scrollHeight > feed.clientHeight + 10 ? feed : (document.scrollingElement ?? document.documentElement);
  for (let i = 0; i < 20; i++) {
    sc.scrollBy(0, 1200);
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 300));
  obs.disconnect();
  return { total, max };
});
row('Long tasks while scrolling 24k px', `${ms(scroll.total)} (max ${ms(scroll.max)})`);
const posts = await page.locator('.post').count();
row('Posts in the DOM after scroll', String(posts));

// ---- surfaces opened now and then. Each loads its code on first open, so this is the cost of
// that first open: fetch the chunk, mount, first paint.
const timeOpen = async (label: string, open: () => Promise<unknown>, ready: string, closeKey = 'Escape') => {
  const s = Date.now();
  await open();
  const ok = await page.waitForSelector(ready, { timeout: 30_000 }).then(() => true, () => false);
  row(label, ok ? ms(Date.now() - s) : 'did not open');
  await page.keyboard.press(closeKey);
  await page.waitForTimeout(400);
};
const paletteRun = (q: string) => async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.fill('.palette input', q);
  await page.waitForSelector('.palette-row.on');
  await page.keyboard.press('Enter');
};
await page.locator('main.feed').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
{
  const s = Date.now();
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input', { timeout: 30_000 });
  row('Palette open (first time)', ms(Date.now() - s));
  const t = Date.now();
  await page.fill('.palette input', 'garden');
  await page.waitForFunction(() => [...document.querySelectorAll('.palette-row')].some((r) => r.closest('.palette') && /garden/i.test(r.textContent ?? '')), null, { timeout: 30_000 }).catch(() => {});
  row('Palette first results ("garden")', ms(Date.now() - t));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
await timeOpen('Your week open (first card)', paletteRun('Your week'), '.wk .wk-card');
await timeOpen('Ambient open (first slide)', paletteRun('Ambient'), '.amb-slide');
// The Look sheet opens first and is left to settle, so only the studio itself is timed.
await page.click('button[aria-label="Look and themes"]');
await page.waitForSelector('button.studio-entry');
await page.waitForTimeout(600);
await timeOpen('Theme studio open (from Look)', () => page.click('button.studio-entry', { noWaitAfter: true }), '[role="dialog"][aria-label="Theme studio"]');
{
  const t: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await timeFetch('/api/week');
    t.push(r.ms);
  }
  row('GET /api/week (median of 5)', ms(t.sort((a, b) => a - b)[2]));
}
const transferred = await page.evaluate(() =>
  performance.getEntriesByType('resource').filter((e) => /\.(js|css)$/.test(e.name)).reduce((n, e) => n + ((e as PerformanceResourceTiming).transferSize || 0), 0),
);
if (transferred) row('JS + CSS fetched this session', mb(transferred));
if (errors.length) row('Page errors', errors.slice(0, 3).join(' | '));
await browser.close();
