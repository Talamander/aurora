# Aurora for the desktop

Aurora also comes as a desktop app for Linux, macOS and Windows. It is the same app you open in
the browser, wrapped in a native window with a tray icon, a global shortcut and notifications. It
runs its own private copy of the Aurora server on your computer; nothing extra is reachable from
your network.

The app lives in `desktop/` and is built with Electron. (Tauri would be smaller, but it needs a
Rust toolchain; Electron builds anywhere Node does.)

## What you get

- **Its own server, on localhost only.** On launch the app starts the Aurora server as a child
  process on a random free port on `127.0.0.1`, waits for it, and shows it. Quitting the app stops
  the server.
- **Your data in the usual place.** The library lives in the app-data folder:
  `~/.config/Aurora/data` on Linux, `~/Library/Application Support/Aurora/data` on macOS and
  `%APPDATA%\Aurora\data` on Windows. The server log is in `logs/server.log` beside it. Set
  `SOCIAL_READER_DATA` to point the app at a different library (for example the one your
  self-hosted copy uses).
- **Tray icon with your unread count.** The count updates as posts arrive. On macOS it also shows
  in the menu bar and on the Dock badge. Closing the window keeps Aurora syncing in the
  background; quit from the tray menu (or Cmd+Q). If your Linux desktop has no tray, closing the
  window quits the app.
- **Command palette from anywhere.** Press Ctrl+Shift+Space (Cmd+Shift+Space on macOS) in any app
  to bring Aurora forward with the palette open.
- **Morning edition notification.** When the morning edition is rebuilt you get a native
  notification; clicking it opens the edition. You are never told about an edition you have
  already been told about.
- **One window.** Launching Aurora again brings the running window forward instead of starting a
  second server.
- **`aurora://` links.** `aurora://follow?url=https://example.com/feed.xml` opens Aurora with
  "Follow this: …" ready in the agent box. Nothing is sent until you press send, exactly like the
  browser's `?follow=` links and the phone share sheet. Only `http` and `https` targets are
  accepted. Installed builds register the scheme; development runs never touch your system's link
  handlers.
- **Start at login (off by default).** Turn it on from the tray menu. It starts Aurora hidden in
  the tray. On Linux this writes `~/.config/autostart/aurora.desktop`; turning it off removes it.
- **Native window chrome.** The title bar is hidden: on macOS the traffic lights sit over the
  sidebar, on Windows and Linux the window controls sit top right and take the theme's colours.
  The sidebar top and the header bars drag the window.

## Quick look

Quick look is a small Spotlight-style window over whatever you are doing. It shows:

- the top five posts worth reading in the active profile (title, author, source), the same list
  `aurora status` counts;
- unseen alert hits, if there are any;
- what the Listen queue is reading, if it is playing (press `p` or click it to pause or resume);
- an Ask box. Your question opens in the main window's agent panel and is sent from there. Quick
  look itself never calls an AI model.

Keys: `j` and `k` (or the arrow keys) move, `Enter` opens the post in the main window's reader,
`o` opens the original in your browser (and marks it read), `s` saves or unsaves, `e` hides, `u`
undoes the last save or hide, `/` jumps to the Ask box, and `Escape` closes. Clicking anywhere
else closes it too. It follows the app's theme, including a profile's own look and the
Desktop (Omarchy) theme.

**Opening it.**

- The shortcut **Ctrl+Alt+Space** (Option+Space on macOS) toggles it while Aurora is running.
  Neither clashes with an Omarchy, GNOME, KDE or Windows default. To change it, set
  `"quickShortcut"` in `desktop.json` (in the app-data folder, next to `data/`) to an Electron
  accelerator such as `"Control+Alt+K"`, or start Aurora with `AURORA_QUICK_SHORTCUT=...`. Use
  `"off"` to turn the shortcut off.
- `aurora --quick` (the app binary with `--quick`) or opening `aurora://quick` toggles it from a
  script or another app. If Aurora is not running yet, it starts in the background and shows only
  Quick look.
- The tray menu and the command palette (`Quick look`) open it too.

**Wayland and Hyprland.** Electron's global shortcuts often cannot register under Wayland, so on
Omarchy bind a key in Hyprland instead. `integrations/omarchy/bindings.lua` has a commented line
to copy into your own bindings:

```lua
o.bind("SUPER + ALT + Q", "Aurora quick look", "aurora --quick")
```

Use the path to the AppImage (or `xdg-open aurora://quick` with an installed build) if `aurora`
is not on your `PATH`. Check that the key is free with `omarchy menu keybindings --print`.
Hyprland places windows itself: if it tiles Quick look, add a window rule that floats, centres
and pins the window titled `Aurora quick look`.

**In a browser.** `/?quick=1` on any Aurora server is the same view as a page that fits a small
popup (the palette's Quick look opens it as one). There, `Enter` and the Ask box hand over to the
Aurora tab you used last. With no Aurora tab open, they open `/?post=<id>` or `/?ask=<question>`
in a new tab; a question that arrives in a link is only put in the agent box, never sent, so a
link alone cannot spend anything.

**Speed.** Quick look is its own small chunk (about 9 KB of script). It never loads the library:
it asks `/api/quick` for the five posts (the server filters them) and `/api/alerts/hits` for the
alerts. The window stays loaded while hidden, so showing it again is instant and refreshes the
list.

## Security

The window is locked down the way Electron's security checklist recommends:

- The page runs with context isolation, the renderer sandbox on and Node integration off. Its only
  view of the desktop shell is `window.auroraDesktop`, a small object from `desktop/preload.cjs`:
  the platform name, a listener for the shell's commands (palette, follow, page, post, ask and so
  on), native full screen for Ambient, a call to tint the window controls (which only accepts two
  `#rrggbb` colours), and Quick look's calls. The main process checks which window sent each
  message: only Quick look's window may hide itself or hand a post or question to the main window,
  and only the main window may open Quick look or change full screen and the title bar.
- The window may only navigate within the local Aurora origin. Any other link opens in your
  system browser (`http`, `https` and `mailto` only). New windows are always refused, and
  `<webview>` is blocked.
- Permission requests are denied, with two exceptions for the local app only: writing to the
  clipboard (the copy buttons) and fullscreen (video). Camera, microphone, location,
  notifications from the page, USB, serial and the rest are refused. Reading the clipboard is
  refused too; pasting with the keyboard still works because that is a normal paste event.
- The server binds to `127.0.0.1` and the shell strips `ALLOW_NON_LOCAL` and `SR_ALLOWED_HOSTS`
  from its environment, so a stray setting cannot widen it. The server's own Host, Origin and
  content-type checks apply unchanged.
- Packaged builds flip Electron's fuses: the app binary cannot be used as a Node interpreter
  (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, only loads its code from the
  asar archive (with integrity checks on macOS and Windows), encrypts cookies, and gives `file://`
  no extra privileges. The splash page is a `data:` URL for that reason.
- Developer tools are off in packaged builds unless you start the app with `AURORA_DEVTOOLS=1`.

Builds are not signed with a developer certificate yet. The macOS app is ad-hoc signed so Apple
silicon will run it, but macOS will say it is from an unidentified developer (right-click, Open,
the first time), and Windows SmartScreen will ask before the first run.

## Which Node runs the server

The server is TypeScript run directly by Node's type stripping, and the sandbox for AI-built
connectors starts sub-processes with `process.execPath`, so it needs a real Node binary rather
than Electron's embedded one. The app picks, in order:

1. **The bundled runtime.** Packaged builds ship the official Node.js (currently 26.8.1) in
   `resources/node`. `desktop/scripts/fetch-node.mjs` downloads it from nodejs.org and checks it
   against the published SHA-256 sums before unpacking.
2. **Your Node, in development.** `AURORA_NODE` if set, otherwise `node` on your `PATH`, if it is
   22.18, 23.6 or newer.
3. **Electron's own Node** (via `ELECTRON_RUN_AS_NODE`) as a last resort in development. The app
   works, but AI-built connectors that run as Node sub-processes cannot start this way.

The server log records which one was used.

## Run it in development

```bash
npm install                       # the main app's dependencies, at the repository root
npm run build                     # build web/dist
npm --prefix desktop install      # Electron and electron-builder
npm --prefix desktop run dev      # opens the desktop app on your current web/dist
```

Rebuild `web/dist` after changing the web app; the desktop app serves whatever is there.

Useful environment variables:

- `SOCIAL_READER_DATA=/path/to/data` uses a different library.
- `AURORA_USER_DATA=/path/to/folder` uses a separate profile folder (settings, logs, data).
- `AURORA_DEVTOOLS=1` allows developer tools in a packaged build.
- `AURORA_SHOT=/path/to/file.png` renders the app off screen, saves a screenshot and quits. It
  works without a display when combined with
  `--ozone-platform=headless --ozone-override-screen-size=1920,1200 --disable-gpu --in-process-gpu`.
  `AURORA_SHOT_SIZE=1440x900`, `AURORA_SHOT_WAIT` (milliseconds) and `AURORA_SHOT_COMMAND`
  (`palette`, `follow` or `page`, with `AURORA_SHOT_ARG`) shape the shot.

## Build installers

```bash
npm --prefix desktop run dist:linux   # AppImage and .deb
npm --prefix desktop run dist:mac     # .dmg (on a Mac)
npm --prefix desktop run dist:win     # NSIS installer (on Windows)
```

Each one first runs `npm run stage`, which builds the web app, copies `core/`, `server/`,
`web/dist` and production `node_modules` to `desktop/build/aurora`
(`desktop/scripts/stage.mjs`), and fetches the matching Node runtime to `desktop/build/node`.
electron-builder then packages everything into `desktop/dist/`.

Build each platform on that platform: production `node_modules` include the Claude Agent SDK's
native binary for the machine doing the install, and the bundled Node matches the host too. The
GitHub Actions workflow in `.github/workflows/desktop.yml` builds all three on their own runners
(Linux x64, macOS arm64, Windows x64) and uploads the installers as workflow artifacts. It never
publishes a release.

The installers are large (about 300 MB for the AppImage) because they carry Chromium, a full
Node runtime and the Claude Agent SDK's bundled agent binary.

The app icons in `desktop/assets` are rendered from `web/public/icon.svg`; run
`npm --prefix desktop run icons` after changing the logo (it needs Chromium; set `CHROMIUM` if it
is not at `/usr/bin/chromium`).

## Sign-in browser

Sources that need you to sign in use a real browser window on your desktop, as in the browser
version. The desktop app looks for Chrome, Chromium or Edge already installed on your computer; it
does not bundle one.
