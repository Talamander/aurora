# Twitch
Status 2026-10-12: works (api-ish) — `gql.twitch.tv/gql` with the public web Client-Id answered an ad-hoc query (user, live stream, VODs, clips) with 200 and full data, no login. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
Hosts `www.twitch.tv`, `twitch.tv`, `m.twitch.tv`, `clips.twitch.tv`. Channel login = first path segment (`twitch.tv/lirik`, `/lirik/videos`, `/lirik/clip/<slug>`). Login is enough for GQL; numeric id comes back as `user.id`.

## Primary technique
POST `https://gql.twitch.tv/gql`, headers `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko` (the twitch.tv web app's public id, used by yt-dlp/streamlink), `Content-Type: text/plain;charset=UTF-8`, desktop UA. Body (array allowed) [LIVE]:
```
[{"query":"query{user(login:\"lirik\"){id login displayName profileImageURL(width:150) stream{id title type createdAt viewersCount game{name}} videos(first:10,sort:TIME){edges{node{id title publishedAt lengthSeconds viewCount previewThumbnailURL(width:320,height:180) broadcastType game{name}}}} clips(first:10,criteria:{period:LAST_WEEK,sort:VIEWS_DESC}){edges{node{id slug title createdAt viewCount url thumbnailURL}}}}}"}]
```
Official Helix API (`api.twitch.tv/helix/videos?user_id=`) is free but needs a registered app's client-credentials token — use only if the user supplies one.

## Response shape
`[0].data.user{id, login, displayName, profileImageURL}`; live: `stream` (null when offline; else `{id,title,createdAt,viewersCount,game.name}`); VODs `videos.edges[].node{id,title,publishedAt(ISO Z),lengthSeconds,viewCount,previewThumbnailURL,broadcastType(ARCHIVE|HIGHLIGHT|UPLOAD)}`; clips `clips.edges[].node{id,slug,title,createdAt,viewCount,url,thumbnailURL}`.
Permalinks: VOD `https://www.twitch.tv/videos/{id}`; clip `node.url`; live `https://www.twitch.tv/{login}` (emit a "live now" item keyed `live:{stream.id}`).

## Hosts to declare
`gql.twitch.tv`, `www.twitch.tv`, `static-cdn.jtvnw.net` (avatars, VOD and clip thumbs).

## Limits & politeness
One POST per channel per run covers everything. Unpublished limits; keep hourly.

## Failure signatures
`{"error":"Bad Request","status":400,"message":"The \"Client-ID\" header is invalid."}` if the id rotates [MEM]; `errors[].message` e.g. "failed integrity check" for some mutations/persisted ops (not seen for these reads) [MEM]; `user: null` = unknown/banned login.

## Fallbacks (in order)
1. GQL above → 2. `yt-dlp --flat-playlist -J "https://www.twitch.tv/{login}/videos?filter=archives&sort=time"` (extractor `twitch:videos`) [MEM] → 3. `sr.browser("https://www.twitch.tv/{login}/videos", capture=r"gql\.twitch\.tv")` and read captured GQL bodies.

## Signed-in tier
User logs in in app profile; `https://www.twitch.tv/directory/following/channels` page triggers GQL ops listing followed channels (capture `gql.twitch.tv`, look for `follows.edges[].node.login`) [MEM]. Convert to per-channel sources.

## Apify hints
Popular Twitch actors also hit `gql.twitch.tv` with the web Client-Id [MEM].

## Sketch
```python
import json, sr
login = sr.input["channel"].rstrip("/").split("/")[-1].lower()
q = ('query{user(login:"%s"){id login displayName profileImageURL(width:150) stream{id title createdAt viewersCount game{name}} '
     'videos(first:10,sort:TIME){edges{node{id title publishedAt lengthSeconds viewCount previewThumbnailURL(width:640,height:360) broadcastType}}}}}') % login
r = sr.fetch("https://gql.twitch.tv/gql", method="POST", body=json.dumps([{"query": q}]),
             headers={"Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "text/plain;charset=UTF-8"})
u = r.json()[0]["data"]["user"]
author = {"name": u["displayName"], "handle": u["login"], "url": f"https://www.twitch.tv/{u['login']}", "avatar": u["profileImageURL"]}
if u["stream"]:
    s = u["stream"]; sr.emit({"id": f"live:{s['id']}", "url": author["url"], "author": author, "title": s["title"], "publishedAt": s["createdAt"], "kind": "live"})
for e in u["videos"]["edges"]:
    n = e["node"]
    sr.emit({"id": n["id"], "url": f"https://www.twitch.tv/videos/{n['id']}", "author": author, "title": n["title"],
             "publishedAt": n["publishedAt"], "kind": "video", "metrics": {"views": n["viewCount"]},
             "media": [{"type": "video", "url": f"https://www.twitch.tv/videos/{n['id']}", "thumb": n["previewThumbnailURL"]}]})
```
