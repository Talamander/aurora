# Patreon (creator posts)
Status 2026-10-12: works — the creator page gave the campaign id, and `/api/posts?filter[campaign_id]=` returned 200 JSON:API with public and locked post metadata. No auth. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `www.patreon.com`, `patreon.com`. Patterns:
  - `patreon.com/<vanity>` (redirects to `/cw/<Vanity>`), `patreon.com/cw/<vanity>`, `patreon.com/c/<vanity>`;
  - `patreon.com/<vanity>/posts`, `patreon.com/posts/<slug>-<postId>`;
  - `patreon.com/user?u=<userId>`.
- Campaign id [LIVE]: fetch `https://www.patreon.com/cw/<vanity>`. The page was 1.1 MB, and it contains `/api/campaigns/73401`. Regex: `/api/campaigns/(\d+)`. Cache it in `sr.state`.

## Primary technique
[LIVE] Fetch `GET https://www.patreon.com/api/posts` with these query parameters (curl needs `-g` because of the brackets; `sr.fetch` passes the URL through as-is):

| Parameter | Value |
|---|---|
| `filter[campaign_id]` | `<id>` |
| `filter[contains_exclusive_posts]` | `true` |
| `sort` | `-published_at` |
| `page[count]` | `20` |
| `include` | `campaign` |
| `fields[campaign]` | `name,url,avatar_photo_url` |
| `fields[post]` | `title,content,teaser_text,published_at,url,is_public,current_user_can_view,image,post_type,embed,like_count,comment_count` |

- Paging: `links.next` holds the full next URL (with `page[cursor]=`). `meta.pagination.total` gives the total post count (654 for Kurzgesagt).
- Response type is `application/vnd.api+json`.

## Response shape (JSON:API, [LIVE])
- `data[]`: `{id, type:"post", attributes:{...}, relationships:{campaign,user,attachments_media,...}}`.
- id: `data[].id`. Permalink: `attributes.url`.
- title: `title`. Body: `content` (HTML; null when locked or when the post has no text). Use `teaser_text` as a fallback.
- time: `published_at` (ISO with offset).
- media:
  - `image.{url,large_url,thumb_url}` (often `patreon.com/media-u/...` or `c10.patreonusercontent.com`);
  - `embed.{url,subject,description}` (e.g. a youtu.be link);
  - `post_type` is one of `text_only`, `image_file`, `video_embed`, `video_external_file`, `audio_file`, `poll`, `link`, `podcast`.
- access: `is_public`, `current_user_can_view`. False means patron-only: show the title, teaser and cover, plus a "locked" marker. Never try to bypass it.
- author: `included[type=campaign].attributes.{name,url,avatar_photo_url}`.
- metrics: `like_count`, `comment_count`.

## Hosts to declare
`www.patreon.com`, `c10.patreonusercontent.com` (images; it is safer to declare `*.patreonusercontent.com`).

## Limits & politeness
- Cloudflare sits in front. Single requests with a desktop UA pass. Bursts may get a challenge page (403 HTML with "Just a moment...") [MEM]. Do not try to solve it; back off.
- Poll every few hours at most.

## Failure signatures
- 404 JSON `{"errors":[...]}` for a bad campaign id.
- 403 HTML (Cloudflare) when rate-limited.
- No campaign-id match in the page: the vanity URL is wrong, or the layout changed. Then use `sr.browser` and capture `/api/` JSON.

## Fallbacks (in order)
1. `/api/posts` as above.
2. `sr.browser("https://www.patreon.com/cw/<vanity>/posts", capture="/api/posts")`.
3. The creator's own public RSS, if they post publicly elsewhere.

## Signed-in tier
- In the app browser profile, a logged-in patron gets full `content` for unlocked posts from the same endpoint.
- Memberships list: `https://www.patreon.com/api/current_user?include=memberships.campaign` [MEM].
- Patron RSS links (`/rss/<creator>?auth=...`) are personal secrets. The user can paste one as a normal RSS feed if they choose.

## Sketch
```python
import re, sr
v = sr.input["creator"].rstrip("/").split("/")[-1]
cid = sr.state.get("cid")
if not cid:
    page = sr.fetch(f"https://www.patreon.com/cw/{v}")
    m = re.search(r"/api/campaigns/(\d+)", page.text)
    if not m: raise SystemExit(f"no campaign id on page ({page.status} {page.url})")
    cid = m.group(1)
q = (f"https://www.patreon.com/api/posts?filter[campaign_id]={cid}&filter[contains_exclusive_posts]=true&sort=-published_at"
     "&page[count]=20&include=campaign&fields[campaign]=name,url,avatar_photo_url"
     "&fields[post]=title,content,teaser_text,published_at,url,is_public,current_user_can_view,image,post_type,embed,like_count,comment_count")
d = sr.fetch(q).json()
camp = next((i["attributes"] for i in d.get("included", []) if i["type"] == "campaign"), {})
for p in d["data"]:
    a = p["attributes"]; media = []
    if a.get("image"): media.append({"type": "image", "url": a["image"].get("large_url") or a["image"]["url"], "thumb": a["image"].get("thumb_url")})
    sr.emit({"id": p["id"], "url": a["url"], "title": a.get("title"),
             "text": sr.html_to_text(a.get("content") or a.get("teaser_text") or "") + ("" if a.get("current_user_can_view") else "\n[patron-only]"),
             "links": [a["embed"]["url"]] if a.get("embed") else [], "publishedAt": a["published_at"], "media": media, "kind": a.get("post_type"),
             "author": {"name": camp.get("name", v), "handle": v, "url": camp.get("url"), "avatar": camp.get("avatar_photo_url")},
             "metrics": {"likes": a.get("like_count"), "comments": a.get("comment_count")}})
sr.save_state({"cid": cid})
```
