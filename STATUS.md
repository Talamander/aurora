# Status (Aurora, formerly Social Reader)

## Night two (2026-10-13, 00:00 to 08:00 CDT)

Tal asked for, overnight: a phone app, real social features between Aurora users "thoughtfully
done", long-form reading, user-defined profiles, UI polish, a desktop app for Linux, macOS and
Windows, and for the whole thing to be fast, secure and good-looking. iOS went on the roadmap.
Work ran in parallel worktrees and was merged into `main` one branch at a time, with typecheck,
tests and build after each merge.

### Shipped (all committed on main)

- **Profiles** (`core/profiles.ts`). User-defined contexts such as Work, Gaming
  or Family: a lens over the shared sources with their own views, pages, AI rules, theme, accent
  and AI instructions. The agent can create and fill them ("make me a Gaming profile with my
  Twitch and r/pcgaming").
- **Friends** (`docs/social.md`). End-to-end encrypted sharing between Aurora instances, mutual
  friendship only, no public profiles, no counts, no resharing. Share a post with a note to
  friends or a circle, react, reply privately. Later the same night: an opt-in weekly list of
  saved posts per friend (previewed before the first send), shared read-only collections,
  connector suggestions (arrive as untested imports) and circles mapped to profiles. Everything
  received is untrusted plain text. Nothing is ever posted to a source platform.
- **Long-form reading.** A reader with Literata, reading position, highlights, Read later with
  progress, Listen, article extraction (Readability, SSRF-checked fetch), EPUB and other imports,
  and agent tools to read articles and cite highlights.
- **Desktop app** (`desktop/`, `docs/desktop.md`). Electron shell for Linux, macOS and Windows with
  a tray, a global shortcut and a CI workflow for installers. Only the Linux build was run here.
- **Phone app** (`mobile/`, `docs/mobile.md`). Expo, Android first, paired by QR with a Bearer
  token limited to an allowlist of read routes. Profile switcher, article reader, Read later,
  friend shares with replies, images through the proxy, Aurora icon and splash. iOS is on the
  roadmap (PLAN.md phase 9). No APK was built and no real device was used.
  Later the same night: the phone syncs the library in the same hashed weekly chunks as the web
  app (an unchanged library costs one 304), keeps the library, opened articles and up to 25 Read
  later articles for offline reading, queues save, set aside, read and Read later while offline
  and sends them in order once the computer answers, has a Search screen with More like this, and
  an Android share target ("Send to Aurora" fills the Ask box; nothing is sent until you press
  Send). The share target needs an `expo prebuild` or EAS build, not Expo Go.
  Later still: On this day on Today, a read-only Routines list (only `GET /api/routines` was added
  to the device allowlist, with tests), Report cards computed on the phone from the saved library,
  Listen to Read later back to back (expo-speech, no lock-screen controls), and profile hours shown
  in the profile switcher (hours switch the computer, not the phone).
- **Terminal client** (`cli/`, `docs/terminal.md`). `npm run tui` or `aurora`: a keyboard TUI with
  all third-party text sanitized, plus `aurora status` (plain, `--json`, `--waybar`).
- **Omarchy integration** (`integrations/omarchy/`, `docs/omarchy.md`). systemd user unit,
  launchers, Waybar module, Hyprland bindings (copy them yourself; nothing was installed), and a
  live **Desktop** theme that follows `omarchy-theme-set`.
- **Security** (`docs/security.md`). Local image proxy (remote hosts never see your views),
  stricter request guards, secrets encrypted at rest with `data/secret.key`, and the **owner lock**:
  passkeys verified with `node:crypto`, a one-time recovery code, cookie sessions, a setup token
  for cloud first claim, rate limits. Always on with `SR_CLOUD=1` or off-loopback binds; optional
  on localhost (Settings, Lock).
- **Fast** (`docs/performance.md`, `npm run perf`). At 100k synthetic posts: first post visible
  in 448 ms (was 3,830), library repeat fetch 18 ms (was 1,367), server memory about 450 MB (was
  about 980). The web app syncs the library in weekly, content-hashed chunks; `/api/library` is
  unchanged for the phone, TUI and MCP, and is revalidated with an ETag.
- **Fast, re-checked after everything landed** (`docs/performance.md`, "After night two"). Cold
  start: the longest server stall in the first 15 s went from 1,083 ms to 139 ms, and first post
  from 2,365 ms to 1,231 ms (static compression on the thread pool, the post read and index work in
  slices). Scrolling at 100k posts no longer stalls 200 to 600 ms when a read batch holds a
  duplicate (0 to 60 ms now). Entry JS 541 kB to 429 kB before Routines and Columns landed (451 kB
  now): Your week, Ambient, Follows, Alerts, Routines, Sources and the QR encoder load on first
  use. New scripts: `scripts/perf-startup.ts`, `scripts/perf-server.ts`, `scripts/bundle-report.ts`.
- **Alerts** (`docs/alerts.md`). Plain-English watches ("tell me when MKBHD posts a phone
  review") checked after each sync: cheap matching first, the AI only for the fuzzy part, capped
  per hour. Hits show as a toast, a browser or desktop notification, a Waybar badge and a phone
  list, with quiet hours. Nothing leaves the computer.
- **Your week** (`docs/your-week.md`). A Wrapped-style full-screen story per profile: numbers,
  what rules hid, top people, the topic that grew, the best read, an AI paragraph with citations
  and a share card (PNG, or to a friend only on click with a preview). Frozen on Sunday evenings.
- **Ambient** (`docs/ambient.md`). A lean-back full-screen display of the feed for a second
  monitor or TV: photos with slow Ken Burns over their own colours, big type for text posts,
  keyboard controls, `?ambient=1` links and a desktop tray item.
- **Bring your follows** (`docs/follows-import.md`). Drop data exports from YouTube, Instagram,
  TikTok, Mastodon, Reddit, Substack, X or OPML, or type a Bluesky handle; review by platform,
  choose a profile per platform, and Aurora adds open feeds at once and reuses one connector per
  platform for the rest, with at most one AI build per platform. Files are parsed in the browser.
- **Search** (`docs/search.md`). SQLite FTS5 index in `data/search.db` (a rebuildable cache):
  ranked "Best matches" with highlighted snippets above the feed, in the palette and for the
  agent's `search_posts`; "More like this" on every post. 34 to 51 ms per search at 100k posts.
- **Accessibility** (`docs/accessibility.md`, `npm run a11y -- URL`). An axe-core sweep over every
  main surface in several themes, dark and light, desktop and phone: from 8 critical and 1,459
  serious failing nodes to none. Skip link, real focus for `j`/`k`, dialog focus that returns to
  its opener, a fuller `?` sheet, announced agent replies, contrast fixes in every preset. No real
  screen reader was used.
- **Local models, per-job routing and spend** (`docs/ai-models.md`). AI settings finds Ollama,
  LM Studio or llama.cpp on this computer (one loopback probe each, never the network) and lets
  each job (chat, connector builds, AI rules, alerts, Your week, summaries, briefs) use its own
  model. Every call is recorded in `data/spend.db`; the Spend tab shows day, week, month, by job
  and by model, with optional monthly caps that pause background AI work only. Automatic
  connector repairs now stop after two that did not help, until a good run.
- **Theme studio.** Make a theme from a picture (read on this device, never uploaded), from a mood
  sentence through the agent, or by hand (hue, warmth, contrast, glass, corners, density, heading
  font). Dark and light come from the same settings and are contrast-checked to WCAG AA, with
  automatic nudges it explains. Save, apply per profile, export or import `.aurora-theme.json`.
- **Caught up and motion.** A calm "You're caught up" card at the end of the feed with time saved
  and gentle next steps, small beats on save/hide/read later, view transitions, skeleton cards
  while loading, and pull-to-refresh on phones.
- **Polish.** A first-run welcome under a slow aurora with example chips, tactile buttons, a
  compact rail, a lock screen in the same language.
  A second pass late in the night, across every surface at 1440 and 390 in four presets: calm
  disabled buttons instead of muddy ones, one focus ring per input instead of two, an Alerts card
  that lights up as a whole, the Columns add form fitting at 1440, the phone Views footer as a grid,
  an amber (not error-pink) focus on the lock screen, and rail tools that wrap to two rows.
- **Security review of the night's work** (`docs/security.md`, "Night two review",
  `tests/security-night-two.test.ts`). One high fix: with the owner lock on and no feed token set,
  RSS/JSON feeds were readable without signing in; now a feed skips the lock only with a real feed
  token, so feed readers need one when the lock is on. One medium fix: the sign-in rate limit used
  the client-written end of X-Forwarded-For behind a proxy. Eight low fixes (X sign-in callback
  under the lock, sign-out clears cached chunks, stricter untrusted wrapping in long-form and Your
  week, follows import keeps display names out of AI prompts, theme tokens reject CSS escapes and
  image functions, Linux notification bodies escaped). Open items are listed in the doc.
- **Friends security review** (`docs/security.md`, "Friends review",
  `tests/security-friends.test.ts`). Four medium fixes: the relay's rate limit used the
  client-written end of X-Forwarded-For; one address could fill the relay's storage (now a
  per-address daily quota, `SR_RELAY_IP_MB_PER_DAY`, default 32 MB); automatic weekly lists could
  include saved posts from signed-in sources such as friends-only Facebook posts (now always left
  out; such posts can still be shared one at a time); connectors suggested by a friend reached the
  builder agent unwrapped. Five low fixes: atomic invite claims, renames that impersonate another
  friend are ignored, removing a friend empties what was queued for them, weekly-list scope follows
  a friend's circle, and a warning on suggested connectors that use a signed-in browser profile.
- **Routines** (`docs/routines.md`). Plain-English scheduled agent jobs: "every weekday at 7:30,
  make a Work brief", "Sunday night, queue the three best long reads I saved". Daily, weekdays,
  named days, every N hours or after each sync, in local time. A new routine is saved off; you
  preview a cheap dry-run plan, then press Turn on (the agent can create routines and turn them
  off, never on). Runs use a read-and-organise subset of the agent's tools (no sources, sign-ins or
  themes), write a summary with cited posts and usually a page, and keep a history with cost. Each
  routine has a per-run limit (default $0.50, enforced on Claude; other providers get 24 turns and
  10 minutes) and a monthly limit (default $5) that pauses it with the usual banner. Opens from
  the rail, the palette or What's new. Not yet run against a real model.
- **Profile hours and On this day** (`docs/profiles.md`). A profile can switch on by itself at set
  times (Work on weekdays 09:00 to 17:00) with an Undo toast, and back afterwards; Aurora acts only
  at the start and end of the hours, so switching by hand always wins. Off unless you turn on
  "Switch by itself"; only while the web or desktop app is open. On this day: a quiet card with up
  to three posts you saved or highlighted on this date in earlier months or years, only on days
  that have some, with Hide for today and an off switch; the palette lists them all. Local, no AI.
- **Listen queue** (`docs/listen.md`). Read later read aloud back to back like a podcast, from the
  palette, the Read later sheet, `Shift P` on a post or the reader's headphones button; the morning
  edition can be queued too. A mini player above the dock (paragraph progress, speed, voice, queue
  order) and `p` to play or pause. Keyboard media keys drive it through the Media Session API (a
  silent looping sound keeps Chromium's MPRIS player alive while speaking). Finished articles are
  marked read and positions are shared with the reader. MPRIS on a real desktop was not tested.
- **Arch package** (`packaging/arch/`, "Install on Arch / Omarchy" in `docs/omarchy.md`). A
  PKGBUILD for `aurora-reader`: app in `/usr/lib/aurora`, `aurora` and `aurora-server` commands, a
  systemd user unit bound to 127.0.0.1 with data in `~/.local/share/aurora`, desktop files and
  icons. Built here with `makepkg -f --nodeps` into a scratch folder and the packaged server was
  started and answered; nothing was installed and nothing was published. An AUR release needs a
  public URL, a tag and a license (placeholder `LicenseRef-unlicensed` for now).
- **Source report cards** (`docs/report-cards.md`). A Report card tab in Sources (and the palette)
  showing, per source over 30 days, posts a day against what you read, saved, highlighted and hid,
  what your rules hid, and a plain keep / quieter / let go verdict with the reason. Actions are all
  local: pause syncing, mute or remove from a profile, move to a profile, open in Columns. The
  agent has a read-only `source_report` tool for "which sources should I drop?". No AI involved.
- **Quick look** (`docs/desktop.md`, "Quick look"). A small Spotlight-style window in the desktop
  app: the top five posts worth reading, alert hits, what Listen is playing and an Ask box that
  hands the question to the main window (Quick look itself makes no AI call). `Ctrl+Alt+Space` by
  default, `aurora --quick` or `aurora://quick` for a Hyprland binding (commented line in
  `integrations/omarchy/bindings.lua`), the tray, or the palette; in a browser it is a small popup
  at `/?quick=1`. Electron's global shortcut may not fire under Wayland, so bind it in Hyprland; not
  tested on a live display.
- **Columns** (`docs/columns.md`). A tiled, Hyprland-style deck: several columns side by side,
  each one profile plus a view, topic, source, collection, search or Read later. Press `c` (or the
  rail, palette or What's new). Add with `n`, close with `q`, reorder by drag or `[` `]`, make one
  wide; arrows or `Shift+H`/`Shift+L` move between columns, `j`/`k` inside one, and the usual post
  keys work on the focused post. The layout is saved in `ui.columns`, so desktop and web share it.
  Phone widths keep the single feed.
- **`aurora pick`** (`docs/omarchy.md`). Choose a post in Walker (or fuzzel, wofi, rofi, fzf),
  open it in the browser, and mark it read in Aurora. A `SUPER + ALT + P` binding to copy. At the very end of the night: `aurora open front|ambient|constellation` and two commented Omarchy bindings (`SUPER + ALT + F` Front page, `SUPER + ALT + M` Ambient).
- **Thread reader** (`docs/threads.md`). One author's self-reply chains and numbered "1/", "2/7" or 🧵 threads fold into one "Thread · N" card that opens in the Reader as one article (pictures inline, a link to each post); read, save and archive apply locally to every post; never merges across authors; off switch in More settings; the phone app folds them too.
- **Constellation** (`docs/constellation.md`). A full-screen, local-only night sky of the people, sources and topics you read, sized by 90 days of reading, saving and highlighting, with keyboard travel, a hover card, and click to open a person or filter the feed; from the palette, the rail, What's new or `?constellation=1`.
- **What's new.** A sheet that opens once on a library that already has posts and walks through
  everything above, each entry with a button that opens the feature. Any time later: the command
  palette, "What's new".
- **macOS** (`docs/macos.md`). Runs from a fresh clone on Node 22.18+ (startup check with a plain message; `npm test` uses a glob old Node understands), finds Chrome, Chromium, Brave or Edge in `/Applications`, opens sign-in windows without `DISPLAY`, `aurora pick` uses `choose`, and `dist:mac` packages `Aurora.app` with the arm64 Node; AI-built connectors refuse to run without a sandbox on macOS and Windows (Docker is the way) instead of silently running unsandboxed.
- **Triage** (`docs/triage.md`). Clear new posts one big card at a time: keep, read later, hide or
  skip with an arrow key or a swipe, `z` to undo, all local. Press `t`; also on the phone.
- **Time well spent** (`docs/time-well-spent.md`). Active reading time per profile per day (window in front, touched in the last minute), kept as daily totals only; a Today ring by the profile switcher, a sheet with today and the week, a 7-day strip and an optional soft daily limit in the profile sheet, and a calm card where the feed ends once the limit is reached (switch profile, five more minutes, keep going; never blocks); Your week adds time by profile and the phone's profile sheet shows today's minutes.
- **Front page** (`docs/front-page.md`). Today's best posts for the active profile set like a newspaper (masthead with date and profile, lead story, secondary row, In brief, pictures, From your people), ranked locally with no AI by recency, unread, articles, pictures and how often you save from each source, after the feed's filters and dedupe; reader font, theme colours, 3 columns down to 1 on phones; from the palette, What's new or `?front=1`.
- **Tiled windows.** Walked every surface at Hyprland half and third widths (960, 720, 640, 480 px; 1400 and 700 tall) and a 1440x500 strip, dark and light: the lens dock now gives up spare width and scrolls the active view into sight, Ambient text sizes by the shorter side so it clears the clock in a short tile, and Triage stops stretching one post into a 1200px card in a tall narrow tile; smoke adds 960x1400 and 720x1400 runs and `npm run a11y` takes `--desktop WxH --phone WxH`.

### Verified

- `npm run smoke -- URL` (`scripts/smoke.mjs`) walks every surface against a scratch server in dark
  and light at 1440 and 390 and fails on page or console errors, failed requests, stuck focus and
  overlapping fixed layers. Its first run found six integration bugs from the night's merges (keys
  leaking through the profile and More like this sheets, Escape not closing the profile sheet,
  toasts under the dock and player, the CSP blocking Listen's silent audio, focus lost after
  Ambient, no palette entry for Alerts), all fixed. It changes server state, so never point it at
  real data. The full walk on the final merged code passes: 68 step runs, 0 failing (after teaching it
  that What's new's Quick look button opens a popup window).

- After the last merge: `npx tsc --noEmit -p tsconfig.json` clean, `npm test` 219 passing,
  `npm run build` clean.
- Each feature was exercised against scratch servers on copies of the preview database, with
  Playwright screenshots and no page errors. Tal's real data folder was not used by any test
  server.

### Needs Tal

- **AI spend tonight: about $0.27.** About $0.10 came from automatic connector repairs early in the
  night. About $0.17 came from the tiled-window sweep at 07:00: a palette search fell through to Ask
  on a scratch copy and made two Claude chat calls. The sweep script now blocks AI requests.
- **Smoke after the last two merges:** the Columns step failed at 960x1400 on reused scratch data
  because an interrupted run had left Columns on; it passes on a fresh copy, and the step now turns
  a leftover Columns off first. The Linux AppImage and .deb in `desktop/dist/` were rebuilt at 07:50 on the final code.

- **Back up `data/secret.key` with the database.** Secrets in the database are encrypted with it;
  without it they cannot be read. The owner lock also writes `data/local.key` (for the terminal
  client) when the lock is on.
- **Phone:** build the APK (`docs/mobile.md`) and pair a real phone. Plain HTTP on a LAN can be
  read by others on that network; use a tunnel or Tailscale away from home.
- **Desktop:** macOS and Windows installers and the tray/global shortcut were not run.
- **Friends** needs a relay both people can reach; the relay is opt-in and sees only sealed
  envelopes.

### Known limits

- A routine that works in a profile sets the server's active profile for the length of the run and
  restores it afterwards. The web app keeps its own profile, but the Waybar count and a chat sent
  during the run can see the routine's profile meanwhile.

- Test servers started on copies of the preview database ran the app's automatic repair of the
  failing "Facebook · Home feed" connector, a few times over the night (about $0.10 each through
  the Claude Code login, estimated). The new back-off limits this to two attempts per breakage.

- A paired phone can send messages to the agent, and the agent can make changes the phone's own
  routes may not.
- Topics are shared across profiles; the TUI profile switch is local to the TUI.
- For about 2 s after a cold start, features that scan every post see only the newest ~2,500.
- An open event stream survives sign-out until the browser reconnects.

---

## Agentic build (overnight, 2026-10-12 into 2026-10-13)

Tal authorized a long autonomous run to turn the reader into a private, agentic social app:
self-hosted or cloud, AI-built connectors instead of fixed integrations, and an AI that "forges
ahead" when asked. This section supersedes older notes below where they conflict (for example,
Threads, Instagram, TikTok and LinkedIn are now followed through AI-built connectors).

### Shipped (all committed)

- **Agent runtime and panel.** Ask the feed in plain English; the AI reads the library and
  changes the app (sources, views, rules, topics, pages, themes) with an undo per change.
  Provider is either a Claude login or key, or any OpenAI-compatible endpoint including a local
  model.
- **AI-built connectors (actors).** A builder agent writes a small script per site, runs it in a
  bubblewrap sandbox behind an egress proxy, tests it (including a second run with saved state)
  and installs it only after a passing test. Self-repair starts after two failed runs.
  Verified with 24 real builds: Threads, TikTok, Facebook page (browser tier), X (via FxTwitter,
  a third-party service, disclosed in the connector), Substack, Ghost, Telegram, Mastodon on any
  server, Bluesky, LinkedIn company, YouTube, Twitch, Pinterest, SoundCloud, Instagram, plus Luma
  events, GitHub activity and python.org events. Facebook groups and the X home timeline were
  correctly refused (login needed). Builds took 1 to 3 minutes and $0.09 to $0.74 each.
- **Workshop.** Every connector with its code, versions, rollback, runs, coverage line, and
  Export/Import as a `.actor.json` file (imports are validated and must be tested again).
- **Signed-in tier.** The app's own Chromium profile, streamed into a sheet; you sign in yourself.
  No cookies are read from your everyday browser. Refused when `SR_CLOUD=1`.
- **Pages and widgets, themes.** AI-composed pages from blocks; sandboxed HTML widgets that follow
  the theme; Look & themes with Aurora, Gruvbox and others.
- **Plain-English AI rules** with background labelling, reasons on every hidden post, and
  progress in the Rules pane.
- **Morning edition** (daily at a set hour) and a **since-you-were-away card** with a cited brief.
- **Person pages** across sources, with a one-line AI summary, activity strip and filter actions.
- **Taste suggestions:** rules and views proposed from what you save, open and hide.
- **Inline video** (YouTube privacy mode, Vimeo, HLS, mp4).
- **Command palette** (Ctrl/Cmd K): views, pages, sources, people, topics, rules, themes, actions
  and posts, falling back to "Ask your feed".
- **Share to follow:** the installed PWA accepts shared links (and `?follow=<url>`) and prefills
  "Follow this: <url>" for the agent; nothing is sent until you press send.
- **Listen:** the morning edition and digest blocks can be read aloud (speechSynthesis), with a
  bar showing the section being read. Real speaker playback was not tested (headless browser).
- **Your feed elsewhere:** RSS/JSON feeds of views and pages, an MCP server for other AI tools.
- **Keep saved posts:** optional local copies of photos and videos (yt-dlp for video).
- **Self-hosting:** Dockerfile, compose file, install script, docs/self-hosting.md. The image
  builds and runs under Podman, sandbox included.

### Verified

- `npm run typecheck` clean, `npm run build` clean, `npm test` 48 passing after every commit.
- Each feature was exercised against a scratch server with Playwright screenshots (no console
  errors), not against Tal's library. Real network builds for the connectors above.

### Preview

Restarted at 23:45 CDT on the new build: <http://127.0.0.1:4317>. Before the restart the preview
database was copied with `VACUUM INTO` to `data/social-reader.backup-2026-10-12-2345.db` (36 demo
posts, 1 source). The AI is ready through the Claude Code login on this computer. Ctrl/Cmd K
changed meaning: it opens the command palette now; the agent stays on `.`.

### Needs Tal

- **X through FxTwitter.** The X connector uses a free third-party service. Keep it, or remove the
  connector if you would rather not depend on it.
- **AI provider.** Set it in AI settings (Claude login or key, or a local OpenAI-compatible model)
  on the preview at 4317 if it is not already set.
- **Signed-in sites** (Facebook groups, X home timeline and similar) need you to sign in once from
  AI settings, Signed-in sites. The session path is wired end to end but has not been run with a
  real login.

### Not verified

- The signed-in tier running an actor with a real logged-in profile.
- Cloud mode as an actual hosted deployment (only the `SR_CLOUD` guard was tested).
- Long-running behaviour: the daily edition firing on its own, classifier passes over days.

---

## Earlier build log

Two-hour autonomous build authorized for 2026-10-12, 19:41 to 21:41 CDT.

| When (CDT) | What |
|---|---|
| 19:41 | Start |
| 20:31 | First handoff written (it wrongly said the session was over) |
| 20:43 | Supervisor check: keep verifying and refining until 21:41 |
| 20:44 | This file corrected to say the session was still running |
| 21:06 | Final handoff of the build |
| 21:13 | Tal: "i dont love the design". Restyled to their pick, crisp modern sans (see `design/DIRECTION.md`, Revision 2). Screenshots in `design/shots/r5`. |
| 21:20 | Tal: the problem was the email-like reader layout. Rebuilt the main screen as a social timeline (one column of whole posts, articles expand in place, rules pane beside it), keeping the Revision 2 look (`design/DIRECTION.md`, Revision 3). Screenshots in `design/shots/r6`. |
| 21:34 | Timeline verified in the browser (below); tests, typecheck and build rerun. |
| 21:43 | Tal: the timeline structure is right but it does not feel like "the future". Started a design-only exploration of three visual directions on the same timeline (`design/explore-r7/index.html`, shots in `design/explore-r7/shots`: Aurora, Forecast, Deck). Not wired into the app and not chosen; stopped here at the end of the authorized window. |
| 22:06 | After the window, Tal picked Aurora from the exploration and asked for it to be built (dark and light). The app now uses it (`design/DIRECTION.md`, Revision 4): glass post cards lit by a blur of each post's own image, a hero count, a floating lens dock of views with live counts, a "lit by" line replacing the Why button, glowing switches and a "New in this feed from" avatar row. Screenshots in `design/shots/r7`. Verified below. |

The preview runs at <http://127.0.0.1:4317> (`npm install && npm run build && npm start`).
Nothing of Tal's is connected yet. At 21:10 the optional demo library (36 fictional posts,
labelled "Demo library (fictional)") was loaded into the preview from the app; this session has
no record of loading it, so it was probably Tal trying the app. It was left as is; remove it in
Sources if unwanted.

Below, "verified" means exercised during this session by an automated test or by hand against a
running server. Anything not exercised is listed under "Not verified" or "Needs Tal".

## Verified

- **Tests.** `npm test`: 48 passing (connectors, filters, store, server persistence, request
  guards, OPML, exports). `npm run typecheck` clean. `npm run build` clean. All three last run at 22:05, after the Aurora restyle.
- **End-to-end through the UI, 20:49 to 21:03** (Playwright driving Chromium against a scratch
  server with an empty data directory, not Tal's library):
  - First run shows "Nothing imported yet".
  - Added `https://simonwillison.net/` as a feed: the feed was discovered from the page and
    30 real posts arrived.
  - Added Bluesky `bsky.app`: 98 real posts.
  - Adding `http://127.0.0.1:4321/api/library` as a feed was refused in the form with "Blocked
    private address 127.0.0.1".
  - Imported `tweets.js`, a twitter-web-exporter JSON and `bookmarks.html` fixtures: 3, 2 and 2
    posts, each with its one deliberately bad row reported and counted as skipped.
  - Bad files: an empty file ("The file is empty"), broken JSON and a truncated X archive file
    each show "could not be imported. Nothing was added." with the parser's reason.
  - Restarted the server: all 135 posts and 5 sources were still there.
  - Combined a source filter with a search and an exclusion (`-bluesky`), got the expected
    counts, got the "No posts match these filters" state with the rules that hid the most, then
    undo (`z`) and clear all (`x`) restored the list.
  - Code blocks in real articles render as monospace blocks with their line breaks; wide lines
    scroll inside the block and the page does not scroll sideways (desktop and a 390px phone).
- **Timeline, 21:34** (Playwright against the same scratch library of 135 posts): 30 posts render
  and scrolling to the end loads the next 30; `j`/`j` selects and scrolls to the second post; `w`
  opens its explanation; `Enter` expands an article in place with its 9 code blocks; Collect opens
  its popover; Hide removes the post with an Undo toast and `z` brings it back; in "Worth reading",
  scrolling past 6 posts marked them seen while all 30 stayed in the feed. On a 390px phone the
  Rules, Views and Sources tabs each open their sheet, Why works, and the page does not scroll
  sideways. No page errors.
- **Import edge cases, by hand against the API:** CSV with a byte-order mark and CRLF line
  endings imports; a `javascript:` link is skipped with a reason; HTML in a title is stored as
  text; re-importing the same file refreshes posts and adds none; an 85 MB upload gets HTTP 413
  in under 1 ms, and a 31 MB body to a normal API route gets 413 with the 1 MB limit.
- **Request guards, rechecked on 4317 at 21:04:** a foreign `Host` header gets 421, a write with
  a foreign `Origin` gets 403, a `text/plain` write gets 415; CSP, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and `nosniff` are sent; the server listens on 127.0.0.1 only;
  the database files are mode 0600. Earlier in the session, feed URLs pointing at 127.0.0.1 and
  169.254.169.254 were refused.
- **Other real feeds tried:** Mastodon `@user.rss` and Bluesky `/rss` work. Reddit `.rss` returned
  HTTP 429 and YouTube channel feeds returned 404, and the app shows both errors on the source.
- **Aurora, 22:05** (same scratch library and scripts as the timeline check): all of the timeline
  checks above pass again; clicking the "Worth reading" lens changes the headline from "135 in
  everything" to "85 worth reading" and lights that lens; "+" opens the save-view field; the
  "lit by" pill opens the explanation on desktop and phone; no sideways scroll at 390px; no page
  errors.
- **Screenshots:** `design/shots/r7` is the current Aurora look (desktop dark and light, the Why
  panel, an expanded article, mid-width, phone dark and light). `design/shots/r6` is the timeline
  before Aurora (desktop dark and light, the Why
  panel, an expanded article, mid-width, phone dark and light, and the preview's demo library in the light theme). `design/shots/r5` shows the same
  colours and type on the earlier list-and-reader layout; the Sources and import screens there
  are unchanged. The timeline's own empty and first-run states were rewritten and typecheck, but
  were not screenshotted. `design/shots/r3` and `r4` show the first warm serif look.

## Not verified

- Live X bookmarks, the X OAuth flow and token refresh (needs Tal, see below).
- The PWA install on a real phone. Phone layouts were checked only in a 390px browser viewport.
- Screen readers. Keyboard focus, dialogs and labels were checked in code and by a script, not with
  a screen reader.
- Background auto-sync over many hours, and libraries much larger than 5,000 posts.
- Drag-and-drop import (the file picker path was tested; drop uses the same handler).

## Needs Tal

- **Live X bookmarks.** The connector and OAuth flow are built but untested against X, because
  it needs an X developer app that belongs to you, and X bills bookmark reads (pay-per-use,
  about $0.001 per post read as of Oct 2026; there is no free tier for this endpoint). Paid access
  was not enabled. To enable it yourself:
  1. Create an app at developer.x.com with OAuth 2.0 (type Native App), scopes `tweet.read
     users.read bookmark.read offline.access`, callback
     `http://127.0.0.1:4317/api/x/auth/callback`.
  2. Add credits to the X developer account if you accept the cost.
  3. Start with `X_CLIENT_ID=... npm start`, open Sources and click "Approve read access on X".

  To keep costs predictable, X bookmarks never sync in the background: they sync once after you
  approve, then only when you press Sync. Each sync stops at the first page that reaches
  bookmarks it has already seen (at most 8 pages of 100 on a first sync).
- **Free alternative for X:** request your X data archive (Settings, Your account, Download an
  archive) and import `tweets.js`, `like.js` and `bookmark.js`. Bookmarks in the archive only
  contain post ids, so they show as links without text. The twitter-web-exporter browser
  userscript exports bookmarks with full text, and its JSON imports here; installing it is your
  call.
- **Your real feeds.** Nothing of yours is connected. Add feeds or a Bluesky handle in Sources, or
  import an OPML file from another reader.

## Known limitations

- Reddit `.rss` feeds work but Reddit rate-limits them (HTTP 429), so syncs sometimes fail and
  retry on the next cycle. The Reddit API needs app approval and is not implemented.
- YouTube channel RSS was returning errors (500/404) from Google during the build; the parser is
  tested against a fixture.
- Mastodon home timeline needs a per-instance OAuth app; public profiles work via RSS instead.
- Threads, Instagram and LinkedIn have no feed or export API for this use and are listed as not
  available.
- Language comes from the source when it provides one (Bluesky, X, some feeds). Otherwise a small
  local guess (common words in English, Spanish, French, German, Portuguese, Italian, Dutch) fills it
  in and the post says it was guessed. Short posts stay "unknown".
- The noise classifier is rule-based (English phrases plus structural signals). It explains
  itself and can be overridden per post, but it does not learn from overrides yet.
- Filtering runs in the browser over the whole library (about 10 to 15 ms for 5,000 posts). For
  hundreds of thousands of posts it would need server-side queries and pagination.
- Search matches words as typed: `0.4` finds "0.4", but `04` does not.
- Images and video thumbnails load directly from the source's https URLs in the reader (no
  referrer sent; 1x1 tracking pixels are dropped on import). Opening a post therefore tells that
  image host you viewed it. A local, SSRF-checked image proxy would close that gap.
- Wide code blocks scroll sideways, but nothing shows that more is hidden until you scroll.
- Code inside articles is shown as plain monospace text, without syntax colours.

## Next priorities

1. Connect X bookmarks once the developer app exists, and test pagination and token refresh live.
2. Serve images through a local, size-capped, SSRF-checked proxy so remote hosts never see views.
3. Learn from noise overrides: suggest new rules ("you marked 5 posts with 'thread 🧵' as noise").
4. A better language guess (more languages, scripts other than Latin).
5. Full-text search index (SQLite FTS5) and server-side filtering for very large libraries.
6. Test on a real phone (PWA install, touch targets) and with a screen reader.
7. React Native app on top of `core/` and the JSON API.
