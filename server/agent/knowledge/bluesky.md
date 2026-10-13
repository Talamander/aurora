# Bluesky
Status 2026-10-12: works — `public.api.bsky.app` getAuthorFeed returned 200 with full post JSON, no auth. Best tier: api.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

Note: Aurora already ships a built-in Bluesky connector (`server/connectors/bluesky.ts`). Prefer
the built-in "add feed" path; only write an actor for something it does not cover (custom feeds,
lists, likes, search).

## Identify & resolve
- Hosts: `bsky.app`, `*.bsky.social` handles, any custom-domain handle (e.g. `@nytimes.com`), `at://` URIs, `did:plc:` / `did:web:`.
- URL forms: `https://bsky.app/profile/<handle-or-did>`, `.../profile/<h>/post/<rkey>`, `.../profile/<h>/feed/<rkey>` (custom feed), `.../profile/<h>/lists/<rkey>`.
- Handle to DID [LIVE]: `GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app` gives `{"did":"did:plc:z72i7hdynmk6r22z27h6tvur"}`. Most endpoints accept a handle as `actor` directly, so resolution is optional. Store the DID: handles can change, DIDs do not.

## Primary technique
- [LIVE] `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle|did>&limit=50&filter=posts_no_replies`
  - `filter`: `posts_with_replies` | `posts_no_replies` | `posts_with_media` | `posts_and_author_threads` | `posts_with_video`.
  - `posts_no_replies` still includes reposts (feed rows with `reason.$type == app.bsky.feed.defs#reasonRepost`). Drop or tag them as `kind: "repost"`.
  - Paging: response `cursor` (an ISO timestamp string); pass `&cursor=`.
- Profile: `app.bsky.actor.getProfile?actor=` gives displayName, avatar, banner, counts. [DOCS]
- Custom feed: `app.bsky.feed.getFeed?feed=at://<did>/app.bsky.feed.generator/<rkey>` (public). List: `app.bsky.feed.getListFeed?list=at://...`. [DOCS]
- Follows list is PUBLIC: `app.bsky.graph.getFollows?actor=<h>&limit=100` (cursor paging). So "follow everyone @me follows" needs no login. [DOCS]
- RSS [LIVE]: `https://bsky.app/profile/<handle>/rss` gives a 302 to `/profile/<did>/rss`, then RSS 2.0 with text only, no media. Use it only as a fallback.

## Response shape (getAuthorFeed, [LIVE])
`feed[]` with each row `{post, reason?, reply?}`:
- id: `post.uri` (`at://did/app.bsky.feed.post/<rkey>`). Permalink: `https://bsky.app/profile/<post.author.handle>/post/<rkey>`.
- text: `post.record.text`. Links and mentions sit in `post.record.facets[]` (byte offsets into UTF-8).
- time: `post.record.createdAt` (author clock). `post.indexedAt` is server time.
- author: `post.author.{did,handle,displayName,avatar}`.
- metrics: `post.{likeCount,repostCount,replyCount,quoteCount,bookmarkCount}`.
- media in `post.embed` (the hydrated `#view` form; do not read `record.embed`, which has only blob refs):
  - `app.bsky.embed.images#view`: `images[].{fullsize,thumb,alt,aspectRatio}`.
  - `app.bsky.embed.video#view`: `{playlist (HLS .m3u8), thumbnail, alt}`.
  - `app.bsky.embed.external#view`: `external.{uri,title,description,thumb}` (link card).
  - `app.bsky.embed.record#view`: quote post in `record.{uri,author,value.text,embeds}`.
  - `app.bsky.embed.recordWithMedia#view`: `{record, media}`.
- repost: `reason.by` is the reposter.

## Hosts to declare
`public.api.bsky.app`, `bsky.app` (RSS only), `cdn.bsky.app` (images and avatars), `video.bsky.app` (HLS and thumbs).

## Limits & politeness
AppView limit is roughly 3000 requests per 5 minutes per IP [MEM]. Hourly polling with `limit=30` is trivial.
Use `cursor` only for backfill. Stop when you reach a `post.uri` already in `sr.state`.

## Failure signatures
- `400 {"error":"InvalidRequest","message":"Profile not found"}` for a bad handle [MEM].
- Blocked or deactivated accounts give `400` with `error` set to `BlockedActor` or `AccountDeactivated`.
- Some accounts set a "logged-out visibility" label (`!no-unauthenticated`). The bsky.app web UI hides them. The public API still returns posts [MEM]; respect that label and skip those accounts.

## Fallbacks (in order)
1. getAuthorFeed (above).
2. `bsky.app/profile/<did>/rss`.
3. Read the PDS directly: `com.atproto.repo.listRecords?repo=<did>&collection=app.bsky.feed.post` on the user's PDS (find it via `https://plc.directory/<did>` `service[0].serviceEndpoint`). This returns raw records with no hydrated media URLs.

## Signed-in tier
The home timeline (`app.bsky.feed.getTimeline`) needs auth. Use an app password the user types into the app (`com.atproto.server.createSession` on `bsky.social`), not a browser. Usually you do not need it: build the follow list from public getFollows and fetch each author feed.

## Apify hints
Apify Bluesky actors call the same public XRPC endpoints. Nothing special.

## Sketch
```python
import sr
API = "https://public.api.bsky.app/xrpc/"
actor = sr.input["handle"].lstrip("@")
r = sr.fetch(API + f"app.bsky.feed.getAuthorFeed?actor={actor}&limit=40&filter=posts_no_replies")
if r.status != 200: raise SystemExit(f"bsky {r.status}: {r.text[:200]}")
seen = set(sr.state.get("seen", []))
for row in r.json()["feed"]:
    p = row["post"]; a = p["author"]; rkey = p["uri"].rsplit("/", 1)[1]
    media, e = [], p.get("embed") or {}
    e = e.get("media", e)  # recordWithMedia
    for im in e.get("images", []): media.append({"type": "image", "url": im["fullsize"], "thumb": im["thumb"], "alt": im.get("alt")})
    if e.get("playlist"): media.append({"type": "video", "url": e["playlist"], "thumb": e.get("thumbnail")})
    sr.emit({"id": p["uri"], "url": f"https://bsky.app/profile/{a['handle']}/post/{rkey}",
             "author": {"name": a.get("displayName") or a["handle"], "handle": a["handle"],
                        "url": f"https://bsky.app/profile/{a['handle']}", "avatar": a.get("avatar")},
             "text": p["record"].get("text", ""), "publishedAt": p["record"]["createdAt"], "media": media,
             "kind": "repost" if row.get("reason") else "post",
             "metrics": {k: p.get(k) for k in ("likeCount", "repostCount", "replyCount", "quoteCount")}})
    seen.add(p["uri"])
sr.save_state({"seen": list(seen)[-500:]})
```
