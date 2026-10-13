# Writing a Aurora actor

An actor is a small program that reads one public source (a profile, a channel, a search)
and emits its recent posts. It runs in a sandbox with no direct network. Every request goes
through the host's egress proxy, which only lets through the hosts the manifest declares.

## Files

```
actor.json   the manifest
main.py      Python actor (runtime "python"), or
main.ts      Node actor (runtime "node", TypeScript with type stripping)
```

## Manifest

```json
{
  "id": "bluesky-profile",
  "name": "Bluesky profile",
  "runtime": "python",
  "entry": "main.py",
  "platform": "bluesky",
  "description": "Recent posts from a public Bluesky profile.",
  "tier": "http",
  "hosts": ["public.api.bsky.app", "cdn.bsky.app"],
  "input": { "type": "object", "properties": { "handle": { "type": "string" } }, "required": ["handle"] },
  "python": { "requires": ["feedparser==6.0.11"] },
  "notes": "Uses app.bsky.feed.getAuthorFeed; no auth needed."
}
```

- `id`: lowercase slug, `^[a-z0-9][a-z0-9-]{1,60}$`.
- `runtime`: `python` or `node`. `entry` is `main.py` or `main.ts` to match.
- `platform`: label for the items (for example `instagram`, `youtube`, `bluesky`).
- `tier`: `api` (official JSON API), `http` (plain fetches of pages or endpoints), `browser`
  (needs `sr.browser`), `session` (needs the user's logged-in browser profile).
- `hosts`: every hostname the actor contacts, including API hosts, CDNs and redirect targets.
  `*.example.com` matches subdomains of example.com but not example.com itself, so list both
  when you need both. No IP addresses, no localhost. Only ports 80 and 443 work.
- `hostsFromInput`: optional list of input field names whose value names a site: a URL
  (`https://www.astralcodexten.com`), a hostname (`fosstodon.org`) or a fediverse handle
  (`@user@hachyderm.io`). Each run then also allows that host, its bare domain and its
  subdomains. Use it when one actor serves any instance or custom domain (Mastodon servers,
  Substack custom domains, a generic "read this site" actor) instead of hard-coding hosts.
  Fixed CDNs still go in `hosts`.
- `python.requires`: optional pip requirements, pinned (`pkg==1.2.3`). PEP 723 inline
  metadata in `main.py` works too. While dependencies are declared, pypi.org and
  files.pythonhosted.org are also allowed.
- `version`, `createdAt`, `updatedAt` are set by the host.

## Runtime protocol

The host passes the input JSON in env `SR_INPUT` and the state saved by the previous run in
`SR_STATE`. The actor prints JSON lines to stdout:

```
{"type":"item","item":{...RawPost}}
{"type":"state","state":{...}}
{"type":"log","msg":"..."}
{"type":"error","msg":"..."}
```

Other stdout lines and all stderr become logs. A non-zero exit or an `error` line fails the
run. Use the `sr` helpers rather than printing these yourself.

**RawPost** (only `id` and `url` are required):

```
{ id, url, author: { name, handle?, url?, avatar? }, text?, html?, title?,
  publishedAt?,            // ISO 8601 string, or unix seconds / milliseconds
  media?: [{ type: 'image'|'video', url, thumb?, alt? }],
  links?: [url], kind?: 'post'|'reply'|'repost'|'thread'|'article'|'video',
  quoted?: { author: { name, handle? }, text, url? },
  metrics?: { likes?, reposts?, replies? }, lang? }
```

`id` must be stable across runs (the platform's post id). `url` is the post's permalink.
Give `text` as plain text; if you have HTML, pass `html` and the host converts it. When both are given, the longer one becomes the post body, so a summary in `text` plus the full article in `html` keeps the full article.

## The `sr` helper

### Python

```python
import sr

handle = sr.input["handle"]
since = sr.state.get("newest")

r = sr.fetch(f"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor={handle}&limit=30")
if r.status != 200:
    raise SystemExit(f"feed request failed: {r.status}")
newest = since
for f in r.json()["feed"]:
    p = f["post"]
    if since and p["indexedAt"] <= since:
        break
    sr.emit({
        "id": p["uri"],
        "url": f"https://bsky.app/profile/{p['author']['handle']}/post/{p['uri'].rsplit('/', 1)[1]}",
        "author": {"name": p["author"].get("displayName") or handle, "handle": p["author"]["handle"]},
        "text": p["record"].get("text", ""),
        "publishedAt": p["record"].get("createdAt"),
    })
    newest = max(newest or "", p["indexedAt"])
sr.save_state({"newest": newest})
```

- `sr.input`, `sr.state`: dicts (empty when not given).
- `sr.emit(item)`: validates `id` and `url`, writes the item line.
- `sr.save_state(obj)`: the last call wins; it arrives as `sr.state` next run.
- `sr.log(msg)`.
- `sr.fetch(url, headers=None, method="GET", body=None, timeout=30)` returns a response with
  `.status`, `.ok`, `.url` (final, after redirects), `.headers` (lower-case keys), `.text`,
  `.content` (bytes) and `.json()`. It does not raise on HTTP errors; check `.status`. It
  raises `sr.FetchError` when the proxy blocks the host or the connection fails. `body` can
  be a dict (sent as JSON), str or bytes. Default headers are a desktop Chrome user agent and
  `Accept-Language: en-US`.
- `sr.browser(url, wait_ms=1500, scroll=0, capture=None)` renders the page in the host's
  Chromium and returns a dict: `url`, `status`, `title`, `html`, `text` (visible text),
  `links` (`[{href, text}]`), `json` (`[{url, status, contentType, body}]`, the JSON
  XHR/fetch responses the page made, or the responses whose URL matches the `capture` regex)
  and `blocked` (requests refused by the allowlist). The page can only load the manifest's
  hosts. Images, fonts and media are not loaded.
- `sr.html_to_text(html)`.

Standard `urllib` and libraries like `requests` and `yt-dlp` also work, because the proxy
environment variables are set. The cache for uv is kept between runs.

### Node

```ts
import * as sr from 'sr';

const r = await sr.fetch(`https://example.com/api/posts?user=${encodeURIComponent(sr.input.user)}`, {
  headers: { accept: 'application/json' },
});
for (const p of r.json().posts) sr.emit({ id: p.id, url: p.permalink, text: p.body, publishedAt: p.created });
sr.saveState({ newest: r.json().posts[0]?.id ?? sr.state.newest });
```

- Same API: `sr.input`, `sr.state`, `sr.emit`, `sr.saveState` (alias `save_state`),
  `sr.log`, `sr.htmlToText` (alias `html_to_text`).
- `await sr.fetch(url, { headers?, method?, body?, timeout? })`: `timeout` is in seconds;
  returns `{ status, ok, url, headers, text, json() }`. It throws when the proxy blocks the
  host.
- `await sr.browser(url, { waitMs?, scroll?, capture? })`.
- No npm packages are available. Use the global `fetch` (it goes through the proxy) and the
  Node standard library.

## Finding the data

Prefer, in this order: an official API or RSS/Atom feed; a JSON endpoint the site's own pages
call; JSON embedded in the HTML (`<script type="application/json">`, `__NEXT_DATA__`,
`ytInitialData`); parsing the HTML. Use `sr.browser` only when the data needs JavaScript to
appear, and use `capture` to keep just the endpoint you need.

## Rules

- Declare every host you contact, including CDNs. Undeclared hosts are blocked and the run
  log shows them.
- Read-only. Never post, like, follow, or change anything on the site.
- Be polite: one run should make a few requests. Use `sr.state` to remember the newest post
  and stop paging when you reach it. Do not loop over many pages on every run.
- Do not solve or bypass CAPTCHAs, do not add fingerprint or stealth tricks, and do not try
  to get around rate limits or blocks. If the site refuses, fail with a clear `error`.
- Do not ask for or handle passwords. Logged-in access only happens through the `session`
  tier, where the user logs in themselves in a window the host opens.
- Limits: 2 minutes by default (10 at most), 300 items, 20 MB of output, 1.5 GB of memory.
  The file system is read-only except `/tmp` (256 MB tmpfs). There is no access to the
  user's files.
