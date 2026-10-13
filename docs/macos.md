# Aurora on macOS

Aurora runs on a Mac straight from a clone: the server, the web app, the built-in connectors, the
AI features, the terminal client and the desktop app all work, including connectors the AI writes
for you, which run in macOS's built-in sandbox (see [What works and what does not](#what-works-and-what-does-not)).

Tested by: running the server and the full test suite on Node 22.18+, 24 and 26, unit tests of
every macOS branch (they take the platform as a parameter, so they run on any OS), and packaging
the macOS arm64 app bundle with electron-builder. It has not yet been run on real Mac hardware by
the authors, so tell us what breaks.

## Quick start

You need Node.js 22.18 or newer; 24 or newer is recommended. Homebrew's `node` is current:

```bash
brew install node git            # or: brew install node@24
node -v                          # v24.x or newer

git clone git@github.com:Talamander/aurora.git aurora
cd aurora
npm install
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Your library lives in `data/` inside the clone (set
`SOCIAL_READER_DATA=/some/folder` to keep it elsewhere). Stop the server with Ctrl+C.

`npm start` checks the Node version first and says so plainly if it is too old. With a newer npm
you may see `npm warn install-scripts ... esbuild`; that is harmless, the build does not need the
script.

Optional extras:

```bash
brew install yt-dlp              # "Keep a copy" of videos (archive)
brew install --cask google-chrome   # sources you sign in to (or Chromium, Brave, Edge)
brew install choose-gui          # `aurora pick`: a small Spotlight-style post picker
```

The terminal client works as on Linux: `node cli/aurora.ts` (or `npm run tui`).

## The desktop app

Build it on the Mac itself (the bundled Node and the Claude Agent SDK binary are per platform):

```bash
npm install                        # once, at the repository root
npm --prefix desktop install
npm --prefix desktop run dist:mac  # builds web/dist, stages the server, fetches Node, makes the .dmg
open desktop/dist/*.dmg
```

`dist:mac` downloads the official Node runtime for your Mac (arm64 on Apple silicon, x64 on Intel)
from nodejs.org and checks it against the published SHA-256 sums. electron-builder turns
`desktop/assets/icon.png` into the `.icns` icon on its own. Drag Aurora to Applications.

The app is not signed with an Apple developer certificate; it is ad-hoc signed so Apple silicon
will run it. The first time, macOS says it is from an unidentified developer:

- Right-click (or Control-click) Aurora in Applications, choose **Open**, then **Open** again. On
  macOS 15 and newer, if there is no Open button, go to System Settings, Privacy & Security, and
  click **Open Anyway** next to the Aurora message.
- If macOS says the app "is damaged" (this happens when the .dmg was downloaded through a
  browser, not built on this Mac), clear the quarantine flag:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Aurora.app
  ```

On a Mac the desktop app:

- puts a template icon with your unread count in the menu bar;
- opens Quick look with **Option+Space** (Ctrl+Option+Space switches input sources on macOS, so
  it is not used). Option+Space normally types a non-breaking space; if you need that, change the
  shortcut (`"quickShortcut"` in `desktop.json`, see [desktop.md](desktop.md#quick-look));
- opens the command palette with **Cmd+Shift+Space**;
- keeps running when you close the window, like other Mac apps (quit from the menu bar icon or
  Cmd+Q);
- keeps its data in `~/Library/Application Support/Aurora/data`, separate from a clone's `data/`;
- can start at login (menu bar icon, Start at login), using macOS login items.

For development without building a .dmg: `npm run build && npm --prefix desktop run dev`.

## The phone app (iOS simulator)

You need Xcode (from the App Store) with its iOS simulator.

```bash
cd mobile
npm install
npx expo start         # then press i for the iOS simulator
# or a full native build: npx expo run:ios
```

The simulator shares the Mac's network, so on the pairing screen type the server address
`http://127.0.0.1:4317` and the code shown under the QR code in Aurora (Settings, AI, Phones).
A real iPhone needs Aurora to listen on your network (`HOST=0.0.0.0 ALLOW_NON_LOCAL=1 npm start`)
and your Mac's address instead; see [mobile.md](mobile.md).

## What works and what does not

Works the same as on Linux:

- the reader, all views, search, profiles, alerts, routines, the AI chat and every AI feature;
- built-in connectors: RSS and Atom (which also covers YouTube channels, public Mastodon accounts,
  subreddits, blogs and podcasts), Bluesky, the X API and the export importers;
- sources you sign in to, using Google Chrome, Chromium, Brave or Edge from `/Applications` or
  `~/Applications` (Aurora uses its own browser profiles and never touches your normal Chrome
  profile). `CHROMIUM_PATH=/path/to/binary` picks a specific one;
- the desktop app, the terminal client, `aurora pick` (with `choose` or `fzf`), the MCP server and
  the phone app;
- **connectors the AI writes for you.** On Linux they run inside bubblewrap. On a Mac they run
  under Seatbelt, the sandbox built into macOS (`/usr/bin/sandbox-exec`), labelled
  `isolation seatbelt`. The profile (`server/actors/sandbox.ts`) denies everything by default,
  then allows: reading the system, but not the contents of anything in your home folder except the
  connector's own folder, its cache, the Node and uv runtimes and uv's Pythons; writing only to
  the run's temp folder and cache; and one network destination, the egress proxy's port on
  localhost, so DNS, direct connections and the Aurora server itself are out of reach. The proxy
  then allows only the hosts the connector declared, as on Linux. Python connectors need `uv`
  (`brew install uv`). Seatbelt is deprecated by Apple and its profile language is undocumented,
  and unlike bubblewrap it sets no memory limit; Docker (below) remains the stronger choice.

Does not work straight on macOS:

- **Omarchy integration** (Match my desktop theme, the Waybar module) is Linux only. On a Mac
  those settings simply have nothing to read; nothing fails.

For bubblewrap instead of Seatbelt, run Aurora in Docker, which provides a small Linux VM:

```bash
brew install --cask docker       # Docker Desktop; OrbStack or Colima also work
docker compose up -d --build     # in the clone; see docs/self-hosting.md
```

The compose file already sets the options bubblewrap needs. Check the Workshop after the first
connector run: it should say `isolation bwrap`.

`SR_ACTOR_ISOLATION=none` turns Seatbelt off and runs AI-written connectors as ordinary processes
(they could then read your files, including Aurora's stored keys). Each run is then labelled
`isolation: none`. We do not recommend it.

## Troubleshooting

- **`Unknown file extension ".ts"` or `Aurora needs Node.js 22.18 or newer`:** your `node` is too
  old. `brew install node`, open a new terminal, check `node -v`. If you use nvm, `nvm install 24`.
- **`npm test` says it cannot find `tests`:** you are on an old checkout; pull, the test script
  now uses a glob that Node 22 and 24 understand.
- **Port 4317 is in use:** `PORT=4400 npm start`, then open <http://127.0.0.1:4400>.
- **"Chromium or Google Chrome is not installed":** install Google Chrome, or point Aurora at a
  browser with `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.
- **Option+Space does nothing:** another app (Raycast, Alfred, an input method) has the
  shortcut. Set `"quickShortcut"` in `~/Library/Application Support/Aurora/desktop.json` to
  another accelerator such as `"Control+Alt+K"` (see [desktop.md](desktop.md#quick-look)).
- **The desktop app opens but shows an error page:** read
  `~/Library/Application Support/Aurora/logs/server.log`.
- **`aurora pick` says no launcher found:** `brew install choose-gui` (or `fzf` and run it from a
  terminal), or set `AURORA_MENU` to any command that reads lines on stdin and prints the chosen
  one.
