# Kick
Status 2026-10-12: works (http) — `kick.com/api/v2/channels/{slug}`, `/videos`, `/clips` returned 200 JSON with plain curl (no Cloudflare challenge today). Official `api.kick.com/public/v1` needs an OAuth app token (401 "Unauthorized"). Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
Hosts `kick.com`, `www.kick.com`. Channel slug = first path segment (`kick.com/xqc`, `/xqc/videos/<uuid>`, `/xqc/clips/<clip_id>`). Slug is all you need.

## Primary technique
Headers: desktop UA, `Accept: application/json`. [LIVE]
- Channel + live status: `https://kick.com/api/v2/channels/{slug}` (8 KB; v1 same path is 91 KB and also includes previous livestreams).
- VODs (past broadcasts; includes the current live one with `is_live:true`): `https://kick.com/api/v2/channels/{slug}/videos` (JSON array).
- Clips: `https://kick.com/api/v2/channels/{slug}/clips?sort=date&time=all` → `{clips:[…], nextCursor}`.

## Response shape
- Channel: `id, slug, followers_count, verified, user{username, profile_pic, bio}, livestream` (null or `{id, session_title, created_at, viewer_count, thumbnail.url}`).
- Video item: `id` (livestream id), `session_title`, `created_at` ("2026-10-12 19:30:38", UTC, no zone — append Z), `is_live`, `duration` (ms; 0 while live), `views`/`viewer_count`, `thumbnail{src, srcset}` (images.kick.com webp), `video{uuid, created_at ISO Z, views, status}`, `categories[].name`, `language`.
- Clip: `id ("clip_…"), title, created_at, clip_url (m3u8), thumbnail_url, views, duration, channel, creator`.
- Permalinks: VOD `https://kick.com/{slug}/videos/{video.uuid}`; clip `https://kick.com/{slug}/clips/{id}`; live `https://kick.com/{slug}`.

## Hosts to declare
`kick.com`, `images.kick.com`, `files.kick.com` (avatars), `clips.kick.com`.

## Limits & politeness
Cloudflare fronts the site; historically it 403-challenged scripted clients in waves [MEM]. 2 requests per channel per hour max.

## Failure signatures
HTTP 403 with HTML "Just a moment..." (Cloudflare managed challenge) → do not evade; switch to `sr.browser("https://kick.com/{slug}/videos", capture=r"/api/v2/channels/")`. 404 `{"message":"Channel not found"}` [MEM].

## Fallbacks (in order)
1. api/v2 JSON → 2. `sr.browser` capture of the same calls → 3. yt-dlp `kick:vod`/`kick:clips` extractors exist for single items [MEM]. Official public API only if the user registers a free app and provides client id/secret.

## Signed-in tier
Followed channels: logged-in page `https://kick.com/following` calls `/api/v2/channels/followed` [MEM]. Convert to per-channel sources.

## Sketch
```python
import sr
slug = sr.input["channel"].rstrip("/").split("/")[-1].lower()
H = {"Accept": "application/json"}
ch = sr.fetch(f"https://kick.com/api/v2/channels/{slug}", headers=H).json()
author = {"name": ch["user"]["username"], "handle": slug, "url": f"https://kick.com/{slug}", "avatar": ch["user"].get("profile_pic")}
for v in sr.fetch(f"https://kick.com/api/v2/channels/{slug}/videos", headers=H).json()[:15]:
    uuid = (v.get("video") or {}).get("uuid")
    url = f"https://kick.com/{slug}/videos/{uuid}" if uuid and not v["is_live"] else author["url"]
    sr.emit({"id": str(v["id"]), "url": url, "author": author, "title": v["session_title"],
             "publishedAt": v["created_at"].replace(" ", "T") + "Z", "kind": "live" if v["is_live"] else "video",
             "metrics": {"views": v.get("views")},
             "media": [{"type": "video", "url": url, "thumb": (v.get("thumbnail") or {}).get("src")}]})
```
