// The macOS and Windows branches, exercised from any OS by passing the platform in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEEDS_SANDBOX, buildSandboxCommand, seatbeltAvailable, seatbeltParams, unsandboxedAllowed } from '../server/actors/sandbox.ts';
import { chromiumCandidates } from '../server/actors/browser.ts';
import { hasDisplay } from '../server/login.ts';

test('AI-built connectors never run unsandboxed on macOS or Windows unless the owner opts in', () => {
  assert.equal(unsandboxedAllowed('darwin', {}), false);
  assert.equal(unsandboxedAllowed('win32', {}), false);
  assert.equal(unsandboxedAllowed('darwin', { SR_ACTOR_ISOLATION: 'auto' }), false);
  assert.equal(unsandboxedAllowed('darwin', { SR_ACTOR_ISOLATION: 'none' }), true);
  // Linux keeps its labelled fallback for containers where bubblewrap cannot start.
  assert.equal(unsandboxedAllowed('linux', {}), true);
  assert.match(NEEDS_SANDBOX, /Docker \(docs\/self-hosting\.md\)/);
});

test('macOS uses Seatbelt for AI-built connectors unless the owner turns isolation off', () => {
  assert.equal(seatbeltAvailable('linux', {}), false);
  assert.equal(seatbeltAvailable('win32', {}), false);
  assert.equal(seatbeltAvailable('darwin', { SR_ACTOR_ISOLATION: 'none' }), false);
  if (process.platform === 'darwin') assert.equal(seatbeltAvailable('darwin', {}), true);
  const p = seatbeltParams({ tmp: '/nope/tmp', actorDir: '/nope/a', cacheDir: '/nope/c', uv: null, proxyUrl: 'http://sr:tok@127.0.0.1:51234', home: '/nope/home' });
  // Only the proxy port is reachable, never the token or another port.
  assert.equal(p.PROXY, 'localhost:51234');
  assert.equal(p.HOME_DIR, '/nope/home');
  assert.equal(p.UV_PYTHONS, '/nope/home/.local/share/uv/python');
});

test('under Seatbelt a connector cannot read your home folder, write outside its own folders or open sockets', { skip: process.platform !== 'darwin' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-sb-'));
  const actorDir = path.join(base, 'actor');
  fs.mkdirSync(actorDir);
  const secret = fs.mkdtempSync(path.join(os.homedir(), '.sr-sb-test-'));
  fs.writeFileSync(path.join(secret, 'key'), 'secret');
  fs.writeFileSync(
    path.join(actorDir, 'main.ts'),
    `import fs from 'node:fs'; import net from 'node:net';
const out: Record<string, string> = {};
const t = (k: string, f: () => unknown) => { try { f(); out[k] = 'ok'; } catch (e: any) { out[k] = e.code; } };
t('readHome', () => fs.readFileSync(${JSON.stringify(path.join(secret, 'key'))}));
t('listHome', () => fs.readdirSync(${JSON.stringify(os.homedir())}));
t('writeHome', () => fs.writeFileSync(${JSON.stringify(path.join(secret, 'w'))}, 'x'));
t('writeTmp', () => fs.writeFileSync(process.env.TMPDIR + '/w', 'x'));
out.net = await new Promise((r) => { const s = net.connect(443, '1.1.1.1'); s.on('connect', () => { s.destroy(); r('ok'); }); s.on('error', (e: any) => r(e.code)); });
console.log(JSON.stringify(out));`,
  );
  const manifest = { id: 'sbtest', name: 'sbtest', version: 1, runtime: 'node', entry: 'main.ts', platform: 'x', tier: 'http', hosts: [] } as never;
  const cmd = await buildSandboxCommand({ manifest, actorDir, cacheDir: path.join(base, 'cache'), socketPath: '', proxyUrl: 'http://sr:t@127.0.0.1:9', env: {} });
  try {
    assert.equal(cmd.isolation, 'seatbelt');
    const { execFileSync } = await import('node:child_process');
    const out = JSON.parse(execFileSync(cmd.cmd, cmd.args, { env: cmd.env, cwd: cmd.cwd, encoding: 'utf8' }).trim());
    assert.deepEqual(out, { readHome: 'EPERM', listHome: 'EPERM', writeHome: 'EPERM', writeTmp: 'ok', net: 'EPERM' });
  } finally {
    cmd.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(secret, { recursive: true, force: true });
  }
});

test('Chrome and Chromium are found in the usual macOS places', () => {
  const c = chromiumCandidates('darwin', '/Users/tal');
  assert.ok(c.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(c.includes('/Applications/Chromium.app/Contents/MacOS/Chromium'));
  assert.ok(c.includes('/Users/tal/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(chromiumCandidates('linux').includes('/usr/bin/chromium'));
});

test('a Mac desktop can open a real browser window without DISPLAY', () => {
  assert.equal(hasDisplay('darwin', {}), true);
  assert.equal(hasDisplay('darwin', { SSH_CONNECTION: '1 2 3 4' }), false);
  assert.equal(hasDisplay('linux', {}), false);
  assert.equal(hasDisplay('linux', { WAYLAND_DISPLAY: 'wayland-1' }), true);
});
