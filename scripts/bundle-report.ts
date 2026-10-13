// What the web app's first load is made of: builds web/ into a scratch folder and prints each
// output chunk with the modules inside it, largest first.
//
//   node scripts/bundle-report.ts [--top 25]
//
// It never touches web/dist.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Plugin } from 'vite';

const top = Number(process.argv[process.argv.indexOf('--top') + 1]) || 25;
const out = mkdtempSync(join(tmpdir(), 'aurora-bundle-'));
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

const report: Plugin = {
  name: 'aurora-bundle-report',
  generateBundle(_opts, bundle) {
    const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
    const css = Object.values(bundle).filter((c) => c.type === 'asset' && c.fileName.endsWith('.css'));
    const entry = chunks.find((c) => c.type === 'chunk' && c.isEntry);
    console.log('\nChunks (minified, before compression):');
    for (const c of chunks.sort((a, b) => (b.type === 'chunk' ? b.code.length : 0) - (a.type === 'chunk' ? a.code.length : 0))) {
      if (c.type !== 'chunk') continue;
      console.log(`  ${kb(c.code.length).padStart(10)}  ${c.fileName}${c.isEntry ? '  (entry)' : c.isDynamicEntry ? '  (lazy)' : ''}`);
    }
    for (const a of css) if (a.type === 'asset') console.log(`  ${kb(String(a.source).length).padStart(10)}  ${a.fileName}`);
    if (entry && entry.type === 'chunk') {
      console.log(`\nLargest modules in the entry chunk (rendered size):`);
      const mods = Object.entries(entry.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength);
      for (const [id, m] of mods.slice(0, top)) console.log(`  ${kb(m.renderedLength).padStart(10)}  ${id.replace(/^.*node_modules\//, 'npm:').replace(/^.*\/web\/src\//, 'web/src/').replace(/^.*\/core\//, 'core/')}`);
      console.log(`  Static imports of the entry: ${entry.imports.join(', ') || 'none'}`);
    }
  },
};

await build({ configFile: join(import.meta.dirname, '..', 'web', 'vite.config.ts'), logLevel: 'warn', build: { outDir: out, emptyOutDir: true }, plugins: [report] });
rmSync(out, { recursive: true, force: true });
