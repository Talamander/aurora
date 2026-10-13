# Aurora on Omarchy

Aurora is meant to feel like part of the desktop: a server that is always there, a status-bar
count, a key to open it as an app window, and a terminal client for keyboard people. Everything
here lives in `integrations/omarchy/`. Nothing is installed for you; copy what you want.

## Install on Arch / Omarchy

`packaging/arch/` has a PKGBUILD that builds an `aurora-reader` package from this checkout:

```sh
cd packaging/arch
makepkg -si                          # builds from the committed HEAD, then installs with pacman
systemctl --user enable --now aurora # start it for your user, on 127.0.0.1:4317
```

makepkg clones the repository's committed HEAD, so uncommitted edits and your `data/` folder are
never packaged. `AURORA_REPO=/path/or/git-url makepkg -si` builds another checkout. The build
runs `npm ci` with install scripts turned off and needs the npm packages in `package-lock.json`
(from the npm cache or the network).

What the package installs:

- `/usr/lib/aurora`: the server, core, CLI, built web app and production `node_modules`.
- `/usr/bin/aurora-server`: starts the server with data in `~/.local/share/aurora` (or
  `$XDG_DATA_HOME/aurora`), created private to you, on 127.0.0.1:4317. `PORT`, `HOST` and
  `SOCIAL_READER_DATA` override it as usual.
- `/usr/bin/aurora`: the terminal client (`aurora`, `aurora status`, `aurora pick`), pointed at
  the same data folder so it works when the owner lock is on.
- `/usr/lib/systemd/user/aurora.service`: the user unit. Change the port with
  `systemctl --user edit aurora` and an `Environment=PORT=...` line.
- The Aurora and Aurora (terminal) launchers, the icon in every size, the docs, and the Waybar and
  Hyprland extras in `/usr/share/aurora/omarchy` to copy yourself.

Chromium (signed-in sources and connector building), bubblewrap (the connector sandbox), Python
with uv (Python connectors), yt-dlp (saved videos) and Walker (`aurora pick`) are optional
dependencies. The package is built per architecture (x86_64, aarch64) because the Claude Agent
SDK carries a native binary. Moving from a clone to the package: stop the clone's unit, then
copy its `data/` folder to `~/.local/share/aurora` (keep `secret.key` and `local.key` with it).

The PKGBUILD is not on the AUR. Publishing it needs a public source URL, a tagged release and a
license, which are Tal's decisions.

## Keep the server running (from a clone)

```sh
cp integrations/omarchy/aurora.service ~/.config/systemd/user/
# edit WorkingDirectory if Aurora is not in ~/Projects/social-reader
systemctl --user enable --now aurora
```

The unit runs `node server/main.ts` on 127.0.0.1:4317 and restarts it if it stops.

## Open it like an app

- `aurora.desktop` opens Aurora with `omarchy-launch-webapp` (a clean app window), falling back to
  `xdg-open`. Copy it and the icon:

  ```sh
  cp integrations/omarchy/aurora.desktop integrations/omarchy/aurora-terminal.desktop ~/.local/share/applications/
  cp integrations/omarchy/aurora.png ~/.local/share/icons/aurora.png
  ```

- `bindings.lua` adds SUPER+ALT+A (app window) and SUPER+ALT+SHIFT+A (terminal client). Append it to
  `~/.config/hypr/bindings.lua`. SUPER+SHIFT+A is left alone because Omarchy uses it.

## Ambient

Ambient (see [ambient.md](ambient.md)) works well on a second monitor. To open it in its own app
window with a key, add a line like this to `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + M", "Aurora Ambient", "omarchy-launch-webapp http://127.0.0.1:4317/?ambient=1")
```

Use `?ambient=photos` for photos only, or add `&view=saved` or `&pace=30`. Press `f` in the window
to go full screen, or use Hyprland's own full-screen key. Check for clashes with
`omarchy menu keybindings --print` first.

## Waybar count

`aurora status --waybar` prints Waybar JSON: `◆ 11` when 11 posts are worth reading in your
active profile, a tooltip with the newest five, and the classes `unread`, `clear` or `off`.
When an alert has caught something you have not looked at, the text becomes `◆ 11 ⚑ 2`, the
tooltip lists those posts first and the class is `alert`.
Post text in the tooltip is flattened, stripped of control sequences and Pango-escaped, because it
is third-party content.

1. Add `"custom/aurora"` to a `modules-*` list in `~/.config/waybar/config.jsonc` and paste the block
   from `waybar-module.jsonc`.
2. Append `waybar.css` to `~/.config/waybar/style.css`.
3. `omarchy-restart-waybar` (or `pkill -SIGUSR2 waybar`).

Left click opens the app window, right click opens the terminal client.

## Terminal client

`node cli/aurora.ts` (or `npm run tui`). See [terminal.md](terminal.md).

Other one-shot forms:

```sh
node cli/aurora.ts status            # "All: 11 worth reading, 0 saved"
node cli/aurora.ts status --json     # for scripts
node cli/aurora.ts status --profile work
```

## Front page and Ambient on a key

From a terminal or any launcher, `aurora open front`, `aurora open ambient` or `aurora open constellation` opens that view in your browser.

`integrations/omarchy/bindings.lua` ends with two commented bindings: `SUPER + ALT + F` opens
today's Front page (`/?front=1`) and `SUPER + ALT + M` opens Ambient (`/?ambient=1`) as a web app.
Uncomment the ones you want after copying the file; check for clashes with
`omarchy menu keybindings --print` first.

## Pick a post from Walker

`node cli/aurora.ts pick` lists what is worth reading in Walker (or fuzzel, wofi, rofi, or fzf in
a terminal). Type a few letters, press Enter, and the post opens in your browser and is marked
read in Aurora. `--saved` and `--later` offer Saved and Read later instead, `--profile work` picks
a profile, and `--print` only prints the rows. `AURORA_MENU` sets any other dmenu-style launcher,
run through `sh`, for example `AURORA_MENU="walker --dmenu"`.

The rows are plain text with terminal controls removed, and the choice is read back by the number
at the start of the row, so a post cannot steer the launcher or pick a different post.
`integrations/omarchy/bindings.lua` has a `SUPER + ALT + P` binding to copy if you want one.

## Match my desktop

On Omarchy, Look & themes offers a **Desktop** theme built from the active Omarchy theme
(`~/.local/state/omarchy/current/theme/colors.toml`). Aurora watches that folder, so running
`omarchy-theme-set` (or picking a theme from the Omarchy menu) recolours open Aurora windows
within a second, including light and dark. Aurora only reads the colour file and the theme name.
This is off when `SR_CLOUD=1`. Set `OMARCHY_STATE_DIR` to point it somewhere else.
