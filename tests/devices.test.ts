// Phone pairing end to end: start a pairing on "the desktop", claim it as "the phone", approve,
// collect the token once, use it, hit the limits of what a phone may do, then revoke it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const PORT = 4800 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'aurora-devices-test-'));

function start(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), SOCIAL_READER_DATA: dataDir, AUTO_SYNC_MINUTES: '0', HOST: '127.0.0.1' },
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

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

/** fetch() will not send a custom Host header, so use node:http for that one check. */
function getWithHost(path: string, host: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('a phone pairs only after approval, gets a reader subset, and can be revoked', async () => {
  const server = await start();
  try {
    const pair = await (await json('POST', '/api/devices/pair', {})).json();
    assert.match(pair.code, /^[a-f0-9]{12}\./);
    assert.equal(pair.lan, false, 'default bind is loopback, so no LAN URLs');

    // A wrong secret is refused; the right one claims once.
    assert.equal((await json('POST', '/api/devices/claim', { pair: `${pair.id}.wrongwrongwrongwrongwrong` })).status, 404);
    const claim = await (await json('POST', '/api/devices/claim', { pair: pair.code, name: 'Test phone', platform: 'android' })).json();
    assert.match(claim.check, /^\d{4}$/);
    assert.equal((await json('POST', '/api/devices/claim', { pair: pair.code, name: 'Second phone' })).status, 409);

    // No token before approval, and only the claimer can poll.
    assert.equal((await (await json('POST', '/api/devices/claim/status', { pair: pair.code, claimKey: claim.claimKey })).json()).state, 'claimed');
    assert.equal((await json('POST', '/api/devices/claim/status', { pair: pair.code, claimKey: 'nope' })).status, 403);
    const seen = await (await fetch(`${base}/api/devices/pair/${pair.id}`)).json();
    assert.equal(seen.claim.name, 'Test phone');
    assert.equal(seen.claim.check, claim.check);

    assert.equal((await json('POST', `/api/devices/pair/${pair.id}/approve`, { approve: true })).status, 200);
    const done = await (await json('POST', '/api/devices/claim/status', { pair: pair.code, claimKey: claim.claimKey })).json();
    assert.equal(done.state, 'approved');
    assert.match(done.token, /^aur_[a-z0-9]{12}_/);
    // The token is handed out once.
    assert.equal((await json('POST', '/api/devices/claim/status', { pair: pair.code, claimKey: claim.claimKey })).status, 404);

    const auth = { authorization: `Bearer ${done.token}` };
    assert.equal((await fetch(base + '/api/library', { headers: auth })).status, 200);
    assert.ok(![401, 403].includes((await json('POST', '/api/items/state', { ids: ['x'], patch: { saved: true } }, auth)).status), 'phones may save and hide');
    assert.equal((await json('POST', '/api/sources', { connector: 'rss' }, auth)).status, 403, 'phones cannot add sources');
    assert.equal((await fetch(base + '/api/devices', { headers: auth })).status, 403, 'phones cannot list devices');
    assert.equal((await fetch(base + '/api/library', { headers: { authorization: 'Bearer aur_000000000000_' + 'x'.repeat(40) } })).status, 401);
    assert.equal(await getWithHost('/api/library', '192.168.1.20:' + PORT, auth), 421, 'loopback bind: no LAN host even with a token');

    // Only the hash is stored.
    const list = await (await fetch(base + '/api/devices')).json();
    assert.equal(list.devices.length, 1);
    assert.equal(list.devices[0].hash, undefined);
    assert.equal((await json('DELETE', `/api/devices/${list.devices[0].id}`)).status, 200);
    assert.equal((await fetch(base + '/api/library', { headers: auth })).status, 401, 'revoked');
  } finally {
    await stop(server);
  }
});
