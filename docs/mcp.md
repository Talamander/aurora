# Using your library from other tools

Aurora can hand your filtered library to other software in three ways: as an MCP server
for AI tools, as RSS and JSON feeds for feed readers, and as a local media archive for posts you
save. None of these write anything to any platform.

## MCP server

`npm run mcp` starts a stdio MCP server that Claude Code, Claude Desktop, Cursor and other MCP
clients can attach to. It reads the same library as the app (`SOCIAL_READER_DATA`, default
`./data`). The app does not need to be running.

By default the server is read-only: it opens the SQLite file in read-only mode, so nothing can
change. Start it with `--allow-local-writes` to add two tools that change local reading state
only (saved, read). An app window that is already open shows those changes on its next library
load.

### Tools

| Tool | What it does |
|---|---|
| `search_posts` | Search with the app's query syntax (`"phrase"`, `-word`, `from:name`, `site:host`), plus shortcuts for platforms, sources, authors, `since_hours`, saved only, unread only, and a full `filters` object |
| `get_post` | One post in full: text, links, media URLs, quoted post, metrics, local state |
| `list_sources` | Followed sources with ids, platform, status and post counts |
| `list_views` | Saved views and page feed blocks |
| `run_view` | Posts in a saved view, a page feed block, or an ad-hoc filter spec, as the app shows them |
| `digest_since` | What arrived in the last N hours, grouped by source, one line per post with its URL |
| `set_saved` | Only with `--allow-local-writes`. Save or unsave posts locally |
| `set_read` | Only with `--allow-local-writes`. Mark posts read or unread locally |

Post text, author names and source names come from other people. Every tool result wraps that
content in an `<untrusted-content boundary="...">` block, with a random boundary and a note
telling the model to treat it as data and not as instructions.

### Claude Code

From the project directory:

```bash
claude mcp add social-reader -- node /path/to/social-reader/server/mcp.ts
```

To use a library somewhere other than `./data`:

```bash
claude mcp add social-reader -e SOCIAL_READER_DATA=/path/to/data -- node /path/to/social-reader/server/mcp.ts
```

Or put this in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "social-reader": {
      "command": "node",
      "args": ["/path/to/social-reader/server/mcp.ts"],
      "env": { "SOCIAL_READER_DATA": "/path/to/social-reader/data" }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "social-reader": {
      "command": "node",
      "args": ["/path/to/social-reader/server/mcp.ts"],
      "env": { "SOCIAL_READER_DATA": "/path/to/social-reader/data" }
    }
  }
}
```

Use the full path to a Node 26 binary for `command` if Claude Desktop does not find the right
`node` on its own. To allow local saves and read marks, add `"--allow-local-writes"` after the
script path in `args`.

### Cursor

Cursor reads the same `mcpServers` shape from `~/.cursor/mcp.json` or a project's
`.cursor/mcp.json`.

## RSS and JSON feeds

Every saved view, every feed, gallery or people block on a page, and the whole library are
available as RSS 2.0 and JSON Feed 1.1:

| Feed | RSS | JSON Feed |
|---|---|---|
| Everything | `/api/feeds/all.xml` | `/api/feeds/all.json` |
| A saved view | `/api/feeds/view/<viewId>.xml` | `/api/feeds/view/<viewId>.json` |
| A page block | `/api/feeds/page/<pageId>/<blockIndex>.xml` | `/api/feeds/page/<pageId>/<blockIndex>.json` |

`GET /api/feeds` lists every available feed with its full URLs. Add `?limit=N` (up to 200,
default 50, or the block's own limit) to change the number of posts. Feeds apply the same
filters as the app, including duplicate and archived handling.

Post text is escaped, control characters that XML forbids are removed, and only `http(s)` links
appear in a feed.

### Feed token for remote readers

The server binds to 127.0.0.1, so by default only this computer can read the feeds. To follow
them from another device through a reverse proxy, first create a feed token:

```bash
curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:4317/api/feeds/token
```

The response shows the token once. Add it to every feed URL as `?token=<token>`. Run the same
call again to replace it, or send `{"action":"clear"}` to remove it. While a token is set,
every feed request needs it, local ones included. While no token is set, a feed request that
arrives through a proxy (it carries `X-Forwarded-For`, `Forwarded` or `X-Real-IP`) is refused.

Proxy only `/api/feeds/`. The rest of the API has no authentication. The app answers only to
local `Host` names, so the proxy must send `Host: 127.0.0.1:4317`. For example, with nginx:

```nginx
location /api/feeds/ {
    proxy_pass http://127.0.0.1:4317;
    proxy_set_header Host 127.0.0.1:4317;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

To make the links inside the feeds point at your public address, set a base URL:

```bash
curl -X PUT -H 'content-type: application/json' -d '{"baseUrl":"https://reader.example.org"}' http://127.0.0.1:4317/api/feeds/settings
```

## Media archive for saved posts

When `archive.saved` is on, saving a post also stores its pictures and video on this computer,
so the saved post survives if the original is deleted. It is off by default.

```bash
curl http://127.0.0.1:4317/api/archive/settings                  # {"saved":false,"ytDlp":true}
curl -X PUT -H 'content-type: application/json' -d '{"saved":true}' http://127.0.0.1:4317/api/archive/settings
```

- Images are fetched with the app's guarded fetcher (public addresses only, 25 MB each, up to
  20 per post) and kept only if their bytes are JPEG, PNG, GIF, WebP or AVIF.
- Videos are fetched with `yt-dlp` (from `YT_DLP`, default `/usr/bin/yt-dlp`), at most 720p and
  500 MB, with a 10 minute limit. yt-dlp ignores your yt-dlp config files and plugins, and its
  traffic goes through a loopback proxy that only reaches public addresses over HTTPS.
- Files live in `<data>/archive/<item>/` with a `manifest.json`. Unsaving a post keeps its
  archive. Nothing deletes archived files.

`GET /api/archive/<itemId>` shows an item's archive and file URLs. `POST /api/archive/<itemId>`
archives one item now, whatever the setting. Files are served from
`/api/archive/<itemId>/<file>` with a fixed content type, `nosniff` and a sandbox policy.
