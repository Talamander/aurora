// Cold-start check: starts a server on a scratch library, opens the app the moment it listens and
// again while the background start-up work runs, and probes how responsive the server stays.
//
//   node scripts/perf-startup.ts --data /tmp/aurora-perf-copy --port 4512 [--chromium /usr/bin/chromium]
//
// Point --data at a FRESH COPY of a synthetic library (scripts/synth-library.ts) with no search.db,
// so the run includes building the search index from nothing. It refuses anything that looks like
// a real Aurora data folder. The server is stopped at the end.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const data = arg('data');
const port = Number(arg('port', '4512'));
const exe = arg('chromium', process.env.CHROMIUM ?? '/usr/bin/chromium');
const probeFor = Number(arg('probe-ms', '15000'));
if (!data) {
  console.error('usage: node scripts/perf-startup.ts --data <scratch-copy> --port <port>');
  process.exit(2);
}
if (resolve(data) === resolve('data') || existsSync(join(data, 'browser-profiles'))) {
  console.error('Refusing: this looks like a real Aurora data folder.');
  process.exit(2);
}
if (!existsSync(join(data, 'social-reader.db'))) {
  console.error(`No library in ${data}. Pass a fresh copy of a folder made by scripts/synth-library.ts.`);
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;
const ms = (n: number) => `${Math.round(n)} ms`;
const row = (k: string, v: string) => console.log(`${k.padEnd(44)} ${v}`);

const t0 = performance.now();
const child = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, PORT: String(port), SOCIAL_READER_DATA: data, AUTO_SYNC_MINUTES: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log: { at: number; line: string }[] = [];
const onLine = (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach((line) => log.push({ at: performance.now() - t0, line }));
child.stdout.on('data', onLine);
child.stderr.on('data', onLine);
const stop = () => child.kill('SIGTERM');
process.on('exit', stop);

async function up() {
  for (;;) {
    try {
      const r = await fetch(base + '/index.html');
      if (r.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 10));
    if (performance.now() - t0 > 30_000) throw new Error('server did not start');
  }
}
await up();
const listening = performance.now() - t0;
row('Process start to listening', ms(listening));

// A static file every 25 ms for the probe window: any long gap is the event loop blocked.
const stalls: { at: number; ms: number }[] = [];
let worst = { at: 0, ms: 0 };
const probing = (async () => {
  while (performance.now() - t0 < probeFor) {
    const s = performance.now();
    await fetch(base + '/index.html').then((r) => r.arrayBuffer()).catch(() => {});
    const d = performance.now() - s;
    if (d > worst.ms) worst = { at: s - t0, ms: d };
    if (d > 60) stalls.push({ at: s - t0, ms: d });
    await new Promise((r) => setTimeout(r, 25));
  }
})();

const browser = await chromium.launch({ executablePath: exe });
async function firstPost(label: string) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
  const opened = performance.now();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article.post, .post', { timeout: 60_000 });
  const shown = performance.now();
  row(label, `${ms(shown - opened)} (opened at ${ms(opened - t0)})`);
  await page.context().close();
}
await firstPost('First post, page opened on listen');
// Search index build starts 2.5 s after start; open again in the middle of it.
const midBuild = 3000 - (performance.now() - t0);
if (midBuild > 0) await new Promise((r) => setTimeout(r, midBuild));
await firstPost('First post, page opened during index build');
await probing;
await browser.close();

row('Worst probe latency (first 15 s)', `${ms(worst.ms)} at ${ms(worst.at)}`);
row('Probes slower than 60 ms', stalls.length ? stalls.map((s) => `${ms(s.ms)}@${(s.at / 1000).toFixed(1)}s`).join(', ') : 'none');
const all = process.argv.includes('--log');
for (const l of log) if (all || /\[search\]|\[library\]|warm|error/i.test(l.line)) row(`  log at ${ms(l.at)}`, all ? l.line : l.line.slice(0, 90));
stop();
process.exit(0);
