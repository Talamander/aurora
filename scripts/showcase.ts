// Showcase library: a FICTIONAL, fully populated Aurora library for screenshots and for trying
// every surface without connecting a real account.
//
//   node scripts/showcase.ts /tmp/aurora-showcase
//   SOCIAL_READER_DATA=/tmp/aurora-showcase npm start
//
// Every person, account, post and article here is invented. Links point at example.com and
// example.org. Photos are public-domain and CC0 images from Wikimedia Commons (NASA, the US National Park
// Service and others; see docs/media/CREDITS.md) and load from upload.wikimedia.org. Every source is
// flagged as a demo source, the same flag the in-app demo library uses, so nothing here can be
// mistaken for, or mixed into, a real account.
//
// The script refuses to touch an existing library: give it a new or empty folder, never ./data.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../server/db.ts';
import { ingestDrafts } from '../server/ingest.ts';
import { saveArticle, addHighlight, saveReading } from '../server/longform/store.ts';
import { createProfiles } from '../server/profiles.ts';
import { createAlertIn } from '../server/alerts.ts';
import { createRoutineIn } from '../server/routines.ts';
import type { ItemDraft } from '../server/connectors/types.ts';
import type { Article, ArticleBlock, Span } from '../core/longform.ts';
import type { Item, Source } from '../core/types.ts';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/showcase.ts <new-or-empty-folder>');
  process.exit(2);
}
const dir = resolve(target);
if (dir === resolve('data') || dir === resolve(process.env.SOCIAL_READER_DATA ?? 'data')) {
  console.error('Refusing to write the showcase into your real library. Pick a new folder.');
  process.exit(2);
}
if (existsSync(dir) && readdirSync(dir).length) {
  console.error(`${dir} is not empty. The showcase only writes into a new or empty folder.`);
  process.exit(2);
}

// Public-domain photos on Wikimedia Commons, by their path under /wikipedia/commons/thumb/.
const PD = 'https://upload.wikimedia.org/wikipedia/commons/thumb/';
const IMG = {
  auroraIss: 'f/f1/Aurora_Australis_From_ISS.JPG/1280px-Aurora_Australis_From_ISS.JPG',
  auroraLimb: '6/63/Aurora_Borealis.jpg/1280px-Aurora_Borealis.jpg',
  auroraMidwest: '4/49/Aurora_Borealis_Over_the_Midwest.jpg/1280px-Aurora_Borealis_Over_the_Midwest.jpg',
  auroraRed: '3/31/Aurora_Seen_From_Space_by_NASA.jpg/1280px-Aurora_Seen_From_Space_by_NASA.jpg',
  canyonHopi: 'c/cf/Grand_Canyon_NP_Hopi_Point_Sunrise_0022_%285446230117%29.jpg/1280px-Grand_Canyon_NP_Hopi_Point_Sunrise_0022_%285446230117%29.jpg',
  canyonRoyal: 'a/a2/Grand_Canyon_National_Park%2C_North_Rim%2C_Muted_Sunrise_From_Cape_Royal_0163_-_Flickr_-_Grand_Canyon_NPS.jpg/1280px-Grand_Canyon_National_Park%2C_North_Rim%2C_Muted_Sunrise_From_Cape_Royal_0163_-_Flickr_-_Grand_Canyon_NPS.jpg',
  denaliValley: 'd/d4/Denali_National_Park._NPS-Jason_Bennett_%2818499174529%29.jpg/1280px-Denali_National_Park._NPS-Jason_Bennett_%2818499174529%29.jpg',
  denaliTundra: 'b/b5/Denali_National_Park_and_Preserve_AK2006-0363.jpg/1280px-Denali_National_Park_and_Preserve_AK2006-0363.jpg',
  redwoods: '9/96/Redwood_National_Park_REDW2653.jpg/1280px-Redwood_National_Park_REDW2653.jpg',
  iris: 'b/b8/Redwood_National_Park_REDW3301.jpg/1280px-Redwood_National_Park_REDW3301.jpg',
  jupiter: '4/42/Cyclone_storms_encircle_Jupiter%27s_North_Pole%2C_captured_in_infrared_light_by_NASA%27s_Juno_spacecraft.png/1280px-Cyclone_storms_encircle_Jupiter%27s_North_Pole%2C_captured_in_infrared_light_by_NASA%27s_Juno_spacecraft.png',
  earthrise: 'd/d6/AS08-16-2593_remastered.jpg/1280px-AS08-16-2593_remastered.jpg',
  blueMarble: '6/61/Blue_Marble_Western_Hemisphere.jpg/1280px-Blue_Marble_Western_Hemisphere.jpg',
  saturn: '6/6b/Backlit_Saturn_from_Cassini_Orbiter_2007_May_9.jpg/1280px-Backlit_Saturn_from_Cassini_Orbiter_2007_May_9.jpg',
  synths: '4/45/Moog_Mother-32_Semi-Modular_Analog_Synthesizer%2C_MicroKORG%2C_Teenage_Engineering_OP-1_%282017-08-22_15.22.00_piqsels.com_en%29.jpg/1280px-Moog_Mother-32_Semi-Modular_Analog_Synthesizer%2C_MicroKORG%2C_Teenage_Engineering_OP-1_%282017-08-22_15.22.00_piqsels.com_en%29.jpg',
  typewriter: '3/3a/Vintage_black_typewriter_%28Unsplash%29.jpg/1280px-Vintage_black_typewriter_%28Unsplash%29.jpg',
  library: 'a/a8/LOC_Main_Reading_Room_Highsmith.jpg/1280px-LOC_Main_Reading_Room_Highsmith.jpg',
  cat: '5/5c/Domestic_cat_2011_G02.jpg/1280px-Domestic_cat_2011_G02.jpg',
  snowBike: '3/30/Bike_on_a_snowy_street_in_Quebec_City_at_night.jpg/1280px-Bike_on_a_snowy_street_in_Quebec_City_at_night.jpg',
  coffee: 'c/c5/Roasted_coffee_beans.jpg/1280px-Roasted_coffee_beans.jpg',
  waves: 'e/e4/Clipperton_Waves.jpg/1280px-Clipperton_Waves.jpg',
  oldCity: 'd/d9/Chateau_Frontenac_illuminated_at_night_in_Quebec_City.jpg/1280px-Chateau_Frontenac_illuminated_at_night_in_Quebec_City.jpg',
} as const;
type ImgKey = keyof typeof IMG;
const img = (k: ImgKey) => PD + IMG[k];
const pic = (k: ImgKey, alt: string) => ({ type: 'image' as const, url: img(k), alt });

// --- Sources ---------------------------------------------------------------------------------------

interface SourceSeed { key: string; label: string; platform: string; ageDays: number }
const SOURCES: SourceSeed[] = [
  { key: 'nightsky', label: 'Night Sky Field Notes', platform: 'rss', ageDays: 60 },
  { key: 'orbit', label: 'Orbit Desk', platform: 'bluesky', ageDays: 45 },
  { key: 'ranger', label: 'Ranger Dispatch', platform: 'mastodon', ageDays: 50 },
  { key: 'people', label: 'People I follow', platform: 'bluesky', ageDays: 90 },
  { key: 'fedi', label: 'Fediverse friends', platform: 'mastodon', ageDays: 80 },
  { key: 'priya', label: 'Priya Raman', platform: 'rss', ageDays: 70 },
  { key: 'teodor', label: 'Teodor Lind', platform: 'rss', ageDays: 70 },
  { key: 'type', label: 'Field Notes on Type', platform: 'rss', ageDays: 70 },
  { key: 'workshop', label: 'Workshop Hours', platform: 'youtube', ageDays: 40 },
  { key: 'signal', label: 'Signal Path', platform: 'youtube', ageDays: 40 },
  { key: 'patch', label: 'r/patchcables', platform: 'reddit', ageDays: 35 },
  { key: 'kettle', label: 'Quiet Kettle Coffee', platform: 'rss', ageDays: 33 },
  { key: 'growth', label: 'Growth Daily', platform: 'x', ageDays: 31 },
];

// --- Posts -----------------------------------------------------------------------------------------

interface PostSeed {
  src: string;
  /** Minutes before now. */
  ago: number;
  name: string;
  handle: string;
  text: string;
  title?: string;
  kind?: Item['kind'];
  media?: ItemDraft['media'];
  link?: string;
  replyTo?: string;
  id?: string;
}

const H = 60;
const D = 24 * H;

const POSTS: PostSeed[] = [
  // Night sky
  { id: 'ns-aurora', src: 'nightsky', ago: 35, name: 'Night Sky Field Notes', handle: 'nightsky.example', kind: 'article', title: 'What the aurora is made of', link: 'https://nightsky.example.org/what-the-aurora-is-made-of', text: 'The green is oxygen 100 km up, the red is oxygen higher still, and the purple fringe is nitrogen. A field guide to reading the colours of an aurora, and what each one says about the storm that made it.', media: [pic('auroraIss', 'Green aurora curving over the Earth, seen from the International Space Station')] },
  { src: 'orbit', ago: 52, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'Tonight from the station: the aurora draped over the southern Indian Ocean, with the airglow as a thin gold line above it. The crew says it moved like a curtain in a draught.', media: [pic('auroraLimb', 'A band of green aurora along the curve of the Earth')] },
  { src: 'orbit', ago: 3 * H, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'Juno looked straight down at Jupiter\'s north pole in infrared. Eight cyclones circle one in the middle, each wider than the United States, and the pattern has held for years.', media: [pic('jupiter', 'Infrared view of cyclones packed around Jupiter\'s north pole')] },
  { src: 'nightsky', ago: 6 * H, name: 'Night Sky Field Notes', handle: 'nightsky.example', kind: 'article', title: 'Tonight\'s forecast: Kp 6 and clear to the north', link: 'https://nightsky.example.org/forecast-kp6', text: 'A coronal mass ejection arrives around 22:00. If the clouds hold off, look low on the northern horizon from about 45° latitude. Phones see the colour before your eyes do.', media: [pic('auroraMidwest', 'Aurora over city lights in the American Midwest')] },
  { src: 'orbit', ago: 9 * H, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'Cassini, 2007: Saturn with the Sun behind it. The rings light up from behind and the planet throws its shadow across them. Still the picture I put on every new laptop.', media: [pic('saturn', 'Saturn backlit by the Sun, its rings glowing')] },
  { src: 'orbit', ago: 27 * H, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'Apollo 8, December 1968. The first people to see the whole Earth from far enough away to fit it in a window.', media: [pic('earthrise', 'The Earth as a blue disc against black space, seen from Apollo 8')] },
  { src: 'orbit', ago: 2 * D + 4 * H, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'Red and green at the same time is rare from the ground and common from orbit. The red is oxygen above 200 km, where atoms wait long enough between collisions to glow.', media: [pic('auroraRed', 'Red and green aurora seen from orbit with the station in the foreground')] },
  { src: 'orbit', ago: 4 * D, name: 'Orbit Desk', handle: 'orbitdesk.example', text: 'The Blue Marble, western hemisphere. Stitched from months of satellite passes, so every cloud in it is real but they were never all there at once.', media: [pic('blueMarble', 'The western hemisphere of the Earth with swirling clouds')] },

  // Parks
  { src: 'ranger', ago: 80, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Sunrise at Hopi Point this morning. Arrive 40 minutes early: the best colour is before the sun clears the rim, not after.', media: [pic('canyonHopi', 'Sunrise light across the layered walls of the Grand Canyon')] },
  { src: 'ranger', ago: 5 * H, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Denali showed itself today for the first time in nine days. About 30% of visitors ever see the summit. The road is open to mile 43.', media: [pic('denaliValley', 'Snow-covered Denali above a green valley')] },
  { src: 'ranger', ago: 20 * H, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Under the redwoods the light comes down green. Stay on the trail: the shallow roots spread up to 30 m and the soil compacts for years.', media: [pic('redwoods', 'A forest trail under tall redwoods')] },
  { src: 'ranger', ago: 2 * D, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Douglas iris along the Lady Bird Johnson Grove trail. Look, don\'t pick: everything in the park stays in the park.', media: [pic('iris', 'A pale Douglas iris flower against dark leaves')] },
  { src: 'ranger', ago: 3 * D, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Cape Royal on the North Rim. Muted sunrise, no wind, and the canyon full of haze in layers like a stage set.', media: [pic('canyonRoyal', 'Hazy layered ridges of the Grand Canyon at sunrise from the North Rim')] },
  { src: 'ranger', ago: 5 * D, name: 'Ranger Dispatch', handle: 'ranger@parks.example', text: 'Autumn on the Denali tundra lasts about two weeks. The dwarf birch goes red first, then the willows go gold.', media: [pic('denaliTundra', 'Red autumn tundra and spruce below the Alaska Range')] },

  // People
  { src: 'people', ago: 18, name: 'Mara Quist', handle: 'mquist.example', text: 'new zine page: what actually happens when you press ctrl-c in a terminal. The terminal driver turns the keystroke into SIGINT for the whole foreground process group, which is why every program in your pipeline stops at once.' },
  { src: 'people', ago: 70, name: 'Kenji Mori', handle: 'kmori.example', text: 'Agents that can read your files are only as safe as the dumbest document they read. Treat every web page as data, never as instructions. We learned this the slow way.' },
  { src: 'people', ago: 2 * H + 10, name: 'Lena Koch', handle: 'lenakoch.example', text: 'Our cat has decided the radiator shelf is hers from October to April. Negotiations have not begun.', media: [pic('cat', 'A black and white cat lying on a brown leather sofa')] },
  { src: 'people', ago: 7 * H, name: 'Rafa Montoya', handle: 'rafam.example', text: 'Rode home through the old town after the first snow. The bike stayed outside overnight and now it lives there.', media: [pic('snowBike', 'A bicycle half buried in snow on a city street at night')] },
  { src: 'people', ago: 11 * H, name: 'Kenji Mori', handle: 'kmori.example', text: 'Small UI thing I love: when an empty state tells you exactly why it is empty. "No posts match rust from these 3 sources" beats "Nothing here" every time.' },
  { src: 'people', ago: 30 * H, name: 'Rafa Montoya', handle: 'rafam.example', text: 'Quebec City at night, one week before the snow. Every window lit, nobody outside.', media: [pic('oldCity', 'A castle-like hotel lit up at night above a city park')] },
  // A numbered thread from one author: the feed folds it into one card and the reader reads it as one piece.
  { id: 'th-1', src: 'people', ago: 4 * H, name: 'Ana Brandt', handle: 'anabrandt.example', text: '1/5 Why most design systems fail: they document components but never the decisions. A thread from ten years of watching them rot.' },
  { id: 'th-2', src: 'people', ago: 4 * H - 2, name: 'Ana Brandt', handle: 'anabrandt.example', replyTo: 'th-1', text: '2/5 A button library tells you what a button looks like. It never tells you why there is only one primary button per screen, so the second team adds three.' },
  { id: 'th-3', src: 'people', ago: 4 * H - 4, name: 'Ana Brandt', handle: 'anabrandt.example', replyTo: 'th-2', text: '3/5 Write the decision next to the component: what problem it solved, what you tried first, and what would make you change it.' },
  { id: 'th-4', src: 'people', ago: 4 * H - 6, name: 'Ana Brandt', handle: 'anabrandt.example', replyTo: 'th-3', text: '4/5 Decisions age better than pixels. A team can repaint every component in a quarter; it cannot rediscover why the modal never stacks.' },
  { id: 'th-5', src: 'people', ago: 4 * H - 8, name: 'Ana Brandt', handle: 'anabrandt.example', replyTo: 'th-4', text: '5/5 So: one page per component, and the first heading on it is "Why". Everything else is a screenshot.' },

  // Fediverse
  { src: 'fedi', ago: 45, name: 'Ines Varga', handle: 'ivarga@social.example', text: 'A good on-call handoff note has three parts: what is broken, what you tried, and what you would do next if you had another hour.' },
  { src: 'fedi', ago: 8 * H, name: 'Hugo Lefèvre', handle: 'hugo@toot.example', text: 'I moved my notes from three apps into plain text files in one folder. Search is grep. Sync is a USB stick on Fridays. I have never been calmer about notes.' },
  { src: 'fedi', ago: 14 * H, name: 'Ines Varga', handle: 'ivarga@social.example', text: 'I keep a list of things that sound like formal methods but are really just writing it down. Number one: a table of every state your form can be in, and what each button does in each state.' },
  { src: 'fedi', ago: 26 * H, name: 'Hugo Lefèvre', handle: 'hugo@toot.example', text: 'Petit rappel : un bon message d\'erreur dit ce qui s\'est passé, pourquoi, et quoi faire ensuite. Le reste est du bruit.' },
  { src: 'fedi', ago: 3 * D, name: 'Ines Varga', handle: 'ivarga@social.example', text: 'Who else thinks every app should have an export button? Thoughts?' },

  // Blogs
  { id: 'pr-wal', src: 'priya', ago: 2 * H + 40, name: 'Priya Raman', handle: 'priya.example.com', kind: 'article', title: 'Cutting SQLite write latency with WAL and batching', link: 'https://priya.example.com/sqlite-wal', text: 'Our write path did one transaction per row. Moving to batched transactions with WAL mode cut p99 write latency from 41 ms to 3 ms. Here is what we measured, and the one place it made things worse.' },
  { src: 'priya', ago: 4 * D, name: 'Priya Raman', handle: 'priya.example.com', kind: 'article', title: 'The boring database checklist', link: 'https://priya.example.com/boring-checklist', text: 'Backups you have restored, migrations you can run twice, and one dashboard a tired person can read at 3 am. Everything else is a bonus.' },
  { id: 'tl-briefs', src: 'teodor', ago: 10 * H, name: 'Teodor Lind', handle: 'lind.example', kind: 'article', title: 'Prompting is briefing', link: 'https://lind.example.org/2026/briefs', text: 'Most of what people call prompt engineering is writing a good brief. Say what done looks like, give an example of the input, and name the one thing that must not happen.' },
  { src: 'teodor', ago: 2 * D + 6 * H, name: 'Teodor Lind', handle: 'lind.example', kind: 'article', title: 'Structured extraction from 4,000 receipts with a local model', link: 'https://lind.example.org/2026/receipts', text: 'I ran a small local model over 4,000 scanned receipts to pull out the merchant, date and total. It got 93% right on the first pass. The interesting part is the 7% it got wrong, and how few of those it was confident about.' },
  { id: 'ft-optical', src: 'type', ago: 16 * H, name: 'Field Notes on Type', handle: 'fieldtype.example', kind: 'article', title: 'Why optical sizes matter on screens', link: 'https://fieldtype.example.org/optical-sizes', text: 'Optical sizes are the quiet reason a serif can look good at 14 pixels and at 44. A walk through how three screen serifs change their stroke contrast and spacing as they grow.', media: [pic('library', 'The domed main reading room of a great library')] },
  { src: 'type', ago: 6 * D, name: 'Field Notes on Type', handle: 'fieldtype.example', kind: 'article', title: 'Hyperlegible, a field guide', link: 'https://fieldtype.example.org/hyperlegible', text: 'What makes a 1 different from an l, why open apertures help, and where legibility and style pull against each other.' },
  { id: 'qk-roast', src: 'kettle', ago: 28 * H, name: 'Quiet Kettle Coffee', handle: 'quietkettle.example', kind: 'article', title: 'Light roast, slow water', link: 'https://quietkettle.example.org/light-roast', text: 'Light roasts taste sour when the water is too cool and bitter when you grind too fine to make up for it. Start at 96 °C and change one thing at a time.', media: [pic('coffee', 'A heap of dark roasted coffee beans')] },

  // Video and community
  { src: 'workshop', ago: 13 * H, name: 'Workshop Hours', handle: 'workshophours', kind: 'video', title: 'Typewriter restoration, start to finish', link: 'https://video.example.com/watch?v=tw1960', text: 'Restoring a 1960s typewriter: cleaning the segment, re-padding the platen and getting the escapement to step evenly again. 38 minutes, no music.', media: [pic('typewriter', 'A black vintage typewriter on a wooden desk')] },
  { src: 'signal', ago: 22 * H, name: 'Signal Path', handle: 'signalpath', kind: 'video', title: 'Three small synths, one patch', link: 'https://video.example.com/watch?v=synth3', text: 'A semi-modular, a tiny keyboard and a sampler, patched into one evolving pad. Every cable explained, no talking over the sound.', media: [pic('synths', 'A semi-modular synthesizer with patch cables beside two small keyboards')] },
  { src: 'patch', ago: 5 * H + 20, name: 'u/slow_lfo', handle: 'slow_lfo', title: 'Finally finished my first full patch without a tutorial', text: 'Took three weekends. The trick was patching the envelope into the filter AND the VCA at different depths. It finally breathes.' },
  { src: 'patch', ago: 2 * D, name: 'u/cv_gate', handle: 'cv_gate', title: 'PSA: label both ends of your cables', text: 'Masking tape and a pen. You will thank yourself at 1 am.' },

  // Noise that the default rules set aside
  { src: 'growth', ago: 40, name: 'Growth Daily', handle: 'growthdaily', text: 'GIVEAWAY: we are giving away 3 lifetime licences. Like if you want one, RT and follow for more. Winners Friday.' },
  { src: 'growth', ago: 3 * H, name: 'Growth Daily', handle: 'growthdaily', text: 'Use code SAVE40 for 40% off all courses, limited time offer. Link in bio. #ad #sale #deal #promo #learn #growth' },
  { src: 'growth', ago: 9 * H, name: 'Growth Daily', handle: 'growthdaily', text: 'Drop a 🔥 if you are building in public this week' },
];

// Older, quieter posts so the 30-day views (report cards, your week, constellation) have history.
const BACKFILL: Record<string, { name: string; handle: string; lines: string[]; kind?: Item['kind'] }[]> = {
  nightsky: [{ name: 'Night Sky Field Notes', handle: 'nightsky.example', kind: 'article', lines: ['Why the Moon looks bigger on the horizon', 'A beginner\'s map of the autumn sky', 'Noctilucent clouds: the highest clouds on Earth', 'How to photograph meteors with a phone', 'The planets this month, in order of brightness', 'What a Kp index actually measures'] }],
  orbit: [{ name: 'Orbit Desk', handle: 'orbitdesk.example', lines: ['Station reboost tonight: 1.2 m/s, about the speed of a slow walk.', 'Cargo capsule berthed at 06:14. Fresh fruit on board.', 'Two spacewalks scheduled next week to swap a battery.', 'The station passes over at 19:42 tonight, magnitude -3.5.', 'Spotted from orbit: the lights of the fishing fleet off Korea.'] }],
  ranger: [{ name: 'Ranger Dispatch', handle: 'ranger@parks.example', lines: ['Trail 4 is closed for bridge repair until Friday.', 'Bear activity near the campground. Store food in the lockers.', 'Ranger talk at 19:00 at the amphitheatre: fire and the forest.', 'First frost on the rim this morning.', 'Shuttle schedule changes for the autumn season.'] }],
  people: [
    { name: 'Mara Quist', handle: 'mquist.example', lines: ['Zine idea list: how DNS caching works, what a file descriptor is, what a TTY even is.', 'Printed 200 copies. The stapler did not survive.', 'lol', 'Spent today reading man pages for fun. No regrets.'] },
    { name: 'Kenji Mori', handle: 'kmori.example', lines: ['Rule for side projects: if it needs a login before it shows you anything, it is not a side project anymore.', 'Shipped the small thing. Going for a walk.', 'Reading old RFCs is underrated comfort reading.'] },
    { name: 'Lena Koch', handle: 'lenakoch.example', lines: ['Heute gelernt: Rust-Compilerfehler liest man am besten von unten nach oben.', 'Bread attempt number four. Better crumb, still flat.', 'The cat has learned to open the cupboard.'] },
  ],
  fedi: [{ name: 'Ines Varga', handle: 'ivarga@social.example', lines: ['Incident review culture is mostly about who gets to ask questions.', 'Wrote the runbook. Deleted half of it. Better.', 'Tea, logs, quiet. Good on-call morning.'] }],
  priya: [{ name: 'Priya Raman', handle: 'priya.example.com', kind: 'article', lines: ['Indexes I removed this year', 'A tiny guide to EXPLAIN', 'Hiring for boring systems'] }],
  teodor: [{ name: 'Teodor Lind', handle: 'lind.example', kind: 'article', lines: ['Deduping links across feeds', 'Local models for boring jobs', 'Evaluations you can run on a laptop'] }],
  type: [{ name: 'Field Notes on Type', handle: 'fieldtype.example', kind: 'article', lines: ['Tabular figures and why your table wobbles', 'A short history of the interrobang', 'Line length on phones'] }],
  workshop: [{ name: 'Workshop Hours', handle: 'workshophours', kind: 'video', lines: ['Card scraper in five minutes', 'Flattening a plane sole by hand', 'Rehandling a chisel'] }],
  signal: [{ name: 'Signal Path', handle: 'signalpath', kind: 'video', lines: ['The mixing desk, explained slowly', 'Gain staging, the short version', 'Why tape saturation sounds warm'] }],
  patch: [{ name: 'u/slow_lfo', handle: 'slow_lfo', lines: ['Is a 104 HP case enough to start?', 'My first sequencer patch (it is bad, I love it)', 'Favourite free VCV patches?'] }],
  kettle: [{ name: 'Quiet Kettle Coffee', handle: 'quietkettle.example', kind: 'article', lines: ['Grinding for a pour-over', 'Water hardness, simply', 'A week of decaf, honestly'] }],
  growth: [{ name: 'Growth Daily', handle: 'growthdaily', lines: ['GIVEAWAY time! Follow + RT to win. #giveaway #win', 'Like and RT if you agree!!! 🔥🔥', 'Limited time offer, link in bio #ad #promo', 'Drop a 🚀 if you are shipping today', 'Tag 3 friends who need this #growth #hustle', 'FREE ebook, just follow and RT #free #giveaway'] }],
};

// --- Full articles for the reader ---------------------------------------------------------------------

const p = (...spans: (string | Span)[]): ArticleBlock => ({ t: 'p', spans: spans.map((s) => (typeof s === 'string' ? { text: s } : s)) });
const h = (text: string, level: 2 | 3 = 2): ArticleBlock => ({ t: 'h', level, text });

const ARTICLES: Record<string, { byline: string; site: string; lead?: ImgKey; blocks: ArticleBlock[] }> = {
  'ns-aurora': {
    byline: 'Edda Halvorsen', site: 'Night Sky Field Notes', lead: 'auroraIss',
    blocks: [
      p('An aurora is the sky glowing because something hit it. Particles from the Sun, carried on the solar wind, get caught in the Earth\'s magnetic field and funnelled down towards the poles. When they reach the thin upper atmosphere they collide with oxygen and nitrogen, and those atoms give the energy back as light.'),
      p('That is the whole trick. Everything else about an aurora, the colours, the shapes, the way it ripples, comes from ', { text: 'which', i: true }, ' atoms were hit, ', { text: 'how high', i: true }, ' they were, and how hard the Sun was pushing that night.'),
      h('Green: oxygen, about 100 km up'),
      p('The green you see in almost every photograph is oxygen at around 100 to 250 km. An excited oxygen atom there takes about three quarters of a second to give up its light, and at that height it usually gets the chance before it bumps into something else. The result is the bright, curtain-like green at 557.7 nanometres.'),
      { t: 'img', src: img('auroraLimb'), alt: 'A band of green aurora along the curve of the Earth', caption: 'From orbit the green sits as a ring around the pole. Photo: NASA, public domain.' },
      h('Red: oxygen, higher still'),
      p('Above about 250 km the air is so thin that an oxygen atom can wait almost two minutes without a collision. That gives it time for a slower, lower-energy emission at 630 nanometres: a deep red. Red auroras are faint and high, so from the ground they often show as a glow above the green, and they are the colour people see first at lower latitudes during a big storm.'),
      { t: 'quote', spans: [{ text: 'If you only see red on the horizon, you are seeing the very top of a display that is overhead for someone a thousand kilometres north of you.' }] },
      h('Purple and blue: nitrogen'),
      p('Nitrogen glows blue and violet. You see it along the lower edge of a bright curtain, where energetic particles reach deepest, sometimes down to 80 km. A pink or purple fringe at the bottom is a sign the storm is strong.'),
      h('Reading a display', 3),
      { t: 'ul', items: [[{ text: 'A quiet green arc', b: true }, { text: ' low in the north is normal on most clear nights near the auroral oval.' }], [{ text: 'Rays and curtains', b: true }, { text: ' that move mean the particles are arriving in bursts.' }], [{ text: 'Red overhead', b: true }, { text: ' at mid-latitudes means a major storm. Go outside.' }]] },
      { t: 'img', src: img('auroraRed'), alt: 'Red and green aurora seen from orbit', caption: 'Red above green, as it often looks from the station. Photo: NASA, public domain.' },
      p('Phones help. A camera sensor gathers light for several seconds and sees colour where your eyes, in the dark, see grey. If you are not sure, take a three-second photograph of the northern sky. If it comes back green, you are looking at oxygen 100 km up, lit by the Sun from 150 million kilometres away.'),
    ],
  },
  'pr-wal': {
    byline: 'Priya Raman', site: 'priya.example.com',
    blocks: [
      p('Our ingest service writes small rows, all day, from a dozen workers. For two years it did one transaction per row, because that was what the first version did and nobody had a reason to change it. Then the p99 write latency crept past 40 ms and the queue started to back up during the morning peak.'),
      h('What we changed'),
      p('Two things, in this order. First, we turned on write-ahead logging, so readers stop blocking writers and a commit is an append instead of a rewrite. Second, we batched: each worker collects rows for up to 20 ms or 200 rows, whichever comes first, and commits them in one transaction.'),
      { t: 'code', lang: 'sql', text: "PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA busy_timeout = 5000;\n\nBEGIN;\n-- up to 200 inserts\nCOMMIT;" },
      h('What we measured'),
      { t: 'ul', items: [[{ text: 'p99 write latency: 41 ms down to 3 ms.' }], [{ text: 'Throughput at peak: 1,900 rows/s up to 14,000 rows/s.' }], [{ text: 'Disk writes per row: about 1/40th of before.' }]] },
      p('The one place it got worse: a crash now loses up to 20 ms of rows that were acknowledged to the worker but not yet committed. For us that was fine, because the workers retry from the source. If your writes are the source of truth, keep ', { text: 'synchronous = FULL', code: true }, ' and accept the slower commits.'),
      h('The boring lesson'),
      p('Nothing here is new. WAL mode is older than most of our team. The lesson is to measure the write path once a year, because the defaults you started with were chosen for a load you no longer have.'),
    ],
  },
  'ft-optical': {
    byline: 'Juno Okonkwo', site: 'Field Notes on Type', lead: 'library',
    blocks: [
      p('Set the same serif at 14 pixels and at 44, and something is off at one end or the other. At the small size the hairlines vanish and the counters close up; at the large size the letters look clumsy, the spacing loose, the details coarse. That is not your eyes. Type that is drawn for one size is a compromise at every other.'),
      p('Metal type solved this by accident: every size was cut by hand, so every size was drawn for itself. A 6 point letter had thicker hairlines, wider spacing and a taller x-height than the same face at 72 point. Digital fonts scaled one drawing to every size, and we lost that for forty years.'),
      h('What changes as a face grows'),
      { t: 'ol', items: [[{ text: 'Stroke contrast rises: hairlines get thinner because there is room for them.' }], [{ text: 'Spacing tightens: large letters need less air between them to read as a word.' }], [{ text: 'The x-height drops and details sharpen: ink traps close, terminals get finer.' }]] },
      { t: 'quote', spans: [{ text: 'A text size should disappear. A display size should be looked at. Optical sizes let one family do both.' }] },
      p('Variable fonts brought this back as an axis, ', { text: 'opsz', code: true }, ', and modern browsers set it automatically from the font size. If your face has the axis, you get the right drawing for free. If it does not, pick a text cut for body copy and a display cut for headlines, and never let the display cut fall below about 24 pixels.'),
      h('Three faces, side by side', 3),
      p('We set three screen serifs from 12 to 72 pixels and measured the stem-to-hairline ratio at each size. The face with a real optical axis kept a ratio near 3:1 at text sizes and opened up to 7:1 at display sizes. The two without it stayed at 4:1 everywhere, which is too thin at 12 pixels and too heavy at 72.'),
    ],
  },
  'qk-roast': {
    byline: 'Sol Abernathy', site: 'Quiet Kettle Coffee', lead: 'coffee',
    blocks: [
      p('Light roasts are dense. The beans spent less time in the roaster, so they are harder and give up their flavour more slowly. Most bad cups of light roast are under-extracted: sour, thin and over in a sip.'),
      h('Start here'),
      { t: 'ul', items: [[{ text: '15 g coffee to 250 g water.' }], [{ text: 'Water just off the boil, about 96 °C.' }], [{ text: 'A medium-fine grind, like table salt.' }], [{ text: 'Total brew time near three minutes.' }]] },
      p('If it is sour, grind finer or pour hotter. If it is bitter and dry, grind coarser. Change one thing at a time, and write it down, because tomorrow you will not remember which cup was the good one.'),
    ],
  },
  'tl-briefs': {
    byline: 'Teodor Lind', site: 'lind.example.org',
    blocks: [
      p('Most of what people call prompt engineering is writing a good brief. The same three things that make a brief work for a contractor make it work for a model.'),
      { t: 'ol', items: [[{ text: 'Say what done looks like.', b: true }, { text: ' Not the task, the finished thing: a table with these columns, a paragraph under 80 words.' }], [{ text: 'Show one example of the input.', b: true }, { text: ' Real, messy, the kind that breaks things.' }], [{ text: 'Name the one thing that must not happen.', b: true }, { text: ' One. A list of ten is a list of none.' }]] },
      p('Everything else, the role-play, the capital letters, the threats, is noise that a good brief makes unnecessary.'),
    ],
  },
};

function countWords(blocks: ArticleBlock[]): number {
  const text = blocks.map((b) => ('spans' in b ? b.spans.map((s) => s.text).join('') : 'items' in b ? b.items.flat().map((s) => s.text).join(' ') : 'text' in b ? b.text : '')).join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}

// --- Build ---------------------------------------------------------------------------------------------

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const store = new Store(dir);
const src: Record<string, Source> = {};
for (const s of SOURCES) {
  src[s.key] = store.createSource({ connector: 'demo', label: s.label, platform: s.platform, config: { note: 'Fictional showcase source. Not a real account.' }, isDemo: true, status: 'ok' });
  store.db.prepare('UPDATE sources SET created_at = ? WHERE id = ?').run(iso(s.ageDays * D), src[s.key].id);
}

const ext = (seed: PostSeed, i: number) => seed.id ?? `sc-${String(i).padStart(3, '0')}`;
const draftOf = (seed: PostSeed, i: number): ItemDraft => {
  const source = SOURCES.find((s) => s.key === seed.src)!;
  const id = ext(seed, i);
  const base = `https://${source.platform}.example.com`;
  return {
    platform: source.platform,
    externalId: id,
    url: seed.link ?? `${base}/${seed.handle}/${id}`,
    author: { name: seed.name, handle: seed.handle, url: `${base}/${seed.handle}` },
    title: seed.title,
    text: seed.text,
    links: seed.link ? [seed.link] : [],
    media: seed.media ?? [],
    quoted: null,
    lang: /[àâçéèêëîïôûùüÿœ]|\b(le|est|du)\b/.test(seed.text) ? 'fr' : /\b(ist|liest|die|und|man)\b/.test(seed.text) ? 'de' : 'en',
    kind: seed.kind ?? 'post',
    replyTo: seed.replyTo ? `${source.platform}:${seed.replyTo}` : undefined,
    publishedAt: iso(seed.ago),
    provenance: { connector: 'demo', connectorVersion: 1, via: 'demo' },
    metrics: null,
  } as ItemDraft;
};

const all: PostSeed[] = [...POSTS];
// Spread the backfill over the last 30 days, a little uneven, like real feeds.
let n = 0;
for (const [key, authors] of Object.entries(BACKFILL)) {
  for (const a of authors) {
    a.lines.forEach((line, j) => {
      n++;
      const ago = (1.5 + ((j * 4.7 + n * 1.3) % 27)) * D + ((n * 137) % (20 * H));
      all.push({ src: key, ago, name: a.name, handle: a.handle, kind: a.kind, title: a.kind === 'article' || a.kind === 'video' ? line : undefined, text: a.kind === 'article' || a.kind === 'video' ? `${line}. A fictional post from the showcase library.` : line, link: a.kind === 'article' || a.kind === 'video' ? `https://${key}.example.org/${n}` : undefined });
    });
  }
}

const bySource = new Map<string, ItemDraft[]>();
all.forEach((seed, i) => {
  const list = bySource.get(seed.src) ?? [];
  list.push(draftOf(seed, i));
  bySource.set(seed.src, list);
});
let added = 0;
for (const [key, drafts] of bySource) {
  added += ingestDrafts(store, src[key], drafts).added;
  store.updateSource(src[key].id, { status: 'ok', lastSyncAt: iso(4 + Math.random() * 20) });
}

const itemId = (seed: PostSeed) => {
  const i = all.indexOf(seed);
  return `${SOURCES.find((s) => s.key === seed.src)!.platform}:${ext(seed, i)}`;
};
const byExt = (id: string) => itemId(all.find((s) => s.id === id)!);

// Articles, with reading progress and highlights.
for (const [id, a] of Object.entries(ARTICLES)) {
  const seed = all.find((s) => s.id === id)!;
  const words = countWords(a.blocks);
  const art: Article = {
    itemId: itemId(seed), url: seed.link!, title: seed.title!, byline: a.byline, siteName: a.site, publishedAt: iso(seed.ago),
    leadImage: a.lead ? img(a.lead) : null, excerpt: seed.text, blocks: a.blocks, words, minutes: Math.max(1, Math.round(words / 230)), fetchedAt: iso(seed.ago - 5),
  };
  saveArticle(store, art);
}
saveReading(store, byExt('ft-optical'), 0.45, 4);
saveReading(store, byExt('pr-wal'), 0.2, 2);
addHighlight(store, { itemId: byExt('ns-aurora'), block: 3, quote: 'An excited oxygen atom there takes about three quarters of a second to give up its light', color: 'green', note: 'So the green is a timing thing, not just a chemistry thing.' });
addHighlight(store, { itemId: byExt('ns-aurora'), block: 10, quote: 'take a three-second photograph of the northern sky', color: 'lamp' });
addHighlight(store, { itemId: byExt('ft-optical'), block: 4, quote: 'A text size should disappear. A display size should be looked at.', color: 'blue' });
addHighlight(store, { itemId: byExt('pr-wal'), block: 7, quote: 'measure the write path once a year', color: 'pink', note: 'Put this in the team calendar.' });

// Reading state: read, saved, Read later and a collection.
const items = store.listItems();
const ids = (pred: (it: Item) => boolean) => items.filter(pred).map((it) => it.id);
const sourceOf = (k: string) => src[k].id;
store.addCollection('Read later');
store.addCollection('Night sky');
const older = (it: Item, minutes: number) => Date.parse(it.publishedAt) < now - minutes * 60_000;
const read = ids((it) => it.sourceId !== sourceOf('growth') && older(it, 6 * H) && (it.externalId.charCodeAt(it.externalId.length - 1) % 3 !== 0));
for (const id of read) {
  const it = items.find((x) => x.id === id)!;
  store.patchState([id], { read: true });
  store.db.prepare('UPDATE item_state SET read_at = ? WHERE item_id = ?').run(new Date(Math.min(now, Date.parse(it.publishedAt) + 3 * 3_600_000)).toISOString(), id);
}
const saved = [byExt('ns-aurora'), byExt('ft-optical'), byExt('qk-roast'), ...ids((it) => it.sourceId === sourceOf('ranger') && it.media.length > 0).slice(0, 3), ...ids((it) => it.sourceId === sourceOf('orbit') && it.media.length > 0).slice(1, 4)];
store.patchState(saved, { saved: true });
for (const id of [byExt('pr-wal'), byExt('ft-optical'), byExt('tl-briefs'), byExt('qk-roast')]) {
  const it = store.getItem(id)!;
  store.patchState([id], { collections: [...it.state.collections, 'Read later'] });
}
for (const id of ids((it) => it.sourceId === sourceOf('orbit') && it.media.length > 0).slice(0, 4)) {
  const it = store.getItem(id)!;
  store.patchState([id], { collections: [...it.state.collections, 'Night sky'] });
}

// Topics, profiles, an alert, a routine and some reading time.
store.saveTopic({ id: 'topic-aurora', name: 'Aurora', terms: ['aurora', 'kp', 'solar wind', 'geomagnetic'] });
store.saveTopic({ id: 'topic-databases', name: 'Databases', terms: ['sqlite', 'postgres', 'wal', 'index', 'database'] });
store.saveTopic({ id: 'topic-type', name: 'Typography', terms: ['typeface', 'serif', 'optical', 'legib'] });

const profiles = createProfiles(store);
const work = profiles.save({ name: 'Work', icon: 'briefcase', color: '#7aa2f7', schedule: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', auto: false }, dailyMinutes: 60 });
const sky = profiles.save({ name: 'Night sky', icon: 'sparkle', color: '#9ece6a' });
const outdoors = profiles.save({ name: 'Outdoors', icon: 'map', color: '#e0af68' });
const weekend = profiles.save({ name: 'Weekend', icon: 'coffee', color: '#f7768e', dailyMinutes: 45 });
profiles.sources(work.id, { add: ['priya', 'teodor', 'type', 'people', 'fedi'].map(sourceOf) });
profiles.sources(sky.id, { add: ['nightsky', 'orbit'].map(sourceOf) });
profiles.sources(outdoors.id, { add: ['ranger', 'people'].map(sourceOf) });
profiles.sources(weekend.id, { add: ['workshop', 'signal', 'patch', 'kettle', 'people'].map(sourceOf) });

createAlertIn(store, { name: 'Aurora tonight', keywords: ['aurora', 'Kp 6', 'Kp 7'], sources: [], authors: [], media: null, profile: null, prompt: null } as never);
createAlertIn(store, { name: 'Denali summit', keywords: ['Denali'], sources: [sourceOf('ranger')], authors: [], media: 'image', profile: null, prompt: null } as never);
createRoutineIn(store, { prompt: 'Make a Work brief from the last day of posts', schedule: { kind: 'at', time: '07:30', days: [1, 2, 3, 4, 5] } } as never, profiles.list());

const day = (offset: number) => {
  const d = new Date(now - offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const minutes: [number, string, number][] = [
  [0, work.id, 38], [0, sky.id, 14], [0, 'all', 9],
  [1, work.id, 52], [1, outdoors.id, 18], [1, 'all', 12],
  [2, work.id, 41], [2, weekend.id, 26], [2, sky.id, 22],
  [3, work.id, 66], [3, 'all', 15],
  [4, weekend.id, 48], [4, outdoors.id, 31],
  [5, weekend.id, 35], [5, sky.id, 40],
  [6, work.id, 29], [6, 'all', 20],
];
const log: Record<string, Record<string, number>> = {};
for (const [off, prof, m] of minutes) (log[day(off)] ??= {})[prof] = m * 60;
store.setSetting('time.spent', log);

const total = store.db.prepare('SELECT count(*) AS n FROM items').get() as { n: number };
console.log(`Showcase library written to ${dir}`);
console.log(`  ${SOURCES.length} fictional sources, ${total.n} posts (${added} new), ${Object.keys(ARTICLES).length} full articles, 4 profiles`);
console.log(`Run it:  SOCIAL_READER_DATA=${dir} npm start`);
