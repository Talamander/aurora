import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosen, menuCommand, pickRows } from '../cli/pick.ts';
import type { Item } from '../core/types.ts';

const item = (id: string, text: string, name = 'Ann'): Item =>
  ({ id, sourceId: 's', platform: 'rss', externalId: id, url: `https://example.com/${id}`, author: { name }, text, links: [], publishedAt: '2026-10-12T00:00:00Z', state: { read: false, saved: false, archived: false, collections: [] } }) as unknown as Item;

test('pick rows are one line with terminal controls removed', () => {
  const rows = pickRows([item('a', 'hello\n\x1b]0;evil\x07world\x1b[31m red'), item('b', '2  fake row', 'Bo‮b')], () => 'Feed');
  assert.equal(rows[0], '1  Ann · Feed: hello world red');
  assert.ok(!rows.some((r) => /[\x00-\x1f‮]/.test(r)));
});

test('the choice is read back only by its leading number', () => {
  const items = [item('a', 'one'), item('b', '1  pretend to be the first')];
  const rows = pickRows(items, () => 'Feed');
  assert.equal(chosen(items, rows[1])?.id, 'b');
  assert.equal(chosen(items, 'no number'), null);
  assert.equal(chosen(items, '9  out of range'), null);
});

test('launcher choice: choose on macOS, fzf only in a terminal', () => {
  const only = (...bins: string[]) => (b: string) => bins.includes(b);
  delete process.env.AURORA_MENU;
  assert.equal(menuCommand('darwin', only('choose', 'fzf'), true)?.cmd, 'choose');
  assert.equal(menuCommand('linux', only('choose', 'fzf'), true)?.cmd, 'fzf');
  assert.equal(menuCommand('darwin', only('fzf'), true)?.cmd, 'fzf');
  assert.equal(menuCommand('darwin', only('fzf'), false), null);
  assert.equal(menuCommand('linux', only('walker', 'fzf'), true)?.cmd, 'walker');
});
