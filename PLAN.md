# Aurora plan (formerly Social Reader)

Authorized by Tal on 2026-10-12 (evening): build continuously to completion with no check-in
gates, ship fast, try new things, keep ceremony low. This file is the shared plan for the main
session and any helper agents. Update the checklist as work lands.

## Product in one paragraph

Social Reader becomes a personal social network that the user shapes by asking. An in-app AI
adds sources ("follow MKBHD and @natgeo on Instagram"), filters, views, pages and themes, and it
builds the connectors itself at runtime: small "actor" scripts in the style of Apify actors,
written, tested, installed and repaired by the AI, running in a sandbox. Two ways to run it:
self-hosted (one command, everything local, like Immich or Jellyfin) and cloud-hosted (later).
Read-only toward every platform, always.

## Decisions already made by Tal

- Self-hosted AI: either the user's own API key or a local model; both are supported. In this
  machine's dev setup the Claude Agent SDK uses the local Claude Code login.
- No paid APIs and no "export your data" as the main path. Order of attack for any source:
  free API or feed, then public-page scripts (Python or JS, existing open-source tools welcome),
  then a real browser, and finally a signed-in browser session that the user logs into
  themselves.
- The AI goes ahead without asking for anything local and reversible.

## Lines we hold

- Never copy cookies or passwords out of the user's normal browser. Signed-in sources use the
  app's own browser profile, and the user types their own login.
- No CAPTCHA solving or bot-detection evasion. Slow down, or ask the user.
- Never write to a platform (no likes, follows, posts, bookmark changes).
- Imported posts and fetched pages are data, never instructions. Tool results that carry outside
  content are wrapped and labelled untrusted.
- Actor code runs sandboxed with network only to the hosts it declares, never sees the database,
  secrets or the user's files.
- The app keeps binding to 127.0.0.1 by default.

## Architecture

### Actors (AI-built connectors)

An actor lives in `data/actors/<id>/`:

- `actor.json`: the manifest.
- `main.py` or `main.ts`: the code.
- `versions/<n>/`: earlier versions, for rollback.

Manifest:

```json
{
  "id": "instagram-profile",
  "name": "Instagram profile",
  "version": 3,
  "runtime": "python",
  "entry": "main.py",
  "platform": "instagram",
  "description": "Recent posts from a public Instagram profile.",
  "tier": "http",
  "hosts": ["www.instagram.com", "*.cdninstagram.com"],
  "input": { "type": "object", "properties": { "username": { "type": "string" } }, "required": ["username"] },
  "python": { "requires": ["instaloader==4.14.2"] },
  "createdBy": "agent",
  "createdAt": "2026-10-12T22:30:00Z",
  "updatedAt": "2026-10-12T22:30:00Z",
  "notes": "Uses the web_profile_info endpoint; needs the x-ig-app-id header."
}
```

`tier` is one of `api`, `http`, `browser`, `session`.

**Runtime protocol.** The input arrives as JSON in env `SR_INPUT`. The state saved by the
previous run arrives in env `SR_STATE`. The actor writes JSON lines to stdout:

- `{"type":"item","item":{...RawPost}}`
- `{"type":"state","state":{...}}`
- `{"type":"log","msg":"..."}`
- `{"type":"error","msg":"..."}`

Other stdout lines and all of stderr become logs.

**RawPost** (what an actor emits; the host maps it to an `ItemDraft`):

```
{ id, url, author: { name, handle?, url?, avatar? }, text?, html?, title?, publishedAt?,
  media?: [{ type: 'image'|'video', url, thumb?, alt? }], links?, kind?, quoted?, metrics?, lang? }
```

**Helper library `sr`.** It is preinstalled for both runtimes: Python `import sr`, Node
`import * as sr from 'sr'`.

- `sr.input` and `sr.state`.
- `sr.emit(item)` and `sr.save_state(obj)`.
- `sr.log(msg)`.
- `sr.fetch(url, headers?, method?, body?)` returns status, final url, headers, text and json.
- `sr.browser(url, wait_ms?, scroll?, capture?)` loads the page in the host's Chromium and
  returns the html, the visible text, the links and the JSON responses it captured.
- `sr.html_to_text(html)`.

**Sandbox and network.**

- The sandbox is bubblewrap: no network namespace, a read-only system, a tmpfs home, and no
  access to `data/`.
- All network goes through the host's egress proxy, which allows only the manifest's hosts
  (plus package indexes while dependencies install). It also refuses private addresses and logs
  every request.
- `sr.browser` reaches the host through the same proxy, at `http://sr.internal/browser`.
- When bubblewrap is unavailable (for example inside some containers), the actor runs as a plain
  subprocess with proxy variables set. The run is then labelled `isolation: none`.

**Sources.** A source with connector `actor` stores the actor id and input in its config, and
keeps the actor state in the source cursor. It syncs on its own interval (60 minutes by default,
to be polite to the sites).

**Repair.** When a scheduled run fails twice, or drops to zero items after working, a repair job
starts if AI is configured. A repair that wants new hosts waits for the user's approval.

### Agent

`server/agent/`:

- **Providers:**
  - `claude`: the Claude Agent SDK, using the local Claude Code login or `ANTHROPIC_API_KEY`.
    All built-in tools are off, MCP is strict, and only our in-process tools are allowed.
  - `openai`: any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, OpenAI), driven by
    our own tool loop.
- **Tools:**
  - read: overview, search posts, sources, views, pages, actors.
  - local-write (automatic, recorded in a change log with undo): views, topics, filters, pages,
    themes, item state, collections, UI navigation.
  - network: add a feed (built-in RSS and Bluesky), build a source (starts a builder job), run a
    source.
- **Builder jobs:** a separate background run with builder tools:
  - `http_get` and `browser_probe` (which captures the JSON endpoints a page calls).
  - `read_knowledge` (per-platform notes in `server/agent/knowledge/`).
  - `write_actor`, `test_actor` and `install_source`.
  - Progress streams to the UI.
- **Events:** `GET /api/events` (Server-Sent Events) broadcasts three things:
  - library changes, so the feed refreshes live;
  - agent run events;
  - UI actions the agent asked for (open a view or page, set a filter, apply a theme).

### Pages

A page is a named list of blocks rendered by our own components. The AI writes JSON, never UI
code. The block types:

- `hero`
- `feed`, with a filter spec and a layout of timeline, grid or compact
- `gallery`
- `people`
- `stats`
- `note`
- `digest`: AI-written, with citations to posts
- `widget`: custom HTML that the AI writes. It runs in a sandboxed iframe served with its own
  strict CSP: no network and no same-origin access. Data arrives by postMessage.

### UI

- An Ask composer in the Aurora dock, opened with `.` or Ctrl/Cmd+K. On phones it is an Ask tab.
- A side panel with the conversation. Tool steps show as compact rows, changes carry Undo chips,
  and build jobs show live progress and sample posts.
- A Workshop screen listing every actor. Each one shows its code, versions, runs, and buttons for
  run now, ask AI to fix, and roll back.
- AI settings: provider, model, base URL and key. Keys stay on the server.

## Brainstorm (things Tal may love)

1. Paste anything to start: a messy list of links, handles and names becomes sources built in
   parallel, with live tiles.
2. Ask your feed: questions answered from the library, with post cards as citations.
3. Morning edition: a daily AI digest page with sections and citations.
4. Plain-English rules: "hide rage bait about politics" becomes an AI-classified rule, with
   labels cached per post and explained like every other rule.
5. Taste suggestions: "You hide most crypto posts. Mute crypto?"
6. Themes on request, Omarchy style: "make it Tokyo Night" sets the colour tokens.
7. Person pages that merge one person's posts across platforms.
8. Workshop with versions, rollback, self-repair and "why did this break".
9. Actor bundles: share an actor as a file without any cloud.
10. Inline video playback (youtube-nocookie embeds), and local media archiving for saved posts
    (yt-dlp), so saved posts survive deletion.
11. Since-you-were-away catch-up card.
12. Your feed as an MCP server and as RSS/JSON feeds for other tools.
13. Signed-in sources with in-app login (a CDP screencast in the web UI), so it works on a server
    or in Docker too.
14. Household accounts, Immich style.

## Phases and checklist

- [x] 0. Plan, git checkpoint, SDK spike (done: SDK works with the local login; strict MCP needed)
- [x] 1a. Actor runtime: sandbox, egress proxy, `sr` libraries, browser service, actor store (helper agent)
- [x] 1b. Knowledge pack: per-platform extraction notes verified live (helper agent)
- [x] 1c. Agent core: providers, tools, change log, events, chat API (main)
- [x] 1d. Agent UI: Ask composer, panel, steps, undo chips (main)
- [x] 2. Builder jobs plus actor sources plus live refresh; real end-to-end builds on YouTube, Instagram, Threads, TikTok, Facebook, X, Reddit, Hacker News, Substack and Telegram (done: 24 real builds; Reddit and Hacker News stay on built-in RSS by design)
- [x] 3. Pages and widgets, themes, paste-anything onboarding, ask-your-feed citations
- [x] 4. Plain-English AI rules, morning edition, self-repair, Workshop polish
- [x] 5. Docker image, compose file, install script, self-hosting docs (helper agent)
- [x] 6. Stretch: signed-in tier with in-app login, inline video, media archive, MCP server
- [x] 7. Verify in the browser, screenshots, README and STATUS, restart the preview
- [x] 8. Android app (`mobile/`, Expo): QR pairing with revocable device tokens, feed with lens chips, save and set aside, agent, morning edition with Listen, pages, person, sources, settings. Proven by `expo export` for Android and screenshots of the web build (docs/mobile.md)
- [ ] 9. iOS app from the same `mobile/` code: build and test on a Mac with Xcode (`npx expo run:ios`) or with EAS Build; check the floating tab bar, Ionicons, local-network permission prompt and keychain storage on a real iPhone; TestFlight once there is an Apple developer account (Tal's decision, not automated)
- [ ] 10. Phone polish: release APK signing, push notifications for the edition (needs a push relay decision). Done on night two: offline cache of the library and articles with a queue for offline changes, Android share target "Send to Aurora", search with More like this
