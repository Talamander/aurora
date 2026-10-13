#!/usr/bin/env node
// `aurora` / `npm run tui`: Aurora in the terminal. Talks to the local Aurora server.

import { createClient, resolveBase } from './api.ts';
import { runTui } from './tui.ts';
import { summarize, waybar } from './status.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`aurora: your Aurora feed in the terminal

  --url <url>        Aurora server (default AURORA_URL or http://127.0.0.1:4317)
  --profile <name>   start in this profile (default: the app's active profile)
  --view <id>        worth | saved | everything | archive | a saved view id
  --allow-remote     allow a non-loopback server (Aurora is local-only by default)

  aurora status [--json|--waybar]   print what is worth reading and exit (for status bars)
  aurora pick [--saved|--later] [--print]
                     choose a post in Walker, fuzzel, wofi, rofi or fzf (AURORA_MENU overrides),
                     open it in the browser and mark it read; --print only lists the rows
  aurora open <front|ambient|constellation>
                     open that full-screen view of Aurora in the browser

Keys: j/k move, enter read, s save, a archive, r read, / search, v views,
p profiles, . ask, o open, ? help, q quit. Set NO_COLOR to turn colour off.`);
  process.exit(0);
}

if (args[0] === 'status') {
  let b: URL;
  try {
    b = resolveBase(flag('url') ?? process.env.AURORA_URL, args.includes('--allow-remote'));
    const client = createClient(b);
    // An older server has no alerts; the count still works without them.
    const [lib, alertFeed] = await Promise.all([client.library(), client.alertHits().catch(() => null)]);
    const s = summarize(lib, flag('profile') ?? process.env.AURORA_PROFILE, alertFeed);
    if (args.includes('--waybar')) console.log(waybar(s));
    else if (args.includes('--json')) console.log(JSON.stringify(s));
    else console.log(`${s.profile}: ${s.worth} worth reading, ${s.saved} saved${s.alerts?.unseen ? `, ${s.alerts.unseen} alert${s.alerts.unseen === 1 ? '' : 's'}` : ''}`);
    process.exit(0);
  } catch (e) {
    // A status bar should show Aurora as off, not an error dump.
    if (args.includes('--waybar')) console.log(JSON.stringify({ text: '◆', tooltip: 'Aurora is not running', class: 'off' }));
    else console.error((e as Error).message);
    process.exit(args.includes('--waybar') ? 0 : 1);
  }
}

if (args[0] === 'open') {
  const views = ['front', 'ambient', 'constellation'];
  const view = args[1] ?? '';
  if (!views.includes(view)) {
    console.error(`aurora open: choose one of ${views.join(', ')}`);
    process.exit(2);
  }
  const { openInBrowser } = await import('./pick.ts');
  try {
    const url = new URL('/', resolveBase(flag('url') ?? process.env.AURORA_URL, args.includes('--allow-remote')));
    url.searchParams.set(view, '1');
    process.exit(openInBrowser(url.href) ? 0 : 1);
  } catch (e) {
    console.error(`aurora open: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (args[0] === 'pick') {
  const { pickItems, pickRows, chosen, menuCommand, runMenu, openInBrowser } = await import('./pick.ts');
  try {
    const client = createClient(resolveBase(flag('url') ?? process.env.AURORA_URL, args.includes('--allow-remote')));
    const lib = await client.library();
    const items = pickItems(lib, args.includes('--saved') ? 'saved' : args.includes('--later') ? 'later' : 'worth', flag('profile') ?? process.env.AURORA_PROFILE);
    const labels = new Map(lib.sources.map((s) => [s.id, s.label]));
    const rows = pickRows(items, (id) => labels.get(id) ?? '');
    if (args.includes('--print')) {
      console.log(rows.join('\n'));
      process.exit(0);
    }
    if (!rows.length) {
      console.error('Nothing to pick: you are caught up.');
      process.exit(0);
    }
    const menu = menuCommand();
    if (!menu) {
      console.error('No launcher found. Install walker, fuzzel, wofi, rofi, fzf or (on macOS) choose-gui, or set AURORA_MENU (for example "walker --dmenu").');
      process.exit(1);
    }
    const row = await runMenu(menu, rows);
    const it = row ? chosen(items, row) : null;
    if (!it) process.exit(0);
    if (!openInBrowser(it.url)) console.error('That post has no web link.');
    // Opening counts as reading, the same as in the app. Only Aurora's local state changes.
    await client.setState([it.id], { read: true }).catch(() => {});
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('aurora needs an interactive terminal.');
  process.exit(1);
}

let base: URL;
try {
  base = resolveBase(flag('url') ?? process.env.AURORA_URL, args.includes('--allow-remote'));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const client = createClient(base);
try {
  await client.library();
} catch (e) {
  console.error(`Could not reach Aurora at ${base.origin}: ${(e as Error).message}\nStart it with \`npm start\`, or point --url at it.`);
  process.exit(1);
}

await runTui({ client, profile: flag('profile') ?? process.env.AURORA_PROFILE, view: flag('view') });
process.exit(0);
