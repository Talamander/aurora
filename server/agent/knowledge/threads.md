# Threads
Status 2026-10-12: works. Logged out, the profile HTML has SSR JSON with the 4 newest threads (curl); a real browser that scrolls gets 11 more per page through `/graphql/query` [LIVE]. Best tier: http (SSR), then browser to go deeper than 4 posts.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `www.threads.com`. `threads.net` answers 301 to `https://www.threads.com/@<user>` [LIVE]; accept both. Profile: `/@<username>`. Post: `/@<username>/post/<code>`.
- Usernames are Instagram usernames (`[A-Za-z0-9._]{1,30}`).
- The numeric `userID` (for example natgeo `63269174602`, which is different from the IG pk) appears in the SSR as `post.user.pk` and in the preloader variables `"userID":"..."`.

## Primary technique: profile SSR [LIVE]
- `GET https://www.threads.com/@<u>` with normal browser navigation headers (same set as instagram.md: desktop Chrome UA, `Accept: text/html,...`, `Accept-Language`, `sec-fetch-dest: document`, `sec-fetch-mode: navigate`, `sec-fetch-site: none`, `upgrade-insecure-requests: 1`) returns 200, about 145 KB with gzip. No cookies are needed.
- Take every `<script type="application/json" ... data-sjs>` block and JSON-parse it. Keep the one containing `"mediaData"`. Seen path: `require[0][3][0].__bbox.require[0][3][1].__bbox.result.data.mediaData`.
- Don't hardcode that path. Walk the tree recursively for a dict key `mediaData` (or for `edges` lists whose nodes have `thread_items`).
- `mediaData.edges[].node.thread_items[].post`: one edge is one thread; several items mean the author's self-thread chain. `mediaData.page_info.{end_cursor,has_next_page}`.
- The SSR query is `BarcelonaProfileThreadsTabDirectQuery` (queryID `29125715583686917`, vars `{"first":4,"userID":..., "allow_page_info_for_lox_user":true, ...}`). Profile header: `BarcelonaProfilePageDirectQuery`. `og:description` also has "18.4M Followers • 1.6K Threads • bio".

## Response shape (`post`) [LIVE]
- `pk` (id), `id` (`<pk>_<userpk>`), `code`. Permalink: `https://www.threads.com/@<user.username>/post/<code>`.
- `taken_at` (Unix seconds), `caption.text` (null for media-only posts).
- `media_type`: 19 = text, 1 = image, 2 = video, 8 = carousel.
- `image_versions2.candidates[].{url,width,height}` (empty for text posts), `video_versions[].url`, `carousel_media[]` (each item has its own `image_versions2` / `video_versions`), `accessibility_caption`.
- `user.{pk, username, full_name, profile_pic_url, is_verified}`.
- `like_count`, and `text_post_app_info.{direct_reply_count, repost_count, quote_count, reshare_count, is_reply}`.
- `text_post_app_info.share_info.quoted_post` (quote post, which has the same `post` shape) and `.reposted_post` (a repost; the author differs from the profile).
- `text_post_app_info.link_preview_attachment.{url, display_url, title, image_url}` (the image sits on `external-*.xx.fbcdn.net`).
- No view counts logged out [DOCS: memo23; others disagree].

## Pagination (browser only)
- In `sr.browser` with `scroll=2..3`, the page POSTs to `https://www.threads.com/graphql/query`. Form fields: `fb_api_req_friendly_name=BarcelonaProfileThreadsTabRefetchableDirectQuery`, `doc_id=28825073703790160`, `variables={"after":"<end_cursor>","first":11,"userID":"...","allow_page_info_for_lox_user":true,...}`, plus `lsd` and many `__*` params [LIVE].
- The response `data.mediaData.edges` has 11 per page, with `page_info.has_next_page: true` [LIVE: 15 threads after one scroll].
- Replaying this POST by hand needs the page's `lsd` token and dyn params. Prefer capture: `capture=r'threads\.com/graphql/query'` and parse each body that has `mediaData`.
- Apify actors report a logged-out cap of about 15 to 25 threads per profile [DOCS]. For hourly polling, 4 (SSR) is usually enough; dedupe by `pk`.

## Hosts to declare
`www.threads.com`, `www.threads.net` (redirect), `*.cdninstagram.com` (avatars and media), `*.fbcdn.net` (link-preview images and some video).

## Limits & politeness
- 1 SSR request per source per hour. Use the browser path only when the newest SSR item is not yet in `sr.state` (meaning the gap is more than 4 posts).
- Apify authors report an intermittent "Threads • Log in" interstitial for logged-out requests [DOCS]. Treat it as a soft fail and retry next cycle, not immediately.

## Failure signatures
- 200 with `<title>Threads • Log in` / no `mediaData` script means an interstitial or throttle. Back off for 1 hour or more.
- `mediaData.edges == []` with a valid profile: private account (`text_post_app_is_private: true`) or no posts.
- 404 page: bad username.
- GraphQL replay without a valid `lsd` returns an error payload or an HTML redirect. Don't hand-replay; capture instead.

## Fallbacks (in order)
1. SSR curl (4 newest).
2. `sr.browser('https://www.threads.com/@u', wait_ms=6000, scroll=2, capture=r'graphql/query')` gives SSR plus about 11 per scroll.
3. Session tier (logged in) for full history or replies.
4. Many Threads users federate to the fediverse: if `@user@threads.net` is visible on Mastodon, the Mastodon API/RSS is an alternative [MEM].

## Signed-in tier [MEM]
- In the app's own browser profile with the user logged into Threads (an Instagram login), open `https://www.threads.com/` (the "For you" feed) or `https://www.threads.com/following` (chronological Following feed).
- Capture `graphql/query` bodies with `data.feedData.edges[].node.text_post_app_thread.thread_items[].post` (feed) and `mediaData` (profiles). Post shape is the same as above.
- Following list: profile, then "Following" dialog. Capture `BarcelonaFriendshipsFollowingTabRefetchableQuery`-style responses (`users[]` / `edges[].node.username`). Use it read-only.

## Apify hints [DOCS]
- tindacloud/threads-scraper: about 25 latest threads logged out.
- fetch_cat: about 15.
- scrapersdelight: 4 to 10, with an intermittent login interstitial.
- logiover: expands replies.
- plummy_bookbag: guest session plus GraphQL pagination and residential proxies.
- All of them accept threads.net and threads.com interchangeably.

## Sketch
```python
import sr, json, re, datetime
NAV = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
       "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
       "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "upgrade-insecure-requests": "1"}
u = sr.input["username"].lstrip("@").split("@")[-1].strip("/")
def find_key(o, key):
    if isinstance(o, dict):
        if key in o: yield o[key]
        for v in o.values(): yield from find_key(v, key)
    elif isinstance(o, list):
        for v in o: yield from find_key(v, key)
def media(p):
    out = []
    for m in (p.get("carousel_media") or [p]):
        img = ((m.get("image_versions2") or {}).get("candidates") or [{}])[0].get("url")
        if m.get("video_versions"): out.append({"type": "video", "url": m["video_versions"][0]["url"], "thumb": img})
        elif img: out.append({"type": "image", "url": img})
    return out
def emit_edges(edges):
    for e in edges:
        for it in e["node"]["thread_items"]:
            p = it["post"]; usr = p["user"]; tpi = p.get("text_post_app_info") or {}
            sr.emit({"id": p["pk"], "url": f"https://www.threads.com/@{usr['username']}/post/{p['code']}",
                     "author": {"name": usr.get("full_name") or usr["username"], "handle": usr["username"],
                                "url": f"https://www.threads.com/@{usr['username']}", "avatar": usr.get("profile_pic_url")},
                     "text": (p.get("caption") or {}).get("text"), "kind": "reply" if tpi.get("is_reply") else "post",
                     "publishedAt": datetime.datetime.fromtimestamp(p["taken_at"], datetime.timezone.utc).isoformat(),
                     "media": media(p), "metrics": {"likes": p.get("like_count"), "replies": tpi.get("direct_reply_count"),
                                                    "reposts": tpi.get("repost_count")}})
r = sr.fetch(f"https://www.threads.com/@{u}", headers=NAV)
blocks = re.findall(r'<script type="application/json"[^>]*data-sjs[^>]*>(.*?)</script>', r.text, re.S)
md = next((m for b in blocks if '"mediaData"' in b for m in find_key(json.loads(b), "mediaData")), None)
if not md:
    b = sr.browser(f"https://www.threads.com/@{u}", wait_ms=6000, scroll=2, capture=r"graphql/query")
    for blk in re.findall(r'<script type="application/json"[^>]*data-sjs[^>]*>(.*?)</script>', b["html"], re.S):
        if '"mediaData"' in blk:
            for m in find_key(json.loads(blk), "mediaData"): emit_edges(m["edges"])
    for c in b["json"]:  # pages loaded by scrolling (dedupe by pk happens host-side or via sr.state)
        for m in find_key(c["body"] if isinstance(c["body"], dict) else json.loads(c["body"]), "mediaData"): emit_edges(m["edges"])
else:
    emit_edges(md["edges"])
```
