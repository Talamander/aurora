// Demo library: FICTIONAL sample posts for trying the filters before any real
// account is connected. Every author, handle and link here is invented; links
// point at example.com/example.org. Demo items are flagged isDemo and shown
// with a "Demo" mark in the UI. They are never mixed into a real source.

import type { ItemDraft } from './connectors/types.ts';
import type { Item } from '../core/types.ts';

type Seed = [
  platform: Item['platform'],
  hoursAgo: number,
  author: string,
  handle: string,
  text: string,
  extra?: Partial<ItemDraft>,
];

const SEEDS: Seed[] = [
  ['bluesky', 2, 'Mara Quist', 'mquist.example', 'new zine page: what actually happens when you press ctrl-c in a terminal. The terminal driver turns the keystroke into SIGINT for the whole foreground process group, which is why every program in your pipeline stops at once.', { lang: 'en' }],
  ['rss', 5, 'Teodor Lind', 'lind.example', 'I ran a small local model over 4,000 scanned receipts to pull out the merchant, date and total. It got 93% right on the first pass. The interesting part is the 7% it got wrong, and how few of those it was confident about.', { kind: 'article', title: 'Structured extraction from 4,000 receipts with a local model', links: ['https://lind.example.org/2026/receipts'] }],
  ['x', 26, 'Dev Okafor', 'devokafor', 'The most underrated skill in small business is writing an email that a busy person can answer in one word.', { lang: 'en' }],
  ['rss', 30, 'Small Heat Quarterly', 'smallheat.example', 'Heating the person instead of the room: a short history of the foot warmer, the hot water bottle and the heated bench, and why they are coming back in offices that never got warm enough.', { kind: 'article', title: 'Heat the person, not the room', links: ['https://smallheat.example.org/foot-warmers'] }],
  ['mastodon', 40, 'Ines Varga', 'ivarga@social.example', 'I keep a list of things that sound like formal methods but are really just writing it down. Number one: a table of every state your form can be in, and what each button does in each state.', { lang: 'en' }],
  ['x', 44, 'Growth Daily', 'growthdaily', 'GIVEAWAY: we are giving away 3 lifetime licences. Like if you want one, RT and follow for more. Winners Friday.', { lang: 'en' }],
  ['bluesky', 50, 'Rafa Montoya', 'rafam.example', 'Una tipografía pensada para pantallas pequeñas cambia más de lo que parece: el espacio entre letras importa tanto como la forma de cada una.', { lang: 'es' }],
  ['youtube', 52, 'Workshop Hours', 'workshophours', 'Restoring a 1960s typewriter: cleaning the segment, re-padding the platen and getting the escapement to step evenly again. 38 minutes, no music.', { kind: 'video', title: 'Typewriter restoration, start to finish', links: ['https://video.example.com/watch?v=tw1960'] }],
  ['x', 60, 'Priya Raman', 'priyaraman', 'Wrote up how we cut our SQLite write latency by batching in a single transaction and turning on WAL. Graphs inside.', { links: ['https://priya.example.com/sqlite-wal'] }],
  ['rss', 62, 'Priya Raman', 'priya.example.com', 'Our write path did one transaction per row. Moving to batched transactions with WAL mode cut p99 write latency from 41 ms to 3 ms. Here is what we measured, and the one place it made things worse.', { kind: 'article', title: 'Cutting SQLite write latency with WAL and batching', links: ['https://priya.example.com/sqlite-wal'] }],
  ['bluesky', 70, 'Mara Quist', 'mquist.example', 'lol', {}],
  ['x', 75, 'Ana Brandt', 'anabrandt', 'Thread 🧵 on why most design systems fail: they document components but never the decisions. 1/9', { kind: 'thread' }],
  ['mastodon', 80, 'Hugo Lefèvre', 'hugo@toot.example', 'Petit rappel : un bon message d’erreur dit ce qui s’est passé, pourquoi, et quoi faire ensuite. Le reste est du bruit.', { lang: 'fr' }],
  ['x', 90, 'Deals Hub', 'dealshub', 'Use code SAVE40 for 40% off all courses, limited time offer. Link in bio. #ad #sale #deal #promo #learn #growth', { lang: 'en' }],
  ['rss', 96, 'Field Notes on Type', 'fieldtype.example', 'Optical sizes are the quiet reason a serif can look good at 14 pixels and at 44. A walk through how three screen serifs change their stroke contrast and spacing as they grow.', { kind: 'article', title: 'Why optical sizes matter on screens', links: ['https://fieldtype.example.org/optical-sizes'] }],
  ['bluesky', 100, 'Kenji Mori', 'kmori.example', 'Agents that can read your files are only as safe as the dumbest document they read. Treat every web page as data, never as instructions. We learned this the slow way.', { lang: 'en' }],
  ['x', 110, 'Dev Okafor', 'devokafor', 'Repost', { kind: 'repost', text: '' } as Partial<ItemDraft>],
  ['youtube', 120, 'Signal Path', 'signalpath', 'How a mixing desk actually works: gain staging, the channel strip and why the fader is the last thing you touch.', { kind: 'video', title: 'The mixing desk, explained slowly', links: ['https://video.example.com/watch?v=desk01'] }],
  ['mastodon', 130, 'Ines Varga', 'ivarga@social.example', 'Who else thinks every app should have an export button? Thoughts?', { lang: 'en' }],
  ['rss', 140, 'Teodor Lind', 'lind.example', 'Most of what people call prompt engineering is writing a good brief. Say what done looks like, give an example of the input, and name the one thing that must not happen.', { kind: 'article', title: 'Prompting is briefing', links: ['https://lind.example.org/2026/briefs'] }],
  ['bluesky', 150, 'Lena Koch', 'lenakoch.example', 'Heute gelernt: Rust-Compilerfehler lesen sich viel besser, wenn man sie von unten nach oben liest. Die letzte Zeile ist fast immer die eigentliche Ursache.', { lang: 'de' }],
  ['x', 160, 'Priya Raman', 'priyaraman', 'Hiring: a database engineer who likes boring, correct systems. Remote, EU hours.', { lang: 'en' }],
  ['rss', 170, 'Small Heat Quarterly', 'smallheat.example', 'A reader sent in photographs of a 1920s railway foot warmer: a flat iron box filled with sodium acetate that clicks when you press a metal disc. The chemistry still works.', { kind: 'article', title: 'Letters: the railway foot warmer', links: ['https://smallheat.example.org/letters-railway'] }],
  ['bluesky', 180, 'Kenji Mori', 'kmori.example', 'Small UI thing I love: when an empty state tells you exactly why it is empty. “No posts match ‘rust’ from these 3 sources” beats “Nothing here” every time.', { lang: 'en' }],
  ['x', 200, 'Ana Brandt', 'anabrandt', 'Unpopular opinion: dark mode is not a feature, it is a second design. Agree?', { lang: 'en' }],
  ['mastodon', 220, 'Hugo Lefèvre', 'hugo@toot.example', 'I moved my notes from three apps into plain text files in one folder. Search is grep. Sync is a USB stick on Fridays. I have never been calmer about notes.', { lang: 'en' }],
  ['rss', 240, 'Field Notes on Type', 'fieldtype.example', 'A field guide to hyperlegible typefaces: what makes a 1 different from an l, why open apertures help, and where legibility and style pull against each other.', { kind: 'article', title: 'Hyperlegible, a field guide', links: ['https://fieldtype.example.org/hyperlegible'] }],
  ['youtube', 260, 'Workshop Hours', 'workshophours', 'Sharpening a card scraper in five minutes. The burr is everything.', { kind: 'video', title: 'Card scraper in five minutes', links: ['https://video.example.com/watch?v=scraper5'] }],
  ['x', 300, 'Teodor Lind', 'teolind', 'New post: prompting is briefing.', { links: ['https://lind.example.org/2026/briefs'] }],
  ['bluesky', 340, 'Rafa Montoya', 'rafam.example', 'Sharing a list of 40 free typefaces with real optical sizes. Bookmark this.', { lang: 'en', links: ['https://rafa.example.net/optical-list'] }],
  ['mastodon', 400, 'Ines Varga', 'ivarga@social.example', 'A good on-call handoff note has three parts: what is broken, what you tried, and what you would do next if you had another hour.', { lang: 'en' }],
  ['rss', 480, 'Teodor Lind', 'lind.example', 'I tested five ways to dedupe links across feeds. Canonical URLs with tracking parameters stripped beat everything clever, and caught 94% of repeats.', { kind: 'article', title: 'Deduping links across feeds', links: ['https://lind.example.org/2026/dedupe'] }],
  ['x', 520, 'Growth Daily', 'growthdaily', 'Drop a 🔥 if you are building in public this week', { lang: 'en' }],
  ['bluesky', 600, 'Mara Quist', 'mquist.example', 'Zine idea list, unordered: how DNS caching really works, what a file descriptor is, why your laptop fan spins up during video calls, and what a TTY even is.', { lang: 'en' }],
  ['rss', 700, 'Signal Path', 'signalpath.example', 'Gain staging for people who just want their podcast to sound clear: set the input so speech peaks around -12 dB, and leave the rest alone.', { kind: 'article', title: 'Gain staging, the short version', links: ['https://signalpath.example.org/gain'] }],
  ['x', 800, 'Kenji Mori', 'kenjimori', 'Rule I follow for side projects: if it needs a login before it shows you anything, it is not a side project anymore.', { lang: 'en' }],
];

export function loadDemo(now = new Date()): ItemDraft[] {
  return SEEDS.map(([platform, hoursAgo, name, handle, text, extra], i) => {
    const id = `demo-${String(i + 1).padStart(3, '0')}`;
    const kind = extra?.kind ?? 'post';
    const base = platform === 'rss' || platform === 'youtube' ? 'https://feed.example.com' : `https://${platform}.example.com`;
    const links = extra?.links ?? [];
    return {
      platform,
      externalId: id,
      url: kind === 'article' || kind === 'video' ? links[0] ?? `${base}/${id}` : `${base}/${handle}/${id}`,
      author: { name, handle, url: `${base}/${handle}` },
      title: extra?.title,
      text: (extra as { text?: string })?.text ?? text,
      links,
      media: [],
      quoted: null,
      lang: extra?.lang ?? (platform === 'rss' || platform === 'youtube' ? 'en' : null),
      kind,
      publishedAt: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
      provenance: { connector: 'demo', connectorVersion: 1, via: 'demo' },
      metrics: null,
    } satisfies ItemDraft;
  });
}
