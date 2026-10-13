// Builds a large SYNTHETIC library for performance testing. Every source is labelled
// "Synthetic (perf test)" and every item is marked isDemo, so it can never be mistaken for real
// posts. Never point this at your real data folder.
//
//   node scripts/synth-library.ts <scratch-data-dir> [count=100000]

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../server/db.ts';

const dir = process.argv[2];
const N = Number(process.argv[3] ?? 100_000);
if (!dir) {
  console.error('usage: node scripts/synth-library.ts <scratch-data-dir> [count]');
  process.exit(2);
}
if (resolve(dir) === resolve('data') || existsSync(join(dir, 'browser-profiles'))) {
  console.error('Refusing: this looks like a real Aurora data folder.');
  process.exit(2);
}

// A small deterministic PRNG so runs are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const words = (
  'sqlite postgres rust react typescript compiler latency cache index query vacuum wal checkpoint ' +
  'garden bike hiking coffee espresso sourdough concert vinyl synth festival election council budget ' +
  'weather storm river climate model release paper benchmark gpu inference tokens agent sandbox ' +
  'design type grid colour poster zine print camera lens film photo street portrait travel train ' +
  'giveaway follow like subscribe discount offer limited thread notes week update launch beta'
).split(' ');
const sentence = (n: number) => {
  const w = Array.from({ length: n }, () => pick(words));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
};
const para = (sentences: number) => Array.from({ length: sentences }, () => sentence(6 + Math.floor(rnd() * 14))).join(' ');

const store = new Store(dir);
const platforms = ['rss', 'bluesky', 'mastodon', 'youtube', 'instagram', 'reddit'] as const;
const sources = platforms.flatMap((p) =>
  [1, 2].map((k) => {
    const s = store.createSource({ connector: 'synthetic', label: `Synthetic (perf test) ${p} ${k}`, platform: p, config: {}, isDemo: true, status: 'ok' });
    store.updateSource(s.id, { enabled: false, statusDetail: 'Synthetic perf-test data. Not a real feed.' });
    return s;
  }),
);
const people = Array.from({ length: 1500 }, (_, i) => ({ name: `Synthetic Person ${i}`, handle: `synth${i}` }));
const now = Date.now();
const span = 3 * 365 * 86_400_000;

console.time('insert');
store.tx(() => {
  const st = store.db.prepare(
    'INSERT INTO item_state(item_id, read, saved, archived, collections, noise_override, read_at, saved_at) VALUES(?,?,?,?,?,NULL,NULL,NULL)',
  );
  for (let n = 0; n < N; n++) {
    const src = sources[n % sources.length];
    const article = rnd() < 0.12;
    const author = pick(people);
    // Newest first is the common case; spread the rest over three years with more recent density.
    const age = Math.floor(span * rnd() ** 2.2);
    const publishedAt = new Date(now - age).toISOString();
    const text = article ? [para(4), para(5), para(4)].join('\n\n') : para(1 + Math.floor(rnd() * 3));
    const id = `${src.platform}:synth-${n}`;
    store.upsertItem({
      id,
      sourceId: src.id,
      platform: src.platform as never,
      externalId: `synth-${n}`,
      url: `https://synthetic.example/${src.platform}/${n}`,
      author,
      title: article ? sentence(5 + Math.floor(rnd() * 5)).slice(0, -1) : undefined,
      text,
      links: rnd() < 0.3 ? [`https://synthetic.example/link/${n}`] : [],
      media: rnd() < 0.22 ? [{ type: 'image', url: `https://synthetic.example/img/${n}.jpg`, alt: null } as never] : [],
      lang: 'en',
      kind: article ? 'article' : 'post',
      publishedAt,
      ingestedAt: publishedAt,
      provenance: { connector: 'demo', connectorVersion: 1, via: 'synthetic' } as never,
      metrics: rnd() < 0.5 ? { likes: Math.floor(rnd() * 500), reposts: Math.floor(rnd() * 50) } : null,
      dedupeKey: rnd() < 0.02 ? `synth-dupe:${Math.floor(n / 7)}` : `synth:${n}`,
      isDemo: true,
    });
    const read = age > 7 * 86_400_000 ? rnd() < 0.85 : rnd() < 0.3;
    const saved = rnd() < 0.01;
    const archived = rnd() < 0.04;
    if (read || saved || archived) st.run(id, +read, +saved, +archived, saved && rnd() < 0.3 ? '["Synthetic reading list"]' : '[]');
  }
});
console.timeEnd('insert');
console.log(`Synthetic library: ${N} items in ${store.path}`);
