<p align="center">
  <img src="docs/media/hero.jpg" alt="Aurora: everything you follow, minus the noise. A private, agentic reader for your social feeds and the web." width="100%">
</p>

<p align="center">
  <b>Your feeds, on your own computer, with the noise set aside by rules you can see.</b><br>
  Aurora pulls the people and sites you follow into one private library, explains every post it shows you,<br>
  and has an AI that reshapes the app when you ask in plain English. It never posts, likes or follows for you.
</p>

<p align="center">
  <a href="#run-it-on-a-mac">Mac</a> ·
  <a href="#run-it-on-linux">Linux</a> ·
  <a href="#run-it-in-docker">Docker</a> ·
  <a href="#the-desktop-app">Desktop app</a> ·
  <a href="#the-phone-app">Phone app</a> ·
  <a href="#a-tour">Tour</a> ·
  <a href="#every-feature">Every feature</a> ·
  <a href="#security-and-privacy">Security</a> ·
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <img alt="Node 22.18 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-7ef0d0?style=flat-square&labelColor=0b0a16">
  <img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/runs%20on-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-a69bff?style=flat-square&labelColor=0b0a16">
  <img alt="Local first" src="https://img.shields.io/badge/data-stays%20on%20your%20computer-ffc56b?style=flat-square&labelColor=0b0a16">
  <img alt="Read only" src="https://img.shields.io/badge/social%20sites-read%20only-ff7a9c?style=flat-square&labelColor=0b0a16">
</p>

---

## Why Aurora

Social apps are built to keep you scrolling. Aurora is built so you can stop.

- **One library, every source.** Blogs, newsletters, YouTube channels, Bluesky, Mastodon, subreddits, your X archive and more land in one SQLite file on your machine.
- **Rules you can see.** Engagement bait, promotions, duplicates and anything you mute are set aside, never silently deleted. Every post says why it is in your feed, and every hidden post says which rule hid it.
- **An agent that works for you.** Ask "add Priya's blog", "make a Work profile" or "hide rage bait" and the AI does it, with a one-click undo for every change. For a site with no feed, it writes a small sandboxed connector on the spot.
- **Read-only toward every site.** Saving, reading, hiding and muting are local. Aurora never likes, follows, posts or unbookmarks anything anywhere.
- **Yours to run.** On your laptop, in Docker on a home server like Jellyfin or Immich, as a desktop app, or from your phone against your own server.

> The screenshots below show the built-in **fictional showcase library** (`npm run showcase`). Every person, account and post in them is invented. Photos are public-domain images from NASA, the US National Park Service and others ([credits](docs/media/CREDITS.md)).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/media/feed-light.jpg">
    <img src="docs/media/feed-dark.jpg" alt="The Aurora feed: a count of posts worth reading, glass post cards with photos, the rules pane and the profile switcher" width="100%">
  </picture>
</p>

---

## Run it on a Mac

You need Node.js 22.18 or newer (24 or newer recommended) and git.

```bash
brew install node git gh
gh auth login                     # once, so you can clone the private repository
gh repo clone Talamander/aurora
cd aurora
npm install
npm run build
npm start
```

Open **<http://127.0.0.1:4317>**. Your library lives in `data/` inside the clone. Stop the server with Ctrl+C.

Want to look around before connecting anything? Load the fictional showcase into a separate folder and point Aurora at it:

```bash
npm run showcase -- ~/aurora-showcase
SOCIAL_READER_DATA=~/aurora-showcase npm start
```

Optional extras on a Mac:

```bash
brew install --cask google-chrome   # for sources you sign in to (Chromium, Brave or Edge also work)
brew install yt-dlp                 # keep a copy of videos from posts you save
brew install choose-gui             # `aurora pick`, a Spotlight-style post picker
```

Everything works on macOS except connectors the AI writes for you: those need a sandbox, and on a Mac Aurora refuses to run them unprotected. Run Aurora in Docker (below) to get them. Details and troubleshooting: [docs/macos.md](docs/macos.md).

## Run it on Linux

```bash
git clone git@github.com:Talamander/aurora.git && cd aurora
npm install && npm run build && npm start      # http://127.0.0.1:4317
```

Install `bubblewrap` to sandbox AI-built connectors. On Omarchy there is a Waybar module, Hyprland bindings and a theme that follows your desktop: [docs/omarchy.md](docs/omarchy.md). An Arch package lives in `packaging/arch/`.

## Run it in Docker

```bash
docker compose up -d --build                   # http://127.0.0.1:4317
```

The container runs AI-built connectors inside bubblewrap, so this is also the way to get them on a Mac (Docker Desktop, OrbStack or Colima). Reverse proxies, backups and remote access: [docs/self-hosting.md](docs/self-hosting.md).

## The desktop app

`desktop/` wraps Aurora in an Electron app with its own private copy of the server, a menu bar or tray icon with your unread count, notifications, start at login and **Quick look**: a small window with your top five posts, alert hits and what is playing, on Option+Space (Ctrl+Alt+Space on Linux and Windows).

```bash
npm install
npm --prefix desktop install
npm --prefix desktop run dist:mac       # or dist:linux (AppImage) or dist:win
open desktop/dist/*.dmg
```

The Mac build is ad-hoc signed, not notarized. The first time, right-click Aurora in Applications and choose **Open**. See [docs/desktop.md](docs/desktop.md) and [docs/macos.md](docs/macos.md#the-desktop-app).

<p align="center">
  <img src="docs/media/quick.jpg" alt="Quick look: a small window with the top five posts and an Ask box" width="380">
</p>

## The phone app

`mobile/` is an Expo (React Native) app for Android and iOS that talks to your own Aurora server. Pair it with the QR code under Phones in Settings; the phone then holds a revocable device token. The web app also installs as a PWA. See [docs/mobile.md](docs/mobile.md).

<table>
  <tr>
    <td><img src="docs/media/phone-feed.jpg" alt="Phone feed, dark"></td>
    <td><img src="docs/media/phone-feed-light.jpg" alt="Phone feed, light"></td>
    <td><img src="docs/media/phone-triage.jpg" alt="Triage on a phone: one big card with Hide, Later, Skip and Keep"></td>
    <td><img src="docs/media/phone-reader.jpg" alt="The reader on a phone"></td>
    <td><img src="docs/media/phone-front.jpg" alt="Front page on a phone"></td>
  </tr>
</table>

---

## A tour

### Every post says why it is here

Press `w` on any post (or click its "lit by" line) for the full explanation: which topics matched, what the noise check found, which source it came from and when. One click turns any of it into a rule: mute the source, keep only this author, mark it as noise. "See why" flips the feed to everything that was set aside, each post labelled with the rule that hid it. Every change can be undone with `z`.

<p align="center"><img src="docs/media/why.jpg" alt="A post with its explanation open: passes every rule, topic Aurora, no noise signals, source and fetch time, with buttons to mark as noise or mute the source" width="100%"></p>

### Columns

Press `c` to tile several views or profiles side by side, each scrolling on its own, like a deck for everything you follow. [docs/columns.md](docs/columns.md)

<p align="center"><img src="docs/media/columns.jpg" alt="Columns: Worth reading, Work, Night sky and Outdoors side by side" width="100%"></p>

### Front page

Today's best posts set like a newspaper: a lead story, In brief, pictures and your people. Picked on your computer from what you read and keep. Nothing on it is written by AI. [docs/front-page.md](docs/front-page.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/media/front-light.jpg">
    <img src="docs/media/front.jpg" alt="The Front Page: a serif masthead, a lead story with an aurora photo and an In brief column" width="100%">
  </picture>
</p>

### A reader that respects long reads

Articles open in a quiet reader with your reading position remembered, highlights in four colours with notes, Read later and a Listen queue that reads your list aloud with your media keys. A numbered thread or a chain of self-replies folds into one card and reads as one article. [docs/listen.md](docs/listen.md) · [docs/threads.md](docs/threads.md)

<table>
  <tr>
    <td width="50%"><img src="docs/media/reader.jpg" alt="The reader showing an article about the aurora with a lead photo"></td>
    <td width="50%"><img src="docs/media/reader-light.jpg" alt="The reader in light mode with a highlighted pull quote"></td>
  </tr>
  <tr>
    <td><img src="docs/media/thread.jpg" alt="A five-post thread read as one article"></td>
    <td><img src="docs/media/highlights.jpg" alt="The Highlights sheet listing quotes and notes across articles"></td>
  </tr>
</table>

### Constellation

Your reading world as a night sky: the people, sources and topics you spend time with, sized by what you read, saved and highlighted. Drag to explore, click a star to open its posts. [docs/constellation.md](docs/constellation.md)

<p align="center"><img src="docs/media/constellation.jpg" alt="Constellation: glowing stars for people, sources and topics on a dark violet sky" width="100%"></p>

### Triage

Clear new posts one big card at a time with `t`: keep, read later, hide or skip with an arrow key or a swipe, with undo. [docs/triage.md](docs/triage.md)

<p align="center"><img src="docs/media/triage.jpg" alt="Triage: one large post card over a warm gradient with Hide, Later, Skip and Keep buttons" width="100%"></p>

### Ambient

Your feed as a slow full-screen display for a second monitor or a TV: drifting photos over their own colours, short posts set big, article title cards and a clock. [docs/ambient.md](docs/ambient.md)

<p align="center"><img src="docs/media/ambient.jpg" alt="Ambient mode: a large clock and a short post set in big type over a soft gradient" width="100%"></p>

### Your week, and time well spent

Every Sunday evening (or when you ask "how was my week?") Aurora plays a short story of your week: what you read, what your rules spared you, your people and your best read. Time well spent shows how long you actively read in each profile, with a gentle daily limit that never blocks. [docs/your-week.md](docs/your-week.md) · [docs/time-well-spent.md](docs/time-well-spent.md)

<p align="center"><img src="docs/media/week.jpg" alt="Your week: a full-screen title card reading Your week, read back to you" width="100%"></p>

### Profiles, alerts, routines and more

Profiles are separate Auroras for Work, Night sky, Weekend or anything you name, each with its own sources, rules, look, hours and daily limit. Alerts watch new posts for you ("tell me when the Kp index hits 7"). Routines run AI jobs on a schedule within a spending cap. Report cards show which sources earn their place. Friends share posts end-to-end encrypted. Bring your follows imports a whole export from YouTube, Instagram, TikTok, Reddit or Mastodon in one move.

<table>
  <tr>
    <td><img src="docs/media/sheet-profiles.jpg" alt="Make a profile: templates, icon, colour and theme"></td>
    <td><img src="docs/media/sheet-alerts.jpg" alt="Alerts: Denali summit and Aurora tonight watches"></td>
    <td><img src="docs/media/sheet-routines.jpg" alt="Routines: every weekday at 7:30, make a Work brief"></td>
    <td><img src="docs/media/sheet-time.jpg" alt="Time well spent: minutes today per profile with limits"></td>
  </tr>
  <tr>
    <td><img src="docs/media/sheet-report.jpg" alt="Source report cards with keep and quieter verdicts and sparklines"></td>
    <td><img src="docs/media/sheet-friends.jpg" alt="Friends: share with the people you actually know"></td>
    <td><img src="docs/media/sheet-follows.jpg" alt="Bring your follows: drop an export file"></td>
    <td><img src="docs/media/profile-sky.jpg" alt="The Night sky profile active, showing only space sources"></td>
  </tr>
</table>

### Search, the palette and the keyboard

Ranked best matches with highlighted snippets across posts, article bodies and highlight notes, in about 50 ms at 100k posts. `Ctrl K` (`Cmd K`) jumps to any view, page, source, person, theme or post. Almost everything has a key; `?` lists them. [docs/search.md](docs/search.md)

<table>
  <tr>
    <td width="33%"><img src="docs/media/search.jpg" alt="Search results with Best matches above the feed"></td>
    <td width="33%"><img src="docs/media/palette.jpg" alt="The command palette"></td>
    <td width="33%"><img src="docs/media/help.jpg" alt="The keyboard shortcuts sheet"></td>
  </tr>
</table>

### Make it yours

The Theme studio builds a theme from a picture, a mood or by hand, keeping dark and light readable on their own. Gruvbox, Tokyo Night, Catppuccin, Kanagawa, Rosé Pine and more are built in, and on Omarchy Aurora can follow your desktop theme.

<table>
  <tr>
    <td width="50%"><img src="docs/media/studio.jpg" alt="The Theme studio with live previews in dark and light"></td>
    <td width="50%"><img src="docs/media/whatsnew.jpg" alt="The What's new sheet listing recent features"></td>
  </tr>
</table>

---

## Every feature

<details open>
<summary><b>Reading</b></summary>

- **Timeline.** One column of whole posts: avatars, full text, image grids, quote and link cards, inline video (YouTube privacy-enhanced, Vimeo, HLS, mp4). Each card glows with a colour taken from its own picture. Posts you scroll past are marked seen but stay put until the filters change.
- **Worth reading.** The default view: unseen posts that pass your rules, with a count and a plain line on how many were set aside.
- **Views.** Worth reading, Saved, Everything, Archive and any saved view of your own, in the sidebar and a floating dock with counts.
- **Reader.** Clean article view with remembered position, highlights in four colours with notes, Original, Done and Archive. Articles are stored as safe structured blocks; no page HTML ever reaches the UI.
- **Read later and Listen.** A Read later list, and a Listen queue that reads it aloud one article after another with the browser's speech engine and your media keys (`P`).
- **Thread reader.** Numbered threads and self-reply chains fold into one card and open as one article.
- **Front page.** Today's best, set like a newspaper, chosen locally.
- **Triage.** One big card at a time: keep, later, hide, skip (`t`), with swipes on a phone.
- **Columns.** Several views or profiles side by side (`c`).
- **Ambient.** Full-screen slow display for a second screen or a TV.
- **Constellation.** Your people, sources and topics as a night sky.
- **On this day.** Posts you saved or highlighted on this date a month or a year ago.
- **Since you were away.** After a few hours away, a card sums up what is new.
- **People.** Click a name for everything that person posted across sources, with Only show, Hide and Save as view.
- **Collections and saves.** Save, collect into named collections, and optionally keep a local copy of the photos and videos of saved posts.
- **Compact mode, light and dark, keyboard everywhere.** `j`/`k` move, `Enter` opens, `s` save, `l` read later, `e` hide, `w` why, `i` more like this, `v` original, `/` search, `f` filters, `h` show what was set aside, `z` undo, `g` sources, `d` compact, `?` help.

</details>

<details open>
<summary><b>Filtering and rules</b></summary>

- **Filters that compose.** Search (`"phrases"`, `-word`, `from:name`, `site:host`), must-mention and mute words, sources, platforms, people, content type, post kind, language, date range, topics, read, saved, archived, collections, noise and duplicates. Every active clause is a removable chip.
- **Noise check.** A rule-based classifier for engagement bait, promotions, hashtag stuffing, bare reposts and very short posts. It says which rule fired, and "Not noise" overrides it per post.
- **One copy of each story.** The same link or text from several sources collapses to the fullest copy.
- **Topics.** Keyword lists you can edit, shown on every matching post.
- **Plain-English AI rules.** "Hide rage bait", "only posts about home labs". A small model labels posts in the background, and each hidden post says which rule hid it.
- **Explanations everywhere.** Each post says why it is here; an empty feed says whether the library is empty or the filters hid everything, and offers to clear the rules that hid the most.
- **Source report cards.** Thirty days of what you read, saved and hid from each source, with a keep, quieter or let go verdict and local actions.

</details>

<details open>
<summary><b>The agent</b></summary>

- **Ask your feed.** The composer (`.`) talks to an AI that can read your library and change the app: add or fix sources, save views, write rules and topics, compose pages, change the theme. Every change lands in a change log with one-click undo.
- **Bring your own model.** A Claude login or API key, any OpenAI-compatible endpoint, or a free local model (Ollama, LM Studio, llama.cpp) for small jobs. A Spend tab shows cost by day, job and model, with monthly caps for background work.
- **AI-built connectors.** For a site with no feed, a builder agent writes an actor: a small script that runs in a bubblewrap sandbox behind an egress proxy, using free public endpoints first and a headless browser only as a last resort. The Workshop shows each actor, its runs and its code, and actors can be exported and shared.
- **Signed-in sites.** When a source needs an account, Aurora opens its own private browser profile and you sign in yourself. Your everyday browser and its cookies are never read.
- **Morning edition.** A daily page of sections that cite the posts behind them.
- **Routines.** "Every weekday at 7:30, make a Work brief": scheduled AI jobs with a per-run and monthly spending limit and a log of every run.
- **Alerts.** "Tell me when…" watches with keywords, people, sources or a fuzzy AI condition, quiet hours, toasts, desktop notifications and a Waybar count.
- **Your week.** A Wrapped-style weekly story with a short paragraph in your voice.
- **Taste suggestions.** Proposed rules and views based on what you save, open and hide. One click adds one; "Not for me" dismisses it for good.
- **Pages and widgets.** The AI composes pages from blocks (feeds, galleries, people, stats, digests, notes) and can write small HTML widgets that run in a locked-down iframe.

</details>

<details open>
<summary><b>You and your people</b></summary>

- **Profiles.** Work, Gaming, Family or anything: each with its own sources, views, rules, theme, AI instructions, hours ("weekdays 9 to 5", with an optional automatic switch) and a soft daily limit.
- **Time well spent.** Active reading time per profile, today and this week, kept as daily totals on your computer.
- **Friends.** Share a post with a note to people you know, end-to-end encrypted through a relay that only sees sealed envelopes. Friendship is mutual, with no followers, counts or public profiles. Posts from signed-in sources are never shared.
- **Bring your follows.** Drop your YouTube (Takeout), Instagram, TikTok, Mastodon, Reddit, Substack or OPML export, or type a Bluesky handle, and follow everyone in Aurora in one move. Nothing is followed on the sites themselves.
- **Share to follow.** On a phone with the app installed, share a link to Aurora and the agent offers to follow it.

</details>

<details open>
<summary><b>Everywhere</b></summary>

- **Web app and PWA** at `http://127.0.0.1:4317`, from 390 px phones to ultrawide monitors.
- **Desktop app** for macOS, Linux and Windows with tray, notifications and Quick look.
- **Phone app** (Expo) for Android and iOS against your own server.
- **Terminal.** `npm run tui` is a keyboard-driven terminal client. `aurora pick` offers posts in Walker, fuzzel, wofi, rofi, `choose` or fzf. `aurora open front` (or `ambient`, `constellation`) jumps straight to a view. [docs/terminal.md](docs/terminal.md)
- **Feeds out.** RSS and JSON feeds of any view or page.
- **MCP server.** `claude mcp add social-reader -- node server/mcp.ts` lets other AI tools search your library read-only. [docs/mcp.md](docs/mcp.md)
- **Omarchy.** Waybar module, Hyprland bindings, desktop theme matching and an Arch package. [docs/omarchy.md](docs/omarchy.md)
- **Owner lock.** Passkey sign-in (with a recovery code) when Aurora is reachable from other machines.

</details>

## Sources

| Source | How | Status |
|---|---|---|
| RSS and Atom | Feed URL, or any page that links its feed | Works. Covers blogs, newsletters, podcasts, Mastodon (`@user.rss`), Bluesky (`/rss`), subreddits (`.rss`) and YouTube channels |
| Bluesky profile | Public API, no login | Works |
| X archive | Import `tweets.js`, `like.js`, `bookmark.js` from your X data download | Works |
| X export | twitter-web-exporter JSON or CSV | Works |
| JSON, browser bookmarks, OPML | Import | Works |
| X bookmarks, live | Official API v2, OAuth 2.0 PKCE, read-only scopes, your own developer app | Built; needs your own X app and paid API credits |
| Sites with no feed | An AI-built, sandboxed connector | Works on Linux and in Docker |
| Mastodon home timeline, Reddit API, Threads, Instagram, LinkedIn | | Not available; the app says why |

Connectors implement a versioned interface (`server/connectors/types.ts`). Every item records the connector and version that produced it. Research notes: [docs/CONNECTORS_RESEARCH.md](docs/CONNECTORS_RESEARCH.md).

## Security and privacy

- **Local by default.** The server binds to `127.0.0.1`. Anything else is refused unless you set `ALLOW_NON_LOCAL=1`, and then other machines must sign in with the owner lock.
- **Read-only toward every site.** The agent's tools cannot post, like, follow or unbookmark anywhere.
- **Your browser stays yours.** No browser cookies or passwords are ever read. Signed-in sources use Aurora's own browser profile, and you sign in yourself.
- **Untrusted content stays data.** Imported posts and fetched pages are wrapped and labelled as untrusted in every AI prompt. HTML becomes plain text on ingest, and links are shown only when they are `http(s)`.
- **Safe fetching.** Server-side fetches refuse private, loopback and link-local addresses at connect time and on every redirect, with timeouts and size caps. Images load through a local proxy that only fetches URLs already in your library.
- **Sandboxed AI code.** AI-built connectors run in bubblewrap with no access to your files and network only through an egress proxy. Where no sandbox exists (macOS, Windows), they do not run. AI widgets render in a sandboxed iframe with no network.
- **Hardened web app.** Host and Origin checks on every request, JSON-only writes, a strict Content-Security-Policy, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and capped request bodies.
- **Secrets stay put.** OAuth tokens and AI keys live in the SQLite `secrets` table (file mode 0600), are never sent to the browser and never logged.
- **No evasion.** No CAPTCHA solving, bot-detection evasion or fingerprint rotation.

More: [docs/security.md](docs/security.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback is refused unless `ALLOW_NON_LOCAL=1`. |
| `SOCIAL_READER_DATA` | `./data` | Folder for the SQLite library |
| `AUTO_SYNC_MINUTES` | `30` | Background sync interval for free feeds; `0` turns it off. Paid sources (X) only sync by hand. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | unset | Optional AI provider fallback. A key in AI settings wins; a local Claude Code login or a local OpenAI-compatible model also works. |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REDIRECT_URI` | unset | Your own X developer app, for live X bookmarks |
| `SR_ACTOR_ISOLATION` | `auto` | Sandbox for AI-built connectors. Linux uses bubblewrap; macOS and Windows refuse to run them. `none` runs them unsandboxed (not recommended). |
| `CHROMIUM_PATH` | auto-detected | Browser for signed-in sources (Chrome, Chromium, Brave or Edge) |
| `YT_DLP` | auto-detected | Used to keep videos of saved posts |
| `SR_ALLOWED_HOSTS` | unset | Extra `Host` headers to accept, for a reverse proxy |
| `SR_PUBLIC_URL` | unset | Addresses phones should use to reach this server, shown first in the pairing QR code |
| `SR_TRUST_NETWORK` | unset | Let unauthenticated requests from other machines in when bound to a non-loopback address (the Docker image sets it) |
| `SR_TRUST_PROXY` | unset | Trust `X-Forwarded-*` behind a TLS-terminating proxy you control |
| `SR_CLOUD` | unset | Hosted mode: no signed-in browser tier, owner lock always on |
| `SR_RESET_LOCK` | unset | Start once with `1` to clear the owner lock |
| `SR_DEBUG` | unset | Verbose agent logging |

## Development

```bash
npm run dev          # API in watch mode on 127.0.0.1:4317 + Vite on http://127.0.0.1:5173
npm test             # node:test suites, including a real server restart
npm run typecheck
npm run showcase -- /tmp/aurora-showcase    # fictional library for trying things safely
npm run smoke -- http://127.0.0.1:4400      # browser click-through; changes state, use a scratch library
npm run a11y -- http://127.0.0.1:4400       # axe accessibility sweep
```

```
core/          Pure TypeScript shared by the server, the web app and the phone app:
               types, normalize, classify, filter, profiles, threads, front page, constellation
server/        node:http API and static server, node:sqlite store, ingest, safe fetching,
               connectors, image proxy, alerts, routines, profiles, friends, MCP server
server/agent   Agent runtime (Claude Agent SDK or OpenAI-compatible), tools, change log,
               builder, AI rules, edition, catch-up
server/actors  AI-built connectors: sandbox, egress proxy, runner, browser service
web/           Vite + React app
mobile/        Expo phone app
desktop/       Electron app
cli/           Terminal client and `aurora` command
tests/         node:test suites and fixtures
```

Filtering runs in the browser over the whole library, so every keystroke re-evaluates every post with explanations: about 10 to 15 ms for 5,000 posts once warm. See [docs/performance.md](docs/performance.md).

## Docs

| Getting started | Features | Under the hood |
|---|---|---|
| [macOS](docs/macos.md) | [Profiles](docs/profiles.md) | [Security](docs/security.md) |
| [Self-hosting and Docker](docs/self-hosting.md) | [Columns](docs/columns.md) | [Performance](docs/performance.md) |
| [Desktop app](docs/desktop.md) | [Front page](docs/front-page.md) | [AI models and spend](docs/ai-models.md) |
| [Phone app](docs/mobile.md) | [Triage](docs/triage.md) | [MCP server](docs/mcp.md) |
| [Terminal](docs/terminal.md) | [Thread reader](docs/threads.md) | [Connector research](docs/CONNECTORS_RESEARCH.md) |
| [Omarchy](docs/omarchy.md) | [Constellation](docs/constellation.md) | [Accessibility](docs/accessibility.md) |
| [Bring your follows](docs/follows-import.md) | [Ambient](docs/ambient.md) | |
| | [Your week](docs/your-week.md) | |
| | [Time well spent](docs/time-well-spent.md) | |
| | [Report cards](docs/report-cards.md) | |
| | [Alerts](docs/alerts.md) · [Routines](docs/routines.md) | |
| | [Search](docs/search.md) · [Listen](docs/listen.md) | |
| | [Friends](docs/social.md) | |

## Credits

Screenshots use the fictional showcase library. The photographs in them are public-domain and CC0 images from Wikimedia Commons, including NASA imagery from the International Space Station, Juno, Cassini and Apollo 8, and US National Park Service photos of the Grand Canyon, Denali and Redwood National Parks. Full list: [docs/media/CREDITS.md](docs/media/CREDITS.md).
