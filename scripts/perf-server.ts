// Server-side timings that need no browser: the cold item read, "Your week" and the alerts pass
// after a sync. Runs in-process against a scratch library.
//
//   node scripts/perf-server.ts <scratch-copy-of-a-synthetic-library>
//
// It WRITES to the folder: it adds 500 posts (as a sync would) and a few keyword alerts. Use a
// throwaway copy made from scripts/synth-library.ts output, never a real data folder. The added
// posts sit under the library's "Synthetic (perf test)" sources and say so in their text. They are
// not marked as demo posts only because alerts skip demo posts, which would make the check empty.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../server/db.ts';
import { createAlerts, createAlertIn } from '../server/alerts.ts';
import { statsFor } from '../server/week.ts';
import { weekStart } from '../core/week.ts';
import type { Library } from '../core/types.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/perf-server.ts <scratch-copy>');
  process.exit(2);
}
if (resolve(dir) === resolve('data') || existsSync(join(dir, 'browser-profiles'))) {
  console.error('Refusing: this looks like a real Aurora data folder.');
  process.exit(2);
}
// Opening a folder with no library would create one, so a mistyped path stops here instead.
if (!existsSync(join(dir, 'social-reader.db'))) {
  console.error(`No library in ${dir}. Pass a copy of a folder made by scripts/synth-library.ts.`);
  process.exit(2);
}
const store = new Store(dir);
const sources = store.listSources();
if (!sources.length || sources.some((s) => !s.label.startsWith('Synthetic (perf test)'))) {
  console.error('Refusing: every source here should be a "Synthetic (perf test)" source from scripts/synth-library.ts.');
  process.exit(2);
}
const ms = (n: number) => `${n.toFixed(0)} ms`;
const row = (k: string, v: string) => console.log(`${k.padEnd(44)} ${v}`);
const time = <T,>(fn: () => T): [T, number] => {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
};
const median = (fn: () => unknown, n = 7) => {
  const t: number[] = [];
  for (let i = 0; i < n; i++) t.push(time(fn)[1]);
  return t.sort((a, b) => a - b)[Math.floor(n / 2)];
};

const [items, cold] = time(() => store.listItems());
row('Item list, cold read', `${ms(cold)} (${items.length} posts)`);
row('Item list, cached', ms(median(() => store.listItems())));

const lib = (): Library => ({
  items: store.listItems(),
  sources: store.listSources(),
  views: [],
  topics: store.listTopics(),
  collections: [],
  syncRuns: [],
  connectors: [],
  pages: [],
  aiRules: store.listAiRules(),
  labels: store.listLabels(),
});
row('Your week, numbers for this week', ms(median(() => statsFor(store, lib(), weekStart(new Date())))));

// Alerts: five keyword or author alerts, then a sync that brings 500 new posts.
const alerts = createAlerts({
  store,
  complete: async () => {
    throw new Error('no AI in perf runs');
  },
  ready: () => ({ ready: false }),
  profiles: () => [],
  friendRouting: () => ({}),
  broadcast: () => {},
});
await alerts.run(); // first run only sets the watermark
for (const k of [['sqlite'], ['espresso', 'sourdough'], ['election'], ['gpu', 'inference'], ['zine']]) createAlertIn(store, { name: `Perf ${k[0]}`, keywords: k });
await new Promise((r) => setTimeout(r, 5));
const now = Date.now();
store.tx(() => {
  for (let n = 0; n < 500; n++) {
    const src = sources[n % sources.length];
    const at = new Date(now - n * 60_000).toISOString();
    store.upsertItem({
      id: `${src.platform}:perf-sync-${now}-${n}`,
      sourceId: src.id,
      platform: src.platform as never,
      externalId: `perf-sync-${n}`,
      url: `https://synthetic.example/perf-sync/${n}`,
      author: { name: `Synthetic author ${n % 40}`, handle: `synth${n % 40}` } as never,
      text: `Synthetic perf post ${n}: ${['sqlite wal checkpoint', 'espresso and sourdough', 'council election budget', 'gpu inference tokens', 'garden bike'][n % 5]}.`,
      links: [],
      media: [],
      lang: 'en',
      kind: 'post',
      publishedAt: at,
      ingestedAt: new Date().toISOString(),
      provenance: { connector: 'demo', connectorVersion: 1, via: 'synthetic' } as never,
      metrics: null,
      dedupeKey: `perf-sync:${now}:${n}`,
      isDemo: false,
    });
  }
});
const [, reread] = time(() => store.listItems());
row('Item list after 500 new posts', ms(reread));
const t = performance.now();
await alerts.run();
const hits = (store.getSetting<unknown[]>('alerts.hits') ?? []).length;
row('Alerts pass, 5 alerts over 500 new posts', `${ms(performance.now() - t)} (${hits} hits)`);
