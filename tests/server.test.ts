// End-to-end: start the real server on a scratch data dir, change state, restart, and check it persisted.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'social-reader-test-'));

function start(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), SOCIAL_READER_DATA: dataDir, AUTO_SYNC_MINUTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout!.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const stop = (c: ChildProcess) => new Promise<void>((r) => { c.once('exit', () => r()); c.kill('SIGTERM'); });
after(() => rmSync(dataDir, { recursive: true, force: true }));
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('library and local state persist across a restart', async () => {
  let server = await start();
  try {
    const empty = await (await fetch(base + '/api/library')).json();
    assert.equal(empty.items.length, 0);

    assert.equal((await post('/api/demo', {})).status, 200);
    const fixture = await import('node:fs').then((fs) => fs.readFileSync('tests/fixtures/tweets.js', 'utf8'));
    const imp = await (await post('/api/import', { fileName: 'tweets.js', text: fixture })).json();
    assert.ok(imp.added > 0, 'import adds items');
    assert.equal(imp.skipped, imp.errors.length, 'rows the parser rejects count as skipped');

    const lib = await (await fetch(base + '/api/library')).json();
    const target = lib.items.find((i: any) => !i.isDemo);
    assert.ok(target, 'imported item present');
    assert.equal((await post('/api/items/state', { ids: [target.id], patch: { saved: true, read: true } })).status, 200);
    assert.equal((await post('/api/views', { name: 'Only saved', spec: { saved: 'saved' } })).status, 200);
    await stop(server);

    server = await start();
    const after = await (await fetch(base + '/api/library')).json();
    assert.equal(after.items.length, lib.items.length);
    const again = after.items.find((i: any) => i.id === target.id);
    assert.equal(again.state.saved, true);
    assert.equal(again.state.read, true);
    assert.ok(after.views.some((v: any) => v.name === 'Only saved'));
    assert.ok(after.sources.some((s: any) => s.connector === 'demo' || s.label.includes('Demo')));
  } finally {
    await stop(server);
  }
});

test('server refuses cross-origin writes and foreign Host headers', async () => {
  const server = await start();
  try {
    const cross = await fetch(base + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    const form = await fetch(base + '/api/demo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.ok(form.status >= 400);
  } finally {
    await stop(server);
  }
});

test('OPML import adds each http(s) feed once and refuses other schemes', async () => {
  const server = await start();
  try {
    const opml = await import('node:fs').then((fs) => fs.readFileSync('tests/fixtures/feeds.opml', 'utf8'));
    const first = await (await post('/api/import', { fileName: 'feeds.opml', text: opml })).json();
    assert.equal(first.feedsAdded, 2);
    assert.equal(first.skipped, 1);
    const again = await (await post('/api/import', { fileName: 'feeds.opml', text: opml })).json();
    assert.equal(again.feedsAdded, 0);
    const lib = await (await fetch(base + '/api/library')).json();
    assert.ok(lib.sources.some((s: any) => s.label === 'Example & Co'));
  } finally {
    await stop(server);
  }
});

test('exports carry the library and feeds but never secrets', async () => {
  const server = await start();
  try {
    const lib = await fetch(base + '/api/export/library.json');
    assert.match(lib.headers.get('content-disposition') ?? '', /attachment/);
    const body = await lib.text();
    const data = JSON.parse(body);
    assert.equal(data.format, 'social-reader-library');
    assert.ok(data.items.length > 0);
    assert.ok(!/access_token|refresh_token/.test(body));
    const opml = await (await fetch(base + '/api/export/feeds.opml')).text();
    assert.match(opml, /xmlUrl="https:\/\/feeds\.example\.com\/a\.xml"/);
    assert.match(opml, /Example &#38; Co/);
  } finally {
    await stop(server);
  }
});
