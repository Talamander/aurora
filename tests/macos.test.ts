// The macOS and Windows branches, exercised from any OS by passing the platform in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEEDS_SANDBOX, unsandboxedAllowed } from '../server/actors/sandbox.ts';
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
