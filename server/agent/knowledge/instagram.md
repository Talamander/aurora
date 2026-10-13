# Instagram
Status 2026-10-12: partial. Logged out, the profile HTML still carries the 12 newest grid posts (pinned first). The old `web_profile_info` JSON API returns 401 `require_login`. Best tier: http (profile HTML SSR), with browser as fallback and session for more than 12 posts or for the home feed.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `instagram.com`, `www.instagram.com`, `instagr.am`, `ig.me`. Profile: `/<username>/` (username matches `[A-Za-z0-9._]{1,30}`). Post: `/p/<code>/`, `/reel/<code>/`, `/tv/<code>/`, and also `/<username>/p/<code>/` (the grid links now carry this prefix [LIVE]).
- A user-entered `@natgeo` or a profile URL gives the username. No numeric id is needed for the logged-out path.
- The numeric user id appears as `xig_user_by_username.pk` (for example `787132`), and the IG-scoped id as `.id` (`17841400573960012`).
- Media `pk` encodes the time: `ts = (int(pk) >> 23) / 1000 + 1314220021.721` (Unix seconds) [LIVE: matched the dates in the alt text].

## Primary technique: profile HTML preloader [LIVE]
- `GET https://www.instagram.com/<username>/` returns 200 (about 135 KB with gzip).
- Send normal browser navigation headers. Without them the page comes back as an empty shell with no `xig_*` data [LIVE]. Headers:
  `User-Agent: <desktop Chrome>`, `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`, `Accept-Language: en-US,en;q=0.9`, `Accept-Encoding: gzip, deflate, br`, `sec-fetch-dest: document`, `sec-fetch-mode: navigate`, `sec-fetch-site: none`, `upgrade-insecure-requests: 1`. No cookies are needed.
- These are ordinary browser headers. Do NOT use TLS-fingerprint impersonation (curl_cffi `impersonate=`), because that is bot-detection evasion and we do not do it.
- In the HTML, find `["adp_PolarisLoggedOutDesktopWWWProfilePostsTabContentQueryRelayPreloader_<hex>",` and `json.JSONDecoder().raw_decode()` the object right after it. Several matches exist; keep the one whose `__bbox` has `result`.
- Path: `__bbox.result.data.xig_user_by_username.polaris_ordered_timeline_connection.edges[].node`. There are 12 edges, and `page_info.end_cursor` / `has_next_page` are present.
- The relay query behind it is `PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery`, `queryID 27553725110923321`, with vars `{"first":12,"username":"<u>"}`.
- Profile header (name, avatar, bio, follower count, `latest_reel_media`) sits in the `...ProfileRootContentQueryRelayPreloader_...` payload under `data.xig_user_by_username`: `full_name`, `profile_pic_url`, `biography`, `is_private`, `is_verified`.

## Response shape (grid node) [LIVE]
- `pk`: numeric id, usable as the item id.
- `code`: shortcode. Permalink is `https://www.instagram.com/p/<code>/`.
- `__typename`: `XIGPolarisImageMedia`, `XIGPolarisVideoMedia` or `XIGPolarisCarouselMedia`.
- `media_type`: 1 = image, 2 = video, 8 = carousel. `product_type`: `feed`, `clips` (reel) or `carousel_container`.
- `caption.text`, `display_uri` (640px jpg; also the video poster), `accessibility_caption` (alt text that includes "on October 12, 2026"), `carousel_media_count`, `user.{pk,username,id}`.
- The grid node has NO timestamp (derive it from `pk`), no video URL, no like counts and no carousel children.
- Ordering: pinned posts come first and are old. Sort by derived time and dedupe by `pk` in `sr.state`.
- Detail, when needed (one extra request per NEW post only):
  - (a) `GET /p/<code>/embed/captioned/` [LIVE]. Regex `"contextJSON":"(...)"`, then JSON-decode twice to get `gql_data.shortcode_media`. Fields: `id`, `shortcode`, `is_video`, `video_url`, `display_url`, `thumbnail_src`, `video_view_count`, `edge_media_to_caption.edges[0].node.text`, `edge_liked_by.count`, `edge_media_to_comment.count`, `owner.{username,profile_pic_url,is_verified}`, `edge_sidecar_to_children.edges[].node.{display_url,is_video,video_url}`. There is no `taken_at_timestamp`, so use `pk`. Use the `/p/` path even for reels: `/reel/<code>/embed/captioned/` returns an error page (`httpErrorPage`) [LIVE].
  - (b) `GET /p/<code>/` with nav headers [LIVE]. It has a `PolarisLoggedOutDesktopWWWPostRootContentQueryRelayPreloader` payload containing `xig_polaris_media.if_not_gated_logged_out`: `taken_at`, `like_count`, `comment_count`, `caption.text`, `video_versions[].url`, `image_versions2.candidates[].url`, `carousel_media[]`.

## Hosts to declare
`www.instagram.com`, `*.cdninstagram.com` (scontent-*.cdninstagram.com), `*.fbcdn.net` (some media). Media URLs are signed (`oe=` expiry, about days), so do not treat them as permanent.

## Limits & politeness
- 1 profile request per source per hour, plus 1 detail request per new post at most, spaced 2 s or more apart.
- After a 401 or 429, stop for at least 30 minutes; the IP gets flagged per endpoint [DOCS]. Never retry in a loop.

## Failure signatures
- `GET /api/v1/users/web_profile_info/?username=X` with `x-ig-app-id: 936619743392459` returns 401 `{"message":"Please wait a few minutes before you try again.","require_login":true,"igweb_rollout":true,"status":"fail"}` [LIVE, also with site csrftoken]. Scrapfly saw the same on 2026-09-23, and 400 "make sure you are logged in" for some profiles [DOCS]. This endpoint is dead logged out; don't use it.
- Profile HTML with no `xig_user_by_username` means a shell page: either the nav headers are missing or you were throttled. Back off.
- In a browser logged out, `/api/graphql` returns `{"errors":[{"message":"Unauthorized logged out query.","code":1675002}]}` for extra queries. Scrolling past 12 posts loads nothing, and a "Show more posts from <user>" login prompt appears [LIVE].
- Private account: `is_private:true` and no edges.
- Instaloader 4.15.4 (released 2026-10-12) gets the logged-out 401 "Please wait a few minutes" on `graphql/query`, a known issue since 2024 (#2319, #2501, #2568) [DOCS]. instagrapi 3.0.24 is a private-API, login-based library, so it's out of scope.

## Fallbacks (in order)
1. Profile HTML preloader (above).
2. `sr.browser('https://www.instagram.com/<u>/', wait_ms=6000)`, then parse the same preloader from `html` [LIVE: 12 posts]. Use this if the curl path starts returning shells.
3. Session tier: the user logs into the app's browser profile; scrolling then works and `graphql/query` returns more.
4. Single posts the user pastes: `/p/<code>/embed/captioned/`.

## Signed-in tier [MEM unless noted]
- In the app's own logged-in browser profile, open `https://www.instagram.com/<u>/` and scroll. Capture `/graphql/query` (and `/api/graphql`) responses whose JSON has `data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[].node`. Fields: `code`, `pk`, `taken_at`, `caption.text`, `image_versions2.candidates`, `video_versions`, `carousel_media`, `user.username`, `like_count`. doc_id `9310670392322965` was reported stable since Feb 2025 [DOCS: Scrapfly]; don't hardcode it, capture it instead.
- Home feed: open `https://www.instagram.com/` (or `/?variant=following` for the chronological Following feed) and capture the `xdt_api__v1__feed__timeline__connection` edges (`node.media`).
- Following list: open `https://www.instagram.com/<me>/following/` and capture `/api/v1/friendships/<uid>/following/?count=12&max_id=` (`users[].username`, `full_name`, `profile_pic_url`). Use it read-only to suggest sources.
- Keep it to 1 to 3 scrolls per run. Stop if a checkpoint, `challenge` or login page appears, and ask the user.

## Apify hints [DOCS]
`apify/instagram-post-scraper` and `instagram-scraper` say they "see the logged-out version of the page" and output `shortCode`, `caption`, `displayUrl`, `videoUrl`, `timestamp`, `likesCount` (-1 when hidden), `childPosts`, `ownerUsername` and `isPinned`. They paginate deeper using big proxy pools, which we don't use.

## Sketch
```python
import sr, json, re, datetime
NAV = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
       "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
       "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "upgrade-insecure-requests": "1"}
u = sr.input["username"].lstrip("@").strip("/").split("/")[-1]
def preload(html, name):
    for m in re.finditer(r'\["adp_%s_[0-9a-f]+",' % name, html):
        obj, _ = json.JSONDecoder().raw_decode(html[m.end():])
        if "result" in obj.get("__bbox", {}): return obj["__bbox"]["result"]["data"]
r = sr.fetch(f"https://www.instagram.com/{u}/", headers=NAV)
html = r.text
posts = preload(html, "PolarisLoggedOutDesktopWWWProfilePostsTabContentQueryRelayPreloader")
if not posts:  # shell page; try the real browser once
    html = sr.browser(f"https://www.instagram.com/{u}/", wait_ms=6000)["html"]
    posts = preload(html, "PolarisLoggedOutDesktopWWWProfilePostsTabContentQueryRelayPreloader")
if not posts: raise SystemExit(sr.log("no preloader: throttled or login wall") or 1)
prof = (preload(html, "PolarisLoggedOutDesktopWWWProfileRootContentQueryRelayPreloader") or {}).get("xig_user_by_username", {})
author = {"name": prof.get("full_name") or u, "handle": u, "url": f"https://www.instagram.com/{u}/", "avatar": prof.get("profile_pic_url")}
seen = set(sr.state.get("seen", []))
for e in posts["xig_user_by_username"]["polaris_ordered_timeline_connection"]["edges"]:
    n = e["node"]; ts = (int(n["pk"]) >> 23) / 1000 + 1314220021.721
    vid = n.get("media_type") == 2
    sr.emit({"id": n["pk"], "url": f"https://www.instagram.com/p/{n['code']}/", "author": author,
             "text": (n.get("caption") or {}).get("text"), "kind": "reel" if n.get("product_type") == "clips" else "post",
             "publishedAt": datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(),
             # grid gives only the poster image; for the mp4 fetch /p/<code>/embed/captioned/ -> shortcode_media.video_url (new posts only)
             "media": [{"type": "image", "url": n["display_uri"], "thumb": n["display_uri"],
                        "alt": n.get("accessibility_caption")}]})
    seen.add(n["pk"])
sr.save_state({"seen": list(seen)[-200:]})
```
