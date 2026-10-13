#!/usr/bin/env node
// Integration smoke walk: drives a running Aurora server through every surface and the key
// interactions in Chromium, in dark and light, at desktop and phone width.
//
//   npm run smoke -- http://127.0.0.1:4590
//   npm run smoke -- URL --only dark-1440 --steps rail,columns --verbose
//
// It fails on page errors, console errors, unhandled rejections, failed requests (other than
// expected 404s), stuck focus (Escape must close the top layer and give focus back) and fixed
// layers that overlap (the listen player, the lens dock or tab bar, the AI-paused banner and toasts).
//
// Point it at a scratch server: it changes local state (saves a post, pauses a source and undoes
// it, queues Listen). It never presses Run now or Preview on a routine and never asks the
// assistant anything, so it makes no model calls. Needs Chromium (CHROMIUM=/path).

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const WHATS_NEW_SEEN = /WHATS_NEW_RELEASE = '([^']+)'/.exec(readFileSync(new URL('../web/src/WhatsNew.tsx', import.meta.url), 'utf8'))?.[1] ?? '9999';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const verbose = args.includes('--verbose');
const onlyRuns = flag('--only')?.split(',');
const onlySteps = flag('--steps')?.split(',');

// 404s the app expects and handles: a post with no readable article, a missing avatar.
const EXPECTED_404 = [/\/api\/article\//, /\/api\/img\b/, /favicon/];

const settle = (page, ms = 350) => page.waitForTimeout(ms);
const press = async (page, k, ms) => { await page.keyboard.press(k); await settle(page, ms); };
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const role = (page, r, name) => page.getByRole(r, { name, exact: false }).first();

class StepError extends Error {}
const must = (cond, msg) => { if (!cond) throw new StepError(msg); };

/** A short description of the focused element, for messages. */
const focusDesc = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  return `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}`;
});
const markFocus = (page) => page.evaluate(() => { window.__smokeBefore = document.activeElement; });
/** Focus is back where it was before the layer opened (or on the page, if that is gone). */
const focusReturned = (page) => page.evaluate(() => {
  const before = window.__smokeBefore;
  const a = document.activeElement;
  if (a === before) return true;
  if (!before || before === document.body || !before.isConnected) return !a.closest('[role="dialog"], .sheet, .palette');
  // A post that was selected before may have been re-rendered; accept focus on the same post.
  const post = before.closest?.('[data-id]');
  return !!post && !!a.closest?.(`[data-id="${post.getAttribute('data-id')}"]`);
});

const TOP_LAYERS = '[role="dialog"], .sheet, .palette, .agent, .wk, .amb, .rd';
const topLayerCount = (page) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length, TOP_LAYERS);

/**
 * Opens a layer, checks it shows `sel`, presses Escape, checks it is gone and focus came back.
 * `open` is a function; when `opener` is a locator, focus is moved there first and must return to it.
 */
async function layer(page, name, { open, sel, opener, escapes = 1 }) {
  if (opener) { await opener.focus(); }
  await markFocus(page);
  const before = await topLayerCount(page);
  await open();
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  must(await visible(page, sel), `${name}: did not open (${sel})`);
  for (let i = 0; i < escapes; i++) await press(page, 'Escape', 450);
  await page.locator(sel).first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  must(!(await visible(page, sel)), `${name}: Escape did not close it`);
  must((await topLayerCount(page)) <= before, `${name}: a layer stayed open after Escape`);
  must(await focusReturned(page), `${name}: focus did not return after Escape (now on ${await focusDesc(page)})`);
}

/** Fixed layers that must never sit on top of each other. */
async function overlaps(page) {
  return page.evaluate(() => {
    const groups = { player: '.lq', dock: '.lens-dock, .tabbar, .page-dock', banner: '.ai-paused-banner', toast: '.toasts .toast' };
    const boxes = [];
    for (const [g, sel] of Object.entries(groups)) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        if (r.bottom <= 0 || r.top >= innerHeight) continue;
        boxes.push({ g, r });
      }
    }
    const out = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.g === b.g) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && h > 2) out.push(`${a.g} overlaps ${b.g} by ${Math.round(w)}x${Math.round(h)}px`);
    }
    return out;
  });
}
const noOverlap = async (page, where) => { const o = await overlaps(page); must(!o.length, `${where}: ${o.join('; ')}`); };

async function palette(page, text) {
  await press(page, 'Control+k', 400);
  must(await visible(page, '.palette'), 'palette did not open');
  await page.keyboard.type(text, { delay: 10 });
  await settle(page, 300);
  await press(page, 'Enter', 900);
}

/** Reloads the page to a clean state (no layer open). */
async function fresh(page, query = '') {
  await page.goto(`${base}/${query}`, { waitUntil: 'networkidle' });
  await page.locator('.feed, .columns, .phone-feed, main').first().waitFor({ timeout: 8000 }).catch(() => {});
  await settle(page, 600);
  // Steps mark posts read; if the feed has run dry, clear the filters so there is something to act on.
  if (await page.getByText('No posts match these filters').count()) await press(page, 'x', 500);
}

async function selectFirstPost(page) {
  // Earlier steps mark posts read; clear the filters (Everything, read or not) so articles show.
  await press(page, 'x', 500);
  await press(page, 'j');
  const sel = await page.evaluate(() => !!document.querySelector('[aria-selected="true"], .post.selected, .post.sel, article.selected'));
  return sel;
}

// ---------------------------------------------------------------------------------------------
// Steps. Each gets a freshly loaded page; `desktop`/`phone` limit where it runs.

const STEPS = [
  { name: 'load', run: async (page) => {
    must(!(await visible(page, '.whatsnew')), "What's new opened although this release was marked seen");
    must(await page.locator('main, .feed').first().isVisible(), 'no feed on load');
  } },

  { name: 'rail', desktop: true, run: async (page) => {
    const rail = page.locator('nav.rail');
    const items = [
      ['Alerts', '.sheet'], ['Routines', '.sheet'], ['Workshop', '.sheet'], ['AI settings', '.sheet'],
      ['Look and themes', '.sheet, [role="dialog"]'], ['Keyboard shortcuts', '[role="dialog"], .sheet'],
      ['Sources & imports', '.sheet'], ['Search everything', '.palette'], ['Ask your feed', '.agent, [role="dialog"]'],
    ];
    for (const [name, sel] of items) {
      const b = rail.getByRole('button', { name, exact: false }).first();
      must(await b.count(), `rail: no "${name}" button`);
      await layer(page, `rail ${name}`, { opener: b, open: () => b.click().then(() => settle(page, 700)), sel });
    }
  } },

  { name: 'keys', run: async (page) => {
    const phone = page.viewportSize().width < 861;
    const keys = [['?', '[role="dialog"], .sheet'], ['g', '.sheet'], ['f', '.sheet'], ['Control+k', '.palette']];
    if (!phone) keys.push(['.', '.agent, [role="dialog"]']);
    for (const [k, sel] of keys) await layer(page, `key ${k}`, { open: () => press(page, k, 700), sel });
  } },

  { name: 'palette', run: async (page) => {
    for (const [cmd, sel] of [['Source report cards', '.sheet'], ['On this day', '.otd-sheet'], ['Routines', '.sheet'], ['Alerts', '.sheet']]) {
      await layer(page, `palette ${cmd}`, { open: () => palette(page, cmd), sel });
    }
  } },

  { name: 'columns', desktop: true, run: async (page) => {
    // Columns is saved in the library, so an earlier interrupted run can leave it on.
    if (await visible(page, 'main.columns')) await press(page, 'c', 600);
    await press(page, 'c', 900);
    // The very first load in a run can still be settling; give Columns one more moment.
    if (!(await visible(page, 'main.columns'))) await settle(page, 1200);
    must(await visible(page, 'main.columns'), `c did not show Columns (focus on ${await focusDesc(page)}, modal: ${await page.evaluate(() => [...document.querySelectorAll('[aria-modal="true"]')].map((e) => e.className).join(',') || 'none')})`);
    const n = await page.locator('main.columns .col').count();
    if (n >= 2) {
      await press(page, '2', 400);
      const inSecond = await page.evaluate(() => { const cols = document.querySelectorAll('main.columns .col'); return !!cols[1]?.contains(document.activeElement); });
      must(inSecond, `2 did not move focus to the second column (focus on ${await focusDesc(page)})`);
      await press(page, 'ArrowLeft', 300);
      await press(page, 'j', 300);
      await press(page, 'k', 300);
    }
    // n opens "add a column"; Escape closes it and stays in Columns.
    await press(page, 'n', 500);
    await press(page, 'Escape', 400);
    must(await visible(page, 'main.columns'), 'Escape from "add a column" left Columns');
    // Help over Columns, then back.
    await layer(page, 'help over Columns', { open: () => press(page, '?', 500), sel: '[role="dialog"], .sheet' });
    must(await visible(page, 'main.columns'), 'Columns closed after help');
    await press(page, 'c', 700);
    must(!(await visible(page, 'main.columns')), 'c did not leave Columns');
    const b = page.getByRole('button', { name: 'Columns, several views', exact: false }).first();
    await b.click(); await settle(page, 800);
    must(await visible(page, 'main.columns'), 'rail Columns button did not show Columns');
    await b.click(); await settle(page, 600);
    must(!(await visible(page, 'main.columns')), 'rail Columns button did not leave Columns');
  } },

  { name: 'key-collisions', desktop: true, run: async (page) => {
    // Feed keys must not reach the feed (or Columns) through a sheet that is not a panel.
    await selectFirstPost(page);
    const selId = () => page.evaluate(() => document.querySelector('article.post.sel')?.getAttribute('data-id') ?? null);
    const before = await selId();
    must(before, 'j selected no post');
    await press(page, 'i', 700);
    must(await visible(page, '.related-sheet'), 'i did not open More like this');
    await press(page, 'j', 200);
    await press(page, 'c', 400);
    must(!(await visible(page, 'main.columns')), 'c behind More like this switched to Columns');
    must((await selId()) === before, 'j behind More like this moved the feed selection');
    await press(page, 'Escape', 400);
    must(!(await visible(page, '.related-sheet')), 'Escape did not close More like this');
    // In Columns: h and l stay the post keys (show set aside, Read later); Shift H/L move between columns.
    await press(page, 'c', 900);
    must(await visible(page, 'main.columns'), 'c did not show Columns');
    const cols = await page.locator('main.columns .col').count();
    if (cols >= 2) {
      await press(page, '1', 300);
      await press(page, 'Shift+L', 300);
      must(await page.evaluate(() => !!document.querySelectorAll('main.columns .col')[1]?.contains(document.activeElement)), 'Shift+L did not move to the next column');
      await press(page, 'Shift+H', 300);
      must(await page.evaluate(() => !!document.querySelectorAll('main.columns .col')[0]?.contains(document.activeElement)), 'Shift+H did not move to the previous column');
    }
    // p with nothing queued, then Shift+P on a column post.
    await press(page, 'j', 300);
    await press(page, 'p', 300);
    for (let i = 0; i < 12 && !(await visible(page, '.lq')); i++) { await press(page, 'Shift+P', 300); if (!(await visible(page, '.lq'))) await press(page, 'j', 150); }
    if (await visible(page, '.lq')) {
      await noOverlap(page, 'player over Columns');
      await page.getByRole('button', { name: 'Stop and clear the queue' }).click();
      await settle(page, 300);
    }
    must(await visible(page, 'main.columns'), 'Columns closed during the key checks');
    await press(page, 'c', 600);
  } },

  { name: 'reader', run: async (page) => {
    const hero = page.locator('.article-hero').first();
    let opened = false;
    if (await hero.count()) {
      await layer(page, 'reader (click)', { opener: hero, open: async () => { await hero.click(); await settle(page, 900); }, sel: '.rd' });
      opened = true;
    }
    await selectFirstPost(page);
    for (let i = 0; i < 12 && !opened; i++) {
      await press(page, 'r', 700);
      if (await visible(page, '.rd')) { opened = true; await press(page, 'Escape', 500); must(!(await visible(page, '.rd')), 'reader: Escape did not close it'); break; }
      await press(page, 'j', 150);
    }
    must(opened, 'reader: no post opened the reader');
  } },

  { name: 'listen', run: async (page) => {
    await selectFirstPost(page);
    let queued = false;
    for (let i = 0; i < 15 && !queued; i++) {
      await press(page, 'Shift+P', 400);
      queued = await visible(page, '.lq');
      if (!queued) await press(page, 'j', 150);
    }
    must(queued, 'Shift+P never queued a post');
    await settle(page, 600);
    await noOverlap(page, 'listen player');
    await press(page, 'p', 300);
    await press(page, 'p', 300);
    // A toast while the player shows (save, then unsave).
    await press(page, 's', 250);
    await noOverlap(page, 'listen + toast');
    await press(page, 's', 250);
    const q = page.getByRole('button', { name: 'Queue, ', exact: false });
    await q.click(); await settle(page, 400);
    must(await visible(page, '.lq-panel'), 'queue panel did not open');
    await q.click(); await settle(page, 300);
    // The player must stay usable over a sheet and keep out of the reader's p.
    await layer(page, 'help with player', { open: () => press(page, '?', 500), sel: '[role="dialog"], .sheet' });
    await page.getByRole('button', { name: 'Stop and clear the queue' }).click();
    await settle(page, 400);
    must(!(await visible(page, '.lq')), 'Stop did not clear the player');
  } },

  { name: 'week', run: async (page) => {
    await layer(page, 'week (palette)', { open: () => palette(page, 'Your week'), sel: '.wk' });
  } },

  { name: 'time', run: async (page) => {
    await layer(page, 'time well spent (palette)', { open: () => palette(page, 'Time well spent'), sel: '.tw-sheet' });
  } },

  { name: 'ambient', run: async (page) => {
    const phone = page.viewportSize().width < 861;
    if (!phone) {
      const b = page.getByRole('button', { name: 'Ambient, the feed', exact: false }).first();
      await layer(page, 'ambient (rail)', { opener: b, open: async () => { await b.click(); await settle(page, 1200); }, sel: '.amb' });
    }
    await layer(page, 'ambient (palette)', { open: async () => { await palette(page, 'Ambient'); await settle(page, 800); }, sel: '.amb' });
  } },

  { name: 'profiles', run: async (page) => {
    const n = await page.evaluate(async () => ((await (await fetch('/api/profiles')).json().catch(() => null))?.profiles ?? []).length).catch(() => 0);
    if (n > 0) {
      await press(page, 'Alt+2', 900);
      await press(page, 'Alt+1', 900);
    }
    const phone = page.viewportSize().width < 861;
    if (!phone) {
      const np = page.getByRole('button', { name: 'New profile', exact: false }).first();
      if (await np.count()) await layer(page, 'new profile', { opener: np, open: () => np.click().then(() => settle(page, 500)), sel: '[role="dialog"], .sheet' });
    }
  } },

  { name: 'whatsnew', run: async (page) => {
    const phone = page.viewportSize().width < 861;
    // Where each button should land. Columns is desktop only.
    const expect = {
      'Make a routine': '.sheet', 'Tile them': phone ? null : 'main.columns', 'Open Friends': '.sheet, [role="dialog"]', 'Make a profile': '[role="dialog"]',
      'Play it': '.wk', 'Listen': null, 'See report cards': '.sheet', 'Clear the deck': '.tri', 'Set hours': '[role="dialog"]', 'Look back': '.otd-sheet', 'Look up': '.cst', 'See my time': '.tw-sheet', 'Read the front page': '.fp',
      'Make an alert': '.sheet', 'Lean back': '.amb', 'Open the studio': '.studio, [role="dialog"]', 'Bring them': '.sheet', 'Try a search': 'input:focus',
      'Read later': '.lf-sheet', 'See spend': '.sheet', 'Lock settings': '.sheet', 'Shortcuts': '[role="dialog"], .sheet',
    };
    await page.evaluate(() => localStorage.removeItem('aurora.whatsNew'));
    await fresh(page);
    await page.locator('.whatsnew').waitFor({ timeout: 4000 }).catch(() => {});
    must(await visible(page, '.whatsnew'), "What's new did not open for an unseen release");
    const labels = await page.locator('.whatsnew .wn-go').allInnerTexts();
    // Escape on the auto-opened sheet closes it.
    await press(page, 'Escape', 400);
    must(!(await visible(page, '.whatsnew')), "Escape did not close What's new");
    for (const label of labels.map((l) => l.trim())) {
      await page.evaluate(() => localStorage.removeItem('aurora.whatsNew'));
      await fresh(page);
      await page.locator('.whatsnew').waitFor({ timeout: 4000 });
      // Quick look opens its own small window in a browser.
      const popup = label === 'Take a look' ? page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null) : null;
      await page.locator('.whatsnew .wn-go', { hasText: label }).first().click();
      await settle(page, 1300);
      const sel = expect[label];
      if (popup) {
        const win = await popup;
        must(win && /[?&]quick=1/.test(win.url()), "What's new Quick look: no Quick look window opened");
        must(!(await visible(page, '.whatsnew')), "What's new \"Take a look\" left the sheet open");
        await win?.close();
        continue;
      }
      if (label === 'Listen') {
        // Plays Read later; with nothing saved for later it says so in a toast.
        must((await visible(page, '.lq')) || (await page.locator('.toasts .toast').count()) > 0, "What's new Listen: no player and no toast");
        if (await visible(page, '.lq')) await page.getByRole('button', { name: 'Stop and clear the queue' }).click();
        continue;
      }
      if (sel === undefined) throw new StepError(`What's new: no expectation for "${label}"`);
      if (sel === null) { must(!(await visible(page, '.whatsnew')), `What's new "${label}" left the sheet open`); continue; }
      must(!(await visible(page, '.whatsnew')), `What's new "${label}" left What's new open`);
      must(await visible(page, sel), `What's new "${label}" did not land on ${sel}`);
      must(!(await page.evaluate(() => localStorage.getItem('aurora.whatsNew') === null)), `What's new "${label}" did not mark the release seen`);
      if (sel === 'main.columns') { await press(page, 'c', 500); continue; }
      if (sel === 'input:focus') { await press(page, 'Escape', 300); continue; }
      await press(page, 'Escape', 600);
      must(!(await visible(page, sel)) || sel === '.studio, [role="dialog"]', `What's new "${label}": Escape did not close ${sel}`);
    }
  } },

  { name: 'triage', run: async (page) => {
    const phone = page.viewportSize().width < 861;
    await layer(page, 'triage (t)', { open: () => press(page, 't', 700), sel: '.tri' });
    await layer(page, 'triage (palette)', { open: () => palette(page, 'Triage new posts'), sel: '.tri' });
    await press(page, 't', 700);
    const top = () => page.evaluate(() => document.querySelector('.tri-card.top')?.getAttribute('data-id') ?? null);
    const first = await top();
    if (first) {
      // A choice moves on; z brings the same post back. Phone uses the buttons, desktop the arrows.
      if (phone) await page.getByRole('button', { name: 'Keep' }).click();
      else await press(page, 'ArrowRight', 0);
      await settle(page, 450);
      must((await top()) !== first, 'triage: Keep did not move to the next post');
      await press(page, 'z', 450);
      must((await top()) === first, 'triage: z did not bring the post back');
      const saved = await page.evaluate(async (id) => { const r = await fetch('/api/library'); if (!r.ok) return null; const l = await r.json(); return l.items?.find((i) => i.id === id)?.state?.saved ?? null; }, first);
      must(saved !== true, 'triage: undo left the post saved');
      // Keys must not leak to the feed behind the deck.
      await press(page, 'c', 300);
      must(!(await visible(page, 'main.columns')), 'triage: c behind Triage switched to Columns');
    } else {
      must(await visible(page, '.tri-end'), 'triage: no card and no end screen');
    }
    await press(page, 'Escape', 450);
    must(!(await visible(page, '.tri')), 'triage: Escape did not close it');
  } },

  { name: 'search', run: async (page) => {
    const phone = page.viewportSize().width < 861;
    if (phone) {
      const box = page.locator('input[aria-label="Search posts"]:visible').first();
      must(await box.count(), 'no search field at phone width');
      await box.click();
    } else await press(page, '/', 200);
    must(await page.locator('input:focus').count(), '/ did not focus a search field');
    await page.keyboard.type('model', { delay: 20 });
    await settle(page, 1200);
    // The query is saved with the feed, so clear it again for the steps that follow.
    await press(page, 'Control+a', 50);
    await press(page, 'Backspace', 600);
    await press(page, 'Escape', 300);
    must(!(await page.locator('input:focus').count()), 'Escape did not leave the search field');
  } },

  { name: 'report-card', run: async (page) => {
    await palette(page, 'Source report cards');
    await page.locator('.rc-spark, .rc-card, .report').first().waitFor({ timeout: 5000 }).catch(() => {});
    const pause = page.getByRole('button', { name: /^(Pause|Resume) syncing$/ }).first();
    if (await pause.count()) {
      const before = await pause.innerText();
      await pause.click(); await settle(page, 700);
      const undo = page.locator('.toasts').getByRole('button', { name: 'Undo' });
      if (await undo.count()) { await undo.first().click(); await settle(page, 700); }
      else { await page.getByRole('button', { name: /^(Pause|Resume) syncing$/ }).first().click(); await settle(page, 700); }
      must((await page.getByRole('button', { name: /^(Pause|Resume) syncing$/ }).first().innerText()) === before, 'report card: pause was not undone');
    }
    const mute = page.getByRole('button', { name: /^(Mute in this feed|Remove from )/ }).first();
    if (await mute.count()) {
      await mute.click(); await settle(page, 600);
      const undo = page.locator('.toasts').getByRole('button', { name: 'Undo' });
      if (await undo.count()) { await undo.first().click(); await settle(page, 600); }
      else { await press(page, 'Escape', 400); await press(page, 'z', 600); }
    }
    await press(page, 'Escape', 500);
    must(!(await visible(page, '.sheet')), 'report card: Escape did not close');
  } },

  { name: 'routines', run: async (page) => {
    await palette(page, 'Routines');
    must(await visible(page, '.sheet'), 'routines did not open');
    // Look only. Run now and Preview call the AI.
    const text = await page.locator('.sheet').first().innerText();
    must(text.length > 20, 'routines sheet is empty');
    await press(page, 'Escape', 400);
    must(!(await visible(page, '.sheet')), 'routines: Escape did not close');
  } },

  { name: 'ai-paused', run: async (page) => {
    // Pretend a spending cap is reached so the banner shows, then check it clears the other fixed layers.
    await page.route('**/api/ai/spend', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ capStates: [{ task: 'brief', reached: true, localOnly: false }], tasks: [{ task: 'brief', label: 'Briefs' }] }) }));
    await fresh(page);
    await page.locator('.ai-paused-banner').waitFor({ timeout: 3000 }).catch(() => {});
    must(await visible(page, '.ai-paused-banner'), 'AI-paused banner did not show');
    await noOverlap(page, 'banner');
    await selectFirstPost(page);
    for (let i = 0; i < 15 && !(await visible(page, '.lq')); i++) { await press(page, 'Shift+P', 300); if (!(await visible(page, '.lq'))) await press(page, 'j', 100); }
    await press(page, 's', 300);
    await noOverlap(page, 'banner + player + toast');
    await press(page, 's', 200);
    if (await visible(page, '.lq')) await page.getByRole('button', { name: 'Stop and clear the queue' }).click();
    await page.unroute('**/api/ai/spend');
  } },

  { name: 'phone-tabs', phone: true, run: async (page) => {
    must(await visible(page, '.tabbar'), 'no tab bar at phone width');
    const names = await page.locator('.tabbar button').evaluateAll((bs) => bs.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()));
    for (const [i, name] of names.entries()) {
      if (/^(feed|home|timeline)$/i.test(name)) continue;
      await page.locator('.tabbar button').nth(i).click({ timeout: 5000 }); await settle(page, 700);
      const top = await topLayerCount(page);
      if (top > 0) {
        await press(page, 'Escape', 500);
        must((await topLayerCount(page)) === 0, `tab ${name}: Escape did not close it`);
      }
    }
    await noOverlap(page, 'tab bar');
  } },
];

// ---------------------------------------------------------------------------------------------

const RUNS = [
  { id: 'dark-1440', mode: 'dark', viewport: { width: 1440, height: 900 } },
  { id: 'light-1440', mode: 'light', viewport: { width: 1440, height: 900 } },
  { id: 'dark-390', mode: 'dark', viewport: { width: 390, height: 844 } },
  { id: 'light-390', mode: 'light', viewport: { width: 390, height: 844 } },
  // Tiled windows (Hyprland halves and thirds): desktop layout without the rules pane, and the
  // phone layout in a tall narrow tile.
  { id: 'dark-960t', mode: 'dark', viewport: { width: 960, height: 1400 } },
  { id: 'light-720t', mode: 'light', viewport: { width: 720, height: 1400 } },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const failures = [];
let ran = 0;
try {
  for (const run of RUNS) {
    if (onlyRuns && !onlyRuns.includes(run.id)) continue;
    const phone = run.viewport.width < 861;
    for (const step of STEPS) {
      if (onlySteps && !onlySteps.includes(step.name)) continue;
      if ((step.desktop && phone) || (step.phone && !phone)) continue;
      const ctx = await browser.newContext({ viewport: run.viewport, colorScheme: run.mode, reducedMotion: 'reduce' });
      await ctx.addInitScript(([m, seen]) => {
        try { if (!sessionStorage.getItem('smoke.init')) { localStorage.setItem('sr.theme', m); localStorage.setItem('aurora.whatsNew', seen); sessionStorage.setItem('smoke.init', '1'); } } catch { /* blocked */ }
        // Headless Chromium has no voices: a speech engine that never finishes a paragraph.
        const voices = [{ name: 'Test Voice', lang: 'en-US', voiceURI: 'test-voice', default: true, localService: true }];
        const fake = { speaking: false, paused: false, pending: false, speak() { this.speaking = true; }, cancel() { this.speaking = false; }, pause() { this.paused = true; }, resume() { this.paused = false; }, getVoices: () => voices, addEventListener() {}, removeEventListener() {}, onvoiceschanged: null };
        Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
        if (!window.SpeechSynthesisUtterance) window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        window.addEventListener('unhandledrejection', (e) => console.error(`unhandledrejection: ${e.reason?.message ?? e.reason}`));
      }, [run.mode, WHATS_NEW_SEEN]);
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}${m.location()?.url ? ` (${m.location().url.replace(base, '')})` : ''}`); });
      page.on('requestfailed', (req) => {
        const err = req.failure()?.errorText ?? '';
        // Aborted image loads and closed event streams are the browser tidying up, not failures.
        if (/ERR_ABORTED/.test(err) && (req.resourceType() === 'image' || req.resourceType() === 'media' || /\/api\/events/.test(req.url()))) return;
        if (!req.url().startsWith(base)) return;
        problems.push(`request failed: ${req.method()} ${req.url().replace(base, '')} ${err}`);
      });
      page.on('response', (res) => {
        const u = res.url();
        if (!u.startsWith(base) || res.status() < 400) return;
        if (res.status() === 404 && EXPECTED_404.some((re) => re.test(u))) return;
        problems.push(`HTTP ${res.status()}: ${res.request().method()} ${u.replace(base, '')}`);
      });
      ran++;
      try {
        await fresh(page);
        await step.run(page);
      } catch (e) {
        problems.push(e instanceof StepError ? e.message : `threw: ${String(e.message ?? e).split('\n')[0]}`);
      }
      await settle(page, 200);
      const unique = [...new Set(problems)];
      if (unique.length) failures.push({ run: run.id, step: step.name, problems: unique });
      console.log(`${unique.length ? 'FAIL' : 'ok  '} ${run.id.padEnd(10)} ${step.name}${unique.length ? '\n' + unique.slice(0, verbose ? 50 : 6).map((p) => `       ${p}`).join('\n') : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${ran} step runs, ${failures.length} failing`);
process.exit(failures.length ? 1 : 0);
