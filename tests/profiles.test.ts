import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editionId, scheduleMatches, scopeLibrary } from '../core/profiles.ts';
import type { Library, Profile } from '../core/types.ts';
import { Store } from '../server/db.ts';
import { createProfiles } from '../server/profiles.ts';

const profile = (p: Partial<Profile> & { id: string }): Profile => ({
  name: p.id, icon: 'star', color: '#7aa2f7', sourceIds: [], own: { views: [], pages: [], aiRules: [] }, position: 0, createdAt: '', ...p,
});

const lib = (profiles: Profile[]): Library => ({
  items: [{ id: 'i1', sourceId: 's1' }, { id: 'i2', sourceId: 's2' }] as any,
  sources: [{ id: 's1' }, { id: 's2' }] as any,
  views: [{ id: 'v-all' }, { id: 'v-work' }] as any,
  topics: [], collections: [], syncRuns: [], connectors: [],
  aiRules: [{ id: 'r-work' }] as any,
  profiles,
});

test('a profile sees its sources and owns its views and rules; All keeps the rest', () => {
  const work = profile({ id: 'work', sourceIds: ['s1'], own: { views: ['v-work'], pages: [], aiRules: ['r-work'] } });
  const w = scopeLibrary(lib([work]), 'work');
  assert.deepEqual(w.items.map((i) => i.id), ['i1']);
  assert.deepEqual(w.views.map((v) => v.id), ['v-work']);
  assert.deepEqual(w.aiRules?.map((r) => r.id), ['r-work']);
  const all = scopeLibrary(lib([work]), 'all');
  assert.equal(all.items.length, 2);
  assert.deepEqual(all.views.map((v) => v.id), ['v-all']);
  assert.deepEqual(all.aiRules, []);
  // With no profiles at all, nothing changes.
  const plain = lib([]);
  assert.equal(scopeLibrary(plain, 'work'), plain);
  // inherit adds the objects All owns.
  assert.deepEqual(scopeLibrary(lib([{ ...work, inherit: true }]), 'work').views.map((v) => v.id), ['v-all', 'v-work']);
});

test('schedule suggestions and edition ids', () => {
  const p = profile({ id: 'work', schedule: { days: [1], from: '09:00', to: '17:00' } });
  assert.equal(scheduleMatches(p, new Date(2026, 9, 12, 10, 0)), true); // a Monday
  assert.equal(scheduleMatches(p, new Date(2026, 9, 12, 18, 0)), false);
  assert.equal(scheduleMatches(p, new Date(2026, 9, 13, 10, 0)), false);
  assert.equal(editionId('all'), 'morning-edition');
  assert.equal(editionId('work'), 'morning-edition--work');
});

test('new objects join the active profile; deleting a profile hands them back to All', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-profiles-'));
  try {
    const store = new Store(dir);
    const profiles = createProfiles(store);
    store.onCreate = (kind, id) => profiles.adopt(kind, id);
    const work = profiles.save({ name: 'Work', icon: 'briefcase' });
    assert.equal(work.id, 'work');
    assert.throws(() => profiles.save({ name: 'All' }));
    profiles.setActive('Work');
    const src = store.createSource({ connector: 'rss', label: 'Blog', platform: 'web', config: {} });
    const view = store.saveView({ name: 'Tools', spec: {} as any });
    assert.deepEqual(profiles.get('work')!.sourceIds, [src.id]);
    assert.deepEqual(profiles.get('work')!.own.views, [view.id]);
    profiles.remove('work');
    assert.equal(profiles.active(), 'all');
    assert.deepEqual(profiles.list(), []);
    assert.ok(store.listViews().some((v) => v.id === view.id));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
