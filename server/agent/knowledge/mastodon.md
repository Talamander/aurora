# Mastodon and the Fediverse (Mastodon, Lemmy, compatible servers)
Status 2026-10-12: works — mastodon.social `/api/v1/accounts/lookup` and `/statuses` returned 200 with no auth. Lemmy `/api/v3/post/list` returned 200. Best tier: api.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Handles look like `@user@instance.tld`. URLs look like `https://<instance>/@user`, `https://<instance>/@user/<statusId>` or `https://<instance>/users/user`.
- Any hostname can be a Mastodon server. To confirm, check `GET https://<host>/api/v2/instance` (200 JSON with `version`) or `/.well-known/nodeinfo`. Glitch, Hometown, Pleroma/Akkoma, GoToSocial and Iceshrimp implement most of `/api/v1`. Misskey and Sharkey do not; use their RSS (`/@user.rss`) instead.
- Account id [LIVE]: `GET https://<home-instance>/api/v1/accounts/lookup?acct=Gargron` gives `{"id":"1","acct":"Gargron","url":...,"avatar":...}`. Always query the account's HOME instance. Another instance's copy is incomplete; it only holds what federated there.
- WebFinger [LIVE]: `/.well-known/webfinger?resource=acct:user@host` returns the profile URL and the ActivityPub actor URL.

## Primary technique (Mastodon)
- [LIVE] `GET https://<instance>/api/v1/accounts/<id>/statuses?limit=40&exclude_replies=true` (optional `&exclude_reblogs=true`, `&only_media=true`, `&pinned=true`).
- Paging uses the `Link` header [LIVE]: `rel="next"` has `max_id=`. For incremental polling, pass `min_id=<last seen id>` (ids sort as snowflakes).
- RSS [LIVE]: `https://<instance>/@user.rss` returns 200 `application/rss+xml` with media as `media:content`. Use it for Misskey and as a fallback.
- Hashtag: `/api/v1/timelines/tag/<tag>?limit=40`. Some servers disable public timeline previews for logged-out users.

## Response shape (status JSON, [LIVE])
- id: `id`. Permalink: `url` (the HTML page). `uri` is the ActivityPub id.
- For a reblog, `reblog` holds the original status, and the outer `url` points to `/activity`. Use `reblog.url`, `reblog.content` and `reblog.account`, and set `kind: "repost"`.
- text: `content` is HTML. Convert it with `sr.html_to_text`. `spoiler_text` is a content warning; prefix it to the text.
- time: `created_at` (ISO). `edited_at` may be set.
- author: `account.{display_name,acct,url,avatar}`.
- media: `media_attachments[].{type (image|video|gifv|audio), url, preview_url, description}`. Link card: `card.{url,title,image}`. Quote: `quote` (Mastodon 4.5+). Poll: `poll`.
- metrics: `replies_count`, `reblogs_count`, `favourites_count`, `quotes_count`.

## Lemmy (link aggregator, also Fediverse)
- URLs: `https://<instance>/c/<community>`, `/u/<user>`, `/post/<id>`. Remote names look like `community@instance`.
- [LIVE] `GET https://lemmy.world/api/v3/post/list?community_name=technology&sort=New&limit=20` returns `{posts:[{post,creator,community,counts,...}], next_page}`. Paginate with `&page_cursor=<next_page>`.
- [LIVE] User: `/api/v3/user?username=dessalines@lemmy.ml&sort=New&limit=20` returns `posts[]` and `comments[]`.
- Fields: `post.{id,name (title),url (external link),body (markdown),thumbnail_url,published,ap_id (canonical URL)}`, `creator.{name,display_name,avatar,actor_id}`, `counts.{score,comments}`.
- RSS [LIVE]: `https://<instance>/feeds/c/<community>.xml?sort=New` and `/feeds/u/<user>.xml`.
- Versions: lemmy.world runs 0.19.19 today. `/api/v4` returned 404 on lemmy.ml [LIVE]. Lemmy 1.0 moves to `/api/v4`, so probe v3 first and fall back to v4.

## Hosts to declare
- The instance host, plus its media host. The media host varies by instance: mastodon.social uses `files.mastodon.social`, and many others use `cdn.masto.host`, S3 or a CDN.
- One actor should serve every instance: take the account as `@user@host` (or the profile URL) in an input field such as `acct`, and set `"hostsFromInput": ["acct"]` in the manifest. Each run then may reach that instance and its subdomains (e.g. `files.mastodon.social`). The actor only needs to fetch the API; media URLs are emitted, not downloaded, so off-domain media hosts (`cdn.masto.host`, S3) do not need declaring.
- Lemmy: the instance host plus `*.pictrs` image host (usually the instance itself under `/pictrs/`). External thumbnails can come from any host.

## Limits & politeness
- Mastodon sends `x-ratelimit-limit: 300` per 5 minutes per IP for anonymous requests, with `x-ratelimit-remaining` and `x-ratelimit-reset` [LIVE].
- Lemmy: no published limit. Stay under 1 request per second.
- Small instances run on donations. Poll hourly at most.

## Failure signatures
- `401 {"error":"This API requires an authenticated user"}`: the instance sets `DISALLOW_UNAUTHENTICATED_API_ACCESS` or "limited federation mode". Use `@user.rss`, which still often works.
- `404 {"error":"Record not found"}`: wrong acct, or you queried a non-home instance for a remote account.
- `410`: account suspended or deleted.
- `429` comes with the rate-limit headers.

## Fallbacks (in order)
1. Mastodon REST on the home instance.
2. `@user.rss`.
3. ActivityPub outbox: `GET <actor>/outbox?page=true` with `Accept: application/activity+json`. This fails when the server requires signed fetches (authorized fetch).

## Signed-in tier
- The following list is usually public: `/api/v1/accounts/<id>/following?limit=80` (Link paging), unless the user hides their social graph.
- The home timeline needs an OAuth token from the user's own instance (`/api/v1/timelines/home`). That is an app-level login, not scraping. Usually you do not need it: fetch each followed account instead.

## Apify hints
Apify actors mostly scrape the public API as above. No special trick.

## Sketch
```python
import sr
user, host = sr.input["acct"].lstrip("@").split("@")
acct = sr.fetch(f"https://{host}/api/v1/accounts/lookup?acct={user}").json()
q = f"https://{host}/api/v1/accounts/{acct['id']}/statuses?limit=40&exclude_replies=true"
if sr.state.get("min_id"): q += f"&min_id={sr.state['min_id']}"
r = sr.fetch(q)
if r.status == 401: raise SystemExit("instance blocks anonymous API; use https://%s/@%s.rss" % (host, user))
rows = r.json()
for s in rows:
    o = s["reblog"] or s; a = o["account"]
    sr.emit({"id": f"{host}:{s['id']}", "url": o["url"],
             "author": {"name": a["display_name"] or a["acct"], "handle": a["acct"], "url": a["url"], "avatar": a["avatar"]},
             "text": (o["spoiler_text"] + "\n\n" if o["spoiler_text"] else "") + sr.html_to_text(o["content"]),
             "publishedAt": o["created_at"], "kind": "repost" if s["reblog"] else "post",
             "media": [{"type": "video" if m["type"] in ("video", "gifv") else m["type"], "url": m["url"], "thumb": m["preview_url"]}
                       for m in o["media_attachments"]],
             "metrics": {"replies": o["replies_count"], "reblogs": o["reblogs_count"], "favourites": o["favourites_count"]}})
if rows: sr.save_state({"min_id": max(rows, key=lambda s: int(s["id"]))["id"]})
```
