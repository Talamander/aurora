# SoundCloud
Status 2026-10-12: works (http) — profile HTML hydration gives user id + anonymous `client_id`; `api-v2.soundcloud.com/users/{id}/tracks?client_id=…` returned 200 JSON. The per-user RSS feed exists but was EMPTY (0 items) for a music artist. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
Hosts `soundcloud.com`, `m.soundcloud.com`, `on.soundcloud.com` (short link, follow redirect). Profile `soundcloud.com/{permalink}`; track `soundcloud.com/{user}/{track}`; set `/{user}/sets/{name}`.
[LIVE] GET `https://soundcloud.com/flume` (200, 114 KB): `window.__sc_hydration = [...];` array of `{hydratable, data}`:
- `hydratable=="user"` → `data{id: 2976616, permalink, username, avatar_url, track_count}`.
- `hydratable=="apiClient"` → `data{id: <32-char client_id>, isExpiring:false}` ← the anonymous web client_id; no need to scan JS bundles. Also appears as `soundcloud://users:{id}` in HTML.
Alternative resolve: `https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/flume&client_id=…` [MEM].

## Primary technique
GET `https://api-v2.soundcloud.com/users/{id}/tracks?client_id={cid}&limit=20&linked_partitioning=1` with desktop UA + `Origin: https://soundcloud.com` [LIVE 200]. Reposts+tracks stream: `https://api-v2.soundcloud.com/stream/users/{id}?client_id=…&limit=20` [MEM]. Playlists: `/users/{id}/playlists_without_albums` [MEM]. Re-scrape the client_id from the profile page each run (it rotates).

## Response shape
`{collection[], next_href, query_urn}`. Track: `id, kind("track"), title, description, permalink_url, created_at (upload, ISO Z), display_date (release date, ISO Z — use for publishedAt), duration (ms), playback_count, likes_count, reposts_count, comment_count, artwork_url (i1.sndcdn.com …-large.jpg; swap "-large" for "-t500x500"), genre, user{username, permalink, avatar_url}`.

## RSS (podcasters)
`https://feeds.soundcloud.com/users/soundcloud:users:{id}/sounds.rss` [LIVE] — returns a valid but empty channel for accounts that didn't enable RSS (typical for musicians); works for podcast accounts. Try it first only for podcast-type sources.

## Hosts to declare
`soundcloud.com`, `api-v2.soundcloud.com`, `feeds.soundcloud.com`, `i1.sndcdn.com` (or `*.sndcdn.com`).

## Limits & politeness
2 requests per profile per run. Unknown hard limit; 429 has been reported for bulk use [MEM].

## Failure signatures
401/403 from api-v2 = stale client_id → re-fetch profile page once. 404 = bad id. Empty `collection` = no public tracks.

## Fallbacks
1. api-v2 → 2. `yt-dlp --flat-playlist -J https://soundcloud.com/{user}/tracks` (`soundcloud:user`) [MEM] → 3. `sr.browser` capture `api-v2.soundcloud.com`.

## Signed-in tier
Home stream: logged-in `https://soundcloud.com/feed` calls `api-v2.soundcloud.com/stream?…` with OAuth header [MEM]; following list `/me/followings` [MEM]. Prefer converting followings to per-user sources.

## Sketch
```python
import re, json, sr
perma = sr.input["user"].rstrip("/").split("/")[-1]
h = sr.fetch(f"https://soundcloud.com/{perma}").text
hyd = {x["hydratable"]: x["data"] for x in json.loads(re.search(r"window\.__sc_hydration = (\[.*?\]);</script>", h).group(1))}
uid, cid, u = hyd["user"]["id"], hyd["apiClient"]["id"], hyd["user"]
r = sr.fetch(f"https://api-v2.soundcloud.com/users/{uid}/tracks?client_id={cid}&limit=20&linked_partitioning=1",
             headers={"Origin": "https://soundcloud.com"})
for t in r.json()["collection"]:
    art = (t.get("artwork_url") or u.get("avatar_url") or "").replace("-large", "-t500x500")
    sr.emit({"id": str(t["id"]), "url": t["permalink_url"], "title": t["title"], "text": t.get("description"),
             "publishedAt": t.get("display_date") or t["created_at"], "kind": "audio",
             "author": {"name": u["username"], "handle": perma, "url": f"https://soundcloud.com/{perma}", "avatar": u.get("avatar_url")},
             "media": [{"type": "image", "url": art}], "metrics": {"plays": t.get("playback_count"), "likes": t.get("likes_count")}})
```
