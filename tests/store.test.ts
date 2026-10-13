// Store-level behaviour: shared items survive removing one of their sources; publish dates are stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.ts';
import type { Item } from '../core/types.ts';

function draft(id: string, sourceId: string, publishedAt: string): Omit<Item, 'state'> {
  return {
    id, sourceId, platform: 'x', externalId: id.split(':')[1], url: `https://x.com/i/status/${id.split(':')[1]}`,
    author: { name: 'Ada' }, text: 'hello there', links: [], media: [], kind: 'post', publishedAt,
    ingestedAt: publishedAt, provenance: { connector: 'test', connectorVersion: 1, via: 'import' }, dedupeKey: `t:${id}`, isDemo: false,
  };
}

test('removing one source keeps items another source also holds, with their state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-store-'));
  try {
    const store = new Store(dir);
    const archive = store.createSource({ connector: 'x-archive', label: 'Archive', platform: 'x', config: {} });
    const api = store.createSource({ connector: 'x-bookmarks', label: 'API', platform: 'x', config: {} });
    store.upsertItem(draft('x:1', archive.id, '2026-10-01T00:00:00.000Z'));
    store.upsertItem(draft('x:2', archive.id, '2026-10-01T00:00:00.000Z'));
    store.upsertItem(draft('x:1', api.id, '2026-10-12T00:00:00.000Z'));
    store.patchState(['x:1'], { saved: true });
    store.deleteSource(archive.id);
    const items = store.listItems();
    assert.deepEqual(items.map((i) => i.id), ['x:1']);
    assert.equal(items[0].sourceId, api.id);
    assert.equal(items[0].state.saved, true);
    assert.equal(items[0].publishedAt, '2026-10-01T00:00:00.000Z', 'first known publish date is kept');
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
