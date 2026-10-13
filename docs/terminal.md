# Aurora in the terminal

`cli/` holds a keyboard-driven terminal client for Aurora. It talks to the same
local API as the web app, reads your library with the same filter and profile
engine, and never writes to any social platform.

It has no dependencies beyond Node itself: raw ANSI output, `node:readline`
keypress events, and Node's native TypeScript support.

## Running it

Start Aurora as usual (`npm start`), then in another terminal:

```sh
npm run tui
# or, after `npm link` / a global install:
aurora
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--url <url>` | API base URL. Default `http://127.0.0.1:4317`. |
| `--profile <id>` | Start in this profile instead of the app's active one. |
| `--view <id>` | Start in this view: `worth`, `saved`, `everything`, `archive` or a saved view id. |
| `--allow-remote` | Allow a non-loopback host. See below. |
| `--help` | Print usage. |

Environment:

- `AURORA_URL`: same as `--url`.
- `AURORA_PROFILE`: same as `--profile`.
- `NO_COLOR`: disable all colour.
- `FORCE_COLOR`, `COLORTERM`, `TERM`, `TERM_PROGRAM`: used to pick truecolor, 256-colour or no colour.
- `BROWSER`: command used by `o` to open the original post. Falls back to `xdg-open` (Linux), `open` (macOS) or `rundll32 url.dll` (Windows).

The client needs an interactive terminal. If it cannot reach the API it exits
with a short message telling you to start Aurora.

## Keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move |
| `gg` / `G` | Top / bottom |
| `ctrl-d` / `ctrl-u` | Half page down / up |
| `Enter` or `l` | Read the selected post |
| `n` / `N` | Next / previous post while reading |
| `f` | Fetch the full article (long-form extraction) |
| `s` / `a` / `r` | Toggle saved, archived, read (local only) |
| `u` | Undo the last state change |
| `o` | Open the original link in your browser (http and https only) |
| `/` | Search: `"phrase"`, `-word`, `from:name` |
| `Esc` | Clear the search, close a pane or overlay |
| `v`, or `1`–`9` | Switch view |
| `p` | Switch profile |
| `.` | Ask your feed (the agent) |
| `ctrl-r` | Reload |
| `?` | Help |
| `q` | Quit |

At 110 columns or wider the list gets a live preview pane on the right. The
reader centres text at 84 columns and shows a progress rail. Long-form posts
(`kind: article`) are extracted automatically when opened; for any other post
with a link, `f` fetches the article on demand.

Opening a post marks it read. Read items stay visible until you change view or
search, so the list does not jump under you.

## Views, profiles and filters

The client loads `/api/library` (revalidated with an ETag, so reloads are cheap)
and filters on the client with the shared engine:

- `scopeLibrary` from `core/profiles.ts` narrows the library to the chosen profile.
- `applyFilters` from `core/filter.ts` applies the view's filter spec, including
  topics, source labels and the AI rules stored in the library.

The built-in views (Worth reading, Saved, Everything, Archive) mirror the web
app's definitions; custom views come from the library. Switching profile with
`p` only changes what the terminal shows. It does not change the app's active
profile.

## The agent

`.` opens an ask line. The question goes to `POST /api/agent/threads/:id/messages`
along with the current view, search, profile and selected post. The answer
streams back over the server-sent event stream at `/api/events`: text arrives
token by token, tool calls show as short status lines, and `[[post:ID]]`
citations render as the post's author and title. After an answer the ask line
stays open for a follow-up; `Esc` closes it, and a second `Esc` leaves the
conversation.

The header shows `● live` while the event stream is connected and reconnects
automatically if it drops.

## Safety

**Local only.** The client refuses any API host that is not loopback
(`localhost`, `127.0.0.0/8`, `::1`) unless you pass `--allow-remote`, and only
accepts `http:` and `https:` URLs. Use `--allow-remote` only for an Aurora
instance you run and trust.

**No platform writes.** Save, archive and read are local state changes sent to
`POST /api/items/state`. Nothing is liked, bookmarked or followed on a source
account. All writes send `content-type: application/json`, which the server's
CSRF check requires.

**Untrusted text is sanitized.** Every string that comes from a post, an article,
a source name or the agent passes through `cli/sanitize.ts` before it reaches the
terminal. It removes:

- CSI sequences (colours, cursor moves, screen clears),
- OSC, DCS, APC, PM and SOS strings (window titles, OSC 52 clipboard writes,
  OSC 8 hyperlinks), including their 8-bit C1 forms,
- remaining C0 and C1 control characters,
- bidirectional overrides and isolates, which can disguise text such as file
  names.

An unterminated OSC or DCS string loses only its introducer, so a malformed post
cannot swallow the rest of the screen. `tests/cli-sanitize.test.ts` covers
these cases, plus the loopback rules and the width helpers.

`o` only opens `http:` and `https:` links, and passes the URL as a single
argument to the browser command, never through a shell (on Windows it uses
`rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`, which would
interpret `&` in a URL).

**Terminal restore.** The client uses the alternate screen and hides the cursor.
It restores the terminal on quit, on `SIGTERM`/`SIGHUP`, and on an uncaught
exception or unhandled rejection, so a crash does not leave your shell in raw
mode.

## Colour

The palette follows the web app: amber, pink and violet accents on near-black.
Colour depth is detected in this order:

1. `NO_COLOR` set (and not empty), or `FORCE_COLOR=0`: no colour at all.
2. `COLORTERM=truecolor` or `24bit`, or a terminal known to support it
   (kitty, ghostty, alacritty, foot, WezTerm, `*-direct`): 24-bit colour.
3. Output is not a terminal and `FORCE_COLOR` is unset, or `TERM=dumb`: no colour.
4. Anything else: colours mapped to the nearest xterm-256 entry.

Frames are drawn with synchronized output (`CSI ? 2026 h/l`) where supported,
so redraws do not flicker. Resizing the window (`SIGWINCH`) reflows the layout
immediately.

## Files

- `cli/aurora.ts`: entry point, flags, startup checks.
- `cli/tui.ts`: modes, rendering, keys, event stream.
- `cli/api.ts`: HTTP client, loopback check, SSE parser.
- `cli/term.ts`: colour depth, palette, display width, wrapping.
- `cli/sanitize.ts`: escape and control sequence stripping.
