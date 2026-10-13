# Substack
Status 2026-10-12: works — `/feed` RSS returned 200 (20 items). `/api/v1/posts?limit=` returned 200 JSON with full metadata. `substack.com/api/v1/user/<handle>/public_profile` returned 200. Best tier: api (RSS or JSON).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts:
  - `<pub>.substack.com`;
  - custom domains (e.g. `www.astralcodexten.com`), detected by the `substackcdn.com` assets in the HTML or a working `/api/v1/archive`;
  - `substack.com/@<handle>` (a person's profile), `substack.com/home/post/p-<id>`, `open.substack.com/pub/<pub>/p/<slug>`.
- `<pub>.substack.com/*` gives a 301 to the custom domain when one exists [LIVE: astralcodexten.substack.com went to www.astralcodexten.com]. Follow redirects, then use the final host.
- Person to publication [LIVE]: `GET https://substack.com/api/v1/user/<handle>/public_profile`. It returns `{id, name, handle, photo_url, bio, primaryPublication:{subdomain, custom_domain,...}, publicationUsers[], subscriptions[]}`.
  - `subscriptions[]` is the person's public reading list, a free follow-list import.

## Primary technique
- RSS [LIVE]: `https://<host>/feed`. RSS 2.0, 20 items, `content:encoded` with full HTML for free posts and truncated HTML for paid ones. The built-in RSS connector handles it, so prefer "add feed" over an actor.
- JSON [LIVE]: `GET https://<host>/api/v1/posts?limit=20&offset=0`. It returns a list (not wrapped) of post objects with `body_html`. `GET https://<host>/api/v1/archive?sort=new&limit=20&offset=0` is a lighter variant without the body.
- Single post: `/api/v1/posts/<slug>`.
- Notes (short posts): `GET https://substack.com/api/v1/reader/feed/profile/<userId>` returned 200 with `items: []` for a user with no notes [LIVE, so the shape is unconfirmed]. Expect `items[].comment.{id,body,date}` and `nextCursor` [MEM]. Verify with a known active note writer before relying on it.

## Response shape (/api/v1/posts, [LIVE])
- id: `id` (int). Permalink: `canonical_url`. Also `slug`.
- `title`, `subtitle`, `description`, `truncated_body_text`, `body_html` (null or partial when paywalled), `wordcount`.
- time: `post_date` (ISO Z).
- audience: `audience` is `everyone` | `only_paid` | `founding` | `only_free`. For paid posts, emit the preview and mark them locked.
- type: `type` is `newsletter` | `podcast` | `thread` | `video`. Podcasts have `podcast_url` (mp3) and `podcast_duration`.
- media: `cover_image` (often `substack-post-media.s3.amazonaws.com/...`, sometimes `substackcdn.com/image/fetch/...`).
- author: `publishedBylines[].{name,handle,photo_url}`.
- metrics: `reactions` (dict, e.g. `{"❤":123}`), `comment_count`, `restacks`.

## Hosts to declare
- `substack.com`, `*.substack.com`, `substackcdn.com`, `substack-post-media.s3.amazonaws.com`, `bucketeer-*.s3.amazonaws.com` (old images).
- Custom domains: take the publication URL in an input field (e.g. `publication`) and set `"hostsFromInput": ["publication"]`, so one actor serves any custom domain without editing hosts. If you start from `<pub>.substack.com` and it 301s to a custom domain, install the source with the custom-domain URL as input.
- Podcast audio: `api.substack.com`, `*.substack.com`.

## Limits & politeness
- Some 429s on heavy bursts [MEM]. Hourly polling of `/feed` is fine.
- Custom domains sit behind Cloudflare.

## Failure signatures
- `/api/v1/*` on a non-Substack domain gives 404 HTML.
- A 301 to the custom domain is normal, not an error.
- Paywalled post: `body_html` truncated, with a "subscribe" footer inside.

## Fallbacks (in order)
1. `/feed`.
2. `/api/v1/posts`.
3. `sr.browser` on the post page.

## Signed-in tier
- Inbox and subscriptions while logged in: `https://substack.com/api/v1/reader/posts?...` and `substack.com/inbox`, captured in the app browser [MEM].
- Usually you do not need them: `public_profile.subscriptions[]` gives the list without login, unless the user hid it.

## Sketch
```python
import sr
host = sr.input["host"]  # e.g. "astralcodexten.substack.com"
r = sr.fetch(f"https://{host}/api/v1/posts?limit=20&offset=0")
if r.status != 200: raise SystemExit(f"substack {r.status} at {r.url}")
seen = set(sr.state.get("seen", []))
for p in r.json():
    if str(p["id"]) in seen: continue
    by = (p.get("publishedBylines") or [{}])[0]
    sr.emit({"id": str(p["id"]), "url": p["canonical_url"], "title": p["title"],
             "text": p.get("subtitle") or p.get("truncated_body_text") or "", "html": p.get("body_html"),
             "publishedAt": p["post_date"], "kind": p.get("type"),
             "media": [{"type": "image", "url": p["cover_image"]}] if p.get("cover_image") else [],
             "author": {"name": by.get("name"), "handle": by.get("handle"), "avatar": by.get("photo_url"),
                        "url": f"https://substack.com/@{by['handle']}" if by.get("handle") else None},
             "metrics": {"comments": p.get("comment_count"), "reactions": sum((p.get("reactions") or {}).values())}})
    seen.add(str(p["id"]))
sr.save_state({"seen": list(seen)[-300:]})
```
