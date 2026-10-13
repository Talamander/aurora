import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swipeAction, swipeProgress, tallyLine, triageDeck, triagePatch, triageTally } from '../core/triage.ts';
import type { Item, ItemState } from '../core/types.ts';

const item = (id: string, state: Partial<ItemState> = {}): Item =>
  ({ id, sourceId: 's', platform: 'rss', externalId: id, url: `https://example.com/${id}`, author: { name: 'Ann' }, text: id, links: [], media: [], publishedAt: '2026-10-12T00:00:00Z', state: { read: false, saved: false, archived: false, collections: [], ...state } }) as unknown as Item;

test('the deck keeps feed order and leaves out read, archived, queued and repeated posts', () => {
  const deck = triageDeck([item('a'), item('b', { read: true }), item('c', { archived: true }), item('d', { collections: ['Read later'] }), item('e'), item('a')]);
  assert.deepEqual(deck.map((i) => i.id), ['a', 'e']);
  assert.equal(triageDeck([item('a'), item('b'), item('c')], 2).length, 2);
});

test('each choice writes only local state', () => {
  const it = item('a', { collections: ['Recipes'] });
  assert.deepEqual(triagePatch('keep', it), { saved: true, read: true });
  assert.deepEqual(triagePatch('hide', it), { archived: true, read: true });
  assert.deepEqual(triagePatch('skip', it), { read: true });
  assert.deepEqual(triagePatch('later', it), { collections: ['Recipes', 'Read later'] });
  assert.deepEqual(triagePatch('later', item('b', { collections: ['Read later'] })), { collections: ['Read later'] });
});

test('a swipe decides only when it is far enough and mostly one way', () => {
  assert.equal(swipeAction(200, 10, 400), 'keep');
  assert.equal(swipeAction(-200, 10, 400), 'hide');
  assert.equal(swipeAction(5, -150, 400), 'later');
  assert.equal(swipeAction(5, 150, 400), 'skip');
  assert.equal(swipeAction(40, 0, 400), null); // too short
  assert.equal(swipeAction(120, 110, 400), null); // diagonal
  assert.equal(swipeProgress(0, 0, 400).action, null);
  assert.deepEqual(swipeProgress(40, 0, 400), { action: 'keep', amount: 0.5 });
  assert.equal(swipeProgress(-500, 0, 400).amount, 1);
});

test('the tally line counts each choice and leaves out zeros', () => {
  const t = triageTally([{ action: 'keep' }, { action: 'skip' }, { action: 'later' }, { action: 'skip' }, { action: 'hide' }]);
  assert.deepEqual(t, { cleared: 5, kept: 1, later: 1, hidden: 1, skipped: 2 });
  assert.equal(tallyLine(t), 'Cleared 5 · kept 1 · later 1 · hid 1');
  assert.equal(tallyLine(triageTally([{ action: 'skip' }])), 'Cleared 1');
});
