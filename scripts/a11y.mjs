#!/usr/bin/env node
// Accessibility sweep: opens each main surface of a running Aurora server in Chromium and runs
// axe-core on it, in dark and light and a few theme presets, desktop and phone width.
//
//   npm run a11y -- http://127.0.0.1:4317            # summary
//   npm run a11y -- http://127.0.0.1:4317 --verbose  # every node that fails
//   npm run a11y -- URL --presets aurora,nord --only timeline,palette --json out.json
//   npm run a11y -- URL --desktop 960x1400 --phone 720x1400   # tiled-window sizes
//
// Needs Chromium (CHROMIUM=/path, default /usr/bin/chromium). Setting a preset changes the
// server's `ui.look` setting for the run and restores it afterwards, so point it at a scratch
// server if you care about that setting. Exits 1 when a serious or critical issue is found.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
// What's new opens on load until the current release is marked seen; mark it so it does not cover other surfaces.
const WHATS_NEW_SEEN = /WHATS_NEW_RELEASE = '([^']+)'/.exec(readFileSync(new URL('../web/src/WhatsNew.tsx', import.meta.url), 'utf8'))?.[1] ?? '9999';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const verbose = args.includes('--verbose');
const presets = (flag('--presets') ?? 'aurora,gruvbox,solarized').split(',').filter(Boolean);
const only = flag('--only')?.split(',');
const jsonOut = flag('--json');
const size = (v, w, h) => { const m = /^(\d+)x(\d+)$/.exec(v ?? ''); return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: w, height: h }; };
const desktopSize = size(flag('--desktop'), 1440, 900);
const phoneSize = size(flag('--phone'), 390, 844);

const settle = (page, ms = 450) => page.waitForTimeout(ms);
const key = async (page, k) => { await page.locator('body').press(k); await settle(page); };
const click = async (page, name, role = 'button') => {
  const el = page.getByRole(role, { name, exact: false }).first();
  if (!(await el.count())) return false;
  await el.click();
  await settle(page);
  return true;
};

// Headless Chromium has no voices, so the listen surface swaps in a speech engine that never
// finishes a paragraph: the player stays on screen, playing, while axe looks at it.
const stubSpeech = (p) => p.evaluate(() => {
  const voices = [{ name: 'Test Voice', lang: 'en-US', voiceURI: 'test-voice', default: true, localService: true }];
  const fake = { speaking: false, paused: false, pending: false, speak() { this.speaking = true; }, cancel() { this.speaking = false; }, pause() {}, resume() {}, getVoices: () => voices, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
});
const openListen = async (p) => {
  await stubSpeech(p);
  await key(p, 'j');
  await key(p, 'Shift+P');
  if (!(await p.locator('.lq').count())) { await key(p, 'Control+k'); await p.keyboard.type('Listen to Read later'); await p.keyboard.press('Enter'); await settle(p, 900); }
  if (!(await p.locator('.lq').count())) return false;
  await settle(p, 900);
  await click(p, 'Queue, ');
};

// Each surface opens itself from a freshly loaded page. `phone` surfaces run at 390px.
const SURFACES = [
  { name: 'timeline', open: async () => true },
  { name: 'help', open: (p) => key(p, '?') },
  { name: 'agent', open: (p) => key(p, '.') },
  { name: 'palette', open: (p) => key(p, 'Control+k') },
  { name: 'sources', open: (p) => key(p, 'g') },
  { name: 'report-card', open: async (p) => { await key(p, 'Control+k'); await p.keyboard.type('Source report cards'); await p.keyboard.press('Enter'); await settle(p, 1200); } },
  { name: 'filters', open: (p) => key(p, 'f') },
  { name: 'why', open: async (p) => { await key(p, 'j'); await key(p, 'w'); } },
  { name: 'reader', open: async (p) => {
    const hero = p.locator('.article-hero').first();
    if (await hero.count()) { await hero.click(); await settle(p, 900); return; }
    await key(p, 'j'); await key(p, 'r'); await settle(p, 600);
  } },
  { name: 'thread-reader', open: async (p) => { const b = p.locator('.thread-read').first(); if (!(await b.count())) return false; await b.scrollIntoViewIfNeeded(); await b.click(); await settle(p, 1200); } },
  { name: 'read-later', open: (p) => click(p, 'Read later') },
  { name: 'highlights', open: (p) => click(p, 'Highlights') },
  { name: 'workshop', open: (p) => click(p, 'Workshop') },
  { name: 'ai-settings', open: (p) => click(p, 'AI settings') },
  { name: 'look', open: (p) => click(p, 'Look and themes') },
  { name: 'friends', open: async (p) => { if (!(await click(p, 'Friends'))) return false; } },
  { name: 'new-profile', open: (p) => click(p, 'New profile') },
  { name: 'profile-hours', open: async (p) => { if (!(await click(p, 'New profile'))) return false; await settle(p, 300); await p.getByLabel('Use it at set times').check(); await settle(p, 300); } },
  { name: 'onthisday-card', open: async (p) => { await settle(p, 900); return (await p.locator('section.otd').count()) > 0; } },
  { name: 'onthisday', open: async (p) => { await key(p, 'Control+k'); await p.keyboard.type('On this day'); await p.keyboard.press('Enter'); await settle(p, 700); } },
  { name: 'alerts', open: (p) => click(p, 'Alerts') },
  { name: 'routines', open: (p) => click(p, 'Routines') },
  { name: 'follows', open: async (p) => { await key(p, 'g'); if (!(await click(p, 'Bring your follows'))) return false; await settle(p, 500); } },
  { name: 'week', open: async (p) => { await key(p, 'Control+k'); await p.keyboard.type('Your week'); await p.keyboard.press('Enter'); await settle(p, 1200); } },
  { name: 'constellation', open: async (p) => { await p.goto(`${base}/?constellation=1`, { waitUntil: 'networkidle' }); await settle(p, 1500); await p.keyboard.press('ArrowRight'); await settle(p, 300); } },
  { name: 'front', open: async (p) => { await p.goto(`${base}/?front=1`, { waitUntil: 'networkidle' }); await settle(p, 1200); } },
  { name: 'phone-front', phone: true, open: async (p) => { await p.goto(`${base}/?front=1`, { waitUntil: 'networkidle' }); await settle(p, 1200); } },
  { name: 'phone-constellation', phone: true, open: async (p) => { await p.goto(`${base}/?constellation=1`, { waitUntil: 'networkidle' }); await settle(p, 1500); } },
  { name: 'ambient', open: async (p) => { await p.goto(`${base}/?ambient=1`, { waitUntil: 'networkidle' }); await settle(p, 1200); } },
  { name: 'search', open: async (p) => { await key(p, '/'); await p.keyboard.type('model'); await settle(p, 1500); } },
  { name: 'columns', open: async (p) => { if (!(await p.locator('.columns').count())) await key(p, 'c'); await settle(p, 1200); await key(p, 'j'); await key(p, 'n'); } },
  { name: 'studio', open: async (p) => { if (!(await click(p, 'Look and themes'))) return false; await settle(p, 400); if (!(await click(p, 'Theme studio'))) return false; await settle(p, 900); } },
  { name: 'listen', open: openListen },
  { name: 'phone-listen', phone: true, open: openListen },
  { name: 'time-sheet', open: async (p) => { await key(p, 'Control+k'); await p.keyboard.type('Time well spent'); await p.keyboard.press('Enter'); await settle(p, 900); return (await p.locator('.tw-sheet').count()) > 0; } },
  { name: 'phone-time-sheet', phone: true, open: async (p) => { await key(p, 'Control+k'); await p.keyboard.type('Time well spent'); await p.keyboard.press('Enter'); await settle(p, 900); return (await p.locator('.tw-sheet').count()) > 0; } },
  { name: 'profile-limit', open: async (p) => {
    const chips = p.locator('.rail .prof-chips [role="radio"]');
    if ((await chips.count()) < 2) return false;
    await chips.nth(1).click(); await settle(p, 600);
    await key(p, 'Control+k'); await p.keyboard.type('Time well spent'); await p.keyboard.press('Enter'); await settle(p, 900);
    const b = p.locator('.tw-sheet .f-sec .btn').first();
    if (!(await b.count())) return false;
    await b.click(); await settle(p, 800);
    await p.getByLabel('A gentle daily limit').check(); await settle(p, 300);
    await p.locator('.prof-limit').scrollIntoViewIfNeeded();
  } },
  // The end-of-feed card shows only in a profile whose daily limit is reached; try each profile.
  { name: 'time-up', open: async (p) => {
    const chips = p.locator('.rail .prof-chips [role="radio"]');
    for (let i = 0; i < (await chips.count()); i++) {
      await chips.nth(i).click(); await settle(p, 700);
      if (await p.getByText('No posts match these filters').count()) { await key(p, 'x'); await settle(p, 500); }
      await p.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)); (el ?? document.scrollingElement).scrollTop = 1e7; });
      await settle(p, 600);
      if (await p.locator('.tw-up').count()) { await p.locator('.tw-up').scrollIntoViewIfNeeded(); return true; }
    }
    return false;
  } },
  { name: 'triage', open: async (p) => { await key(p, 't'); await settle(p, 900); return (await p.locator('.tri').count()) > 0; } },
  { name: 'triage-end', open: async (p) => { await key(p, 't'); await settle(p, 600); for (let i = 0; i < 300 && (await p.locator('.tri-card.top').count()); i++) await p.keyboard.press('ArrowDown'); await settle(p, 500); return (await p.locator('.tri-end').count()) > 0; } },
  { name: 'phone-triage', phone: true, open: async (p) => { await key(p, 't'); await settle(p, 900); return (await p.locator('.tri').count()) > 0; } },
  { name: 'whatsnew', open: async (p) => { await settle(p, 900); return (await p.locator('.whatsnew').count()) > 0; } },
  { name: 'phone-timeline', phone: true, open: async () => true },
  { name: 'phone-views', phone: true, open: (p) => click(p, 'Views') },
  { name: 'phone-rules', phone: true, open: (p) => click(p, 'Rules') },
  { name: 'phone-sources', phone: true, open: (p) => click(p, 'Sources') },
];

async function getLook() {
  try { return (await (await fetch(`${base}/api/settings/ui.look`)).json()).value ?? null; } catch { return null; }
}
async function putLook(value) {
  await fetch(`${base}/api/settings/ui.look`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ value }) });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results = [];
const original = await getLook();
try {
  const combos = [];
  for (const preset of presets) for (const mode of ['dark', 'light']) combos.push({ preset, mode });
  for (const { preset, mode } of combos) {
    await putLook({ preset, mode, tokens: {} });
    for (const s of SURFACES) {
      if (only && !only.includes(s.name)) continue;
      // Phone surfaces are layout checks; run them once per mode on the first preset only.
      if (s.phone && preset !== presets[0]) continue;
      const ctx = await browser.newContext({ viewport: s.phone ? phoneSize : desktopSize, colorScheme: mode, reducedMotion: 'reduce', bypassCSP: true });
      await ctx.addInitScript(([m, wn, seen]) => { try { localStorage.setItem('sr.theme', m); if (!wn) localStorage.setItem('aurora.whatsNew', seen); } catch { /* blocked */ } }, [mode, s.name === 'whatsnew', WHATS_NEW_SEEN]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base, { waitUntil: 'networkidle' });
      await settle(page, 700);
      let opened = true;
      try { opened = (await s.open(page)) !== false; } catch (e) { opened = false; errors.push(String(e.message ?? e)); }
      await settle(page, 300);
      if (!opened) { results.push({ surface: s.name, preset, mode, skipped: true }); await ctx.close(); continue; }
      await page.addScriptTag({ content: AXE });
      const r = await page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        const out = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        // A post that happens to sit under the floating lens dock or phone tab bar at load is not a
        // small target; scrolling moves it clear (the feed has scroll padding for focus). Content behind an
        // open sheet is covered on purpose. Drop both.
        const underDock = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!hit && !el.contains(hit) && !!hit.closest('.lens-dock, .tabbar, .page-dock, .sheet-backdrop, .palette-backdrop, [role=dialog], .agent');
        };
        return out.violations
          .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.filter((n) => !(v.id === 'target-size' && underDock(n.target.join(' ')))).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\n').slice(1, 3).join(' ') })) }))
          .filter((v) => v.nodes.length);
      });
      results.push({ surface: s.name, preset, mode, violations: r, errors });
      await ctx.close();
    }
  }
} finally {
  await putLook(original);
  await browser.close();
}

const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const byRule = new Map();
for (const r of results) for (const v of r.violations ?? []) {
  const e = byRule.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, nodes: 0, where: new Set(), samples: new Set() };
  e.nodes += v.nodes.length;
  e.where.add(`${r.surface}/${r.preset}-${r.mode}`);
  for (const n of v.nodes.slice(0, 3)) e.samples.add(n.target + (verbose && n.summary ? `  (${n.summary})` : ''));
  byRule.set(v.id, e);
}
const rules = [...byRule.values()].sort((a, b) => rank[a.impact] - rank[b.impact] || b.nodes - a.nodes);
const count = (imp) => rules.filter((r) => r.impact === imp).reduce((n, r) => n + r.nodes, 0);
const ran = results.filter((r) => !r.skipped);
console.log(`Aurora accessibility sweep of ${base}`);
console.log(`${ran.length} surface runs (${results.length - ran.length} skipped: ${[...new Set(results.filter((r) => r.skipped).map((r) => r.surface))].join(', ') || 'none'})`);
console.log(`critical ${count('critical')}  serious ${count('serious')}  moderate ${count('moderate')}  minor ${count('minor')}  (node counts, summed over runs)\n`);
for (const r of rules) {
  console.log(`[${r.impact}] ${r.id}: ${r.help} (${r.nodes} nodes)`);
  const where = [...r.where];
  console.log(`   on ${where.slice(0, 6).join(', ')}${where.length > 6 ? ` and ${where.length - 6} more` : ''}`);
  for (const s of [...r.samples].slice(0, verbose ? 20 : 3)) console.log(`   - ${s}`);
}
const errs = ran.flatMap((r) => r.errors.map((e) => `${r.surface}: ${e}`));
if (errs.length) console.log(`\nPage errors:\n${[...new Set(errs)].map((e) => `  ${e}`).join('\n')}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(count('critical') + count('serious') > 0 ? 1 : 0);
