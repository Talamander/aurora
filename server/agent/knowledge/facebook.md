# Facebook
Status 2026-10-12: partial. Logged out, a public Page's HTML has SSR JSON for only the 1 newest post. A real browser gets about 3 on the Page itself and 5 through the Page Plugin embed; after that a login wall appears. Best tier: browser (Page Plugin), then http (www SSR, 1 post); session for anything more or for the home feed.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `facebook.com`, `www.facebook.com`, `m.facebook.com`, `web.facebook.com`, `fb.com`, `fb.me`.
- Page forms: `/<vanity>` (e.g. `/natgeo`), `/profile.php?id=<num>`, `/people/<Name>/<num>/`, and `/pg/<vanity>/posts` (legacy).
- Post permalinks:
  - `/<vanity>/posts/pfbid0...` (pfbid is an opaque id)
  - `/permalink.php?story_fbid=..&id=..`
  - `/photo.php?fbid=`
  - `/reel/<id>`, `/watch/?v=`
- Ids in the www SSR [LIVE]:
  - Profile-plus id: `"userID":"100044623170418"`.
  - Classic Page id: `delegate_page.id` (`23497828950`).
  - Per post: numeric `post_id` (`1688749695955787`), which is the best stable item id.
- Only public Pages (and public-mode profiles) are in scope. Personal profiles and groups are effectively login-only.

## Primary technique A: Page Plugin in a browser [LIVE, 5 posts]
- `sr.browser('https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2F<vanity>&tabs=timeline&width=500&height=1500&small_header=true&hide_cover=true&show_facepile=false', wait_ms=6000)`.
- The plugin's raw HTML (curl, even with `&_fb_noscript=1`) has NO posts. JS injects them, so this needs the browser [LIVE].
- Rendered DOM, one block per post:
  - Permalink: `<a href="/<vanity>/posts/pfbid...?ref=embed_page">`. Strip `?ref=` and prefix `https://www.facebook.com`.
  - Timestamp: `<abbr data-utime="1791849601" class="timestamp">` (Unix seconds).
  - Text: `<div data-testid="post_message" class="_5pbx userContent">` (use `<p>` text; outbound links are wrapped as `l.facebook.com/l.php?u=<urlencoded>`).
  - Image: `<img class="_1p6f _1p6g img" src="https://scontent-*.xx.fbcdn.net/...">`.
  - Author: `<div class="_2_79 _50f4 _50f7">Name</div>`; avatar `img[aria-label="<Name>"]` (50x50).
  - Likes: `.embeddedLikeButton` text such as `2.4K`.
- Split the HTML on `data-testid="post_message"` neighborhoods, or anchor on each `data-utime` and walk to the nearest permalink and message. Dedupe by pfbid.

## Primary technique B: www SSR (curl, 1 newest post) [LIVE]
- `GET https://www.facebook.com/<vanity>` with browser navigation headers (desktop Chrome UA, `Accept: text/html,...`, `Accept-Language`, `sec-fetch-dest: document`, `sec-fetch-mode: navigate`, `sec-fetch-site: none`, `upgrade-insecure-requests: 1`) returns 200, about 180 KB.
- Find `["adp_ProfileCometTimelineFeedQueryRelayPreloader_<hex>",` and `raw_decode` the next object. Use the chunk with `__bbox.result.data.user.timeline_list_feed_units.edges[]` (1 edge). The second chunk (`$defer$..page_info`) holds the cursor.
- Node (`__typename: "Story"`); search recursively, since the paths are deep and unstable:
  - `post_id`
  - `creation_time`
  - First `url` containing `/posts/` (permalink)
  - `message.text` (full text; a truncated copy also exists)
  - `actors[0].{name,id,url}`
  - `photo_image.uri` (attachment images), `profile_picture.uri`
  - `reaction_count.count`, `share_count.count`, `total_count`
  - Video posts: `playable_url` / `browser_native_hd_url` [MEM]
- Also in the header: `og:title` (Page name) and `og:description` ("51,361,096 followers · ... bio").
- Good enough for hourly polling of Pages that post less often than hourly. Busy Pages lose items, so use technique A.

## Logged-out pagination (browser on the Page itself) [LIVE]
Scrolling `https://www.facebook.com/<vanity>` fires one POST `/api/graphql/` with `fb_api_req_friendly_name=ProfileCometTimelineFeedRefetchQuery` (`doc_id=28654242734185331`). It returned 2 more posts, then the "See more from National Geographic" login form appeared. So about 3 posts in total; technique A is better.

## Hosts to declare
`www.facebook.com`, `*.xx.fbcdn.net` / `*.fbcdn.net` (scontent-*.xx.fbcdn.net images, static.xx.fbcdn.net JS/CSS for the browser), `l.facebook.com` (only if resolving outbound links; better to decode the `u=` param locally).

## Limits & politeness
- 1 Page per run, hourly at most. Space requests across sources by 5 s or more.
- Facebook "Rate limit exceeded" comes back as HTTP 200 with no posts [DOCS, Apify memo23]. Treat "page HTML OK but zero stories" as a soft throttle and back off for at least 1 hour; do not retry immediately.

## Failure signatures
- `mbasic.facebook.com/<page>` returns 302 to `/login/?next=...&refsrc=deprecated` [LIVE]. mbasic has been dead since about Oct 28, 2024 [DOCS].
- `m.facebook.com/<page>` returns 301 to `https://www.facebook.com/<page>?_rdr` [LIVE]. There is no lightweight mobile HTML any more.
- www page without `adp_ProfileCometTimelineFeedQuery` / `timeline_list_feed_units` means a login wall, a region/age-gated Page, or a throttle.
- Plugin rendered with no `data-utime` means the Page disallows embedding, or the Page has age or country restrictions.
- `facebook-scraper` (kevinzg) has been stale since June 2024 and depended on mbasic, so it is broken. The moda20 fork has open "Couldn't get any posts" issues [DOCS]. Don't use either.

## Fallbacks (in order)
1. Page Plugin via `sr.browser` (5 newest posts with text, time and image).
2. www SSR via `sr.fetch` (1 newest post, rich JSON).
3. Page itself via `sr.browser` with `scroll=1`, capturing `api/graphql` (about 3 posts).
4. Session tier.

## Signed-in tier [MEM]
- The user logs into Facebook inside the app's own browser profile.
- Chronological home feed: `https://www.facebook.com/?filter=all&sk=h_chr`. Pages/follows feed: `https://www.facebook.com/?filter=pages&sk=h_chr` (`filter=favorites` also exists).
- Capture `capture=r'/api/graphql/'` responses. The body is newline-delimited JSON (several JSON objects per response; split on lines). Feed units sit under `data.viewer.news_feed.edges[].node` (`CometNewsFeedPaginationQuery`). Story fields are the same as SSR (`post_id`, `creation_time`, `message.text`, `actors`, attachments).
- Followed Pages list: `https://www.facebook.com/<me>/following` or `/pages/?category=liked`. Use it read-only to suggest sources.
- Scroll at most 3 times. Stop on a checkpoint or "You're temporarily blocked".

## Apify hints [DOCS]
- `apify/facebook-posts-scraper`: public Pages only, uses residential proxies. Output fields: `postId`, `url`, `time`, `timestamp`, `user{id,name,profilePic}`, `text`, `likes`, `comments`, `shares`, `media`.
- memo23 reads the GraphQL doc_id from the page HTML on every run, and warns that a 200 with an empty body means rate-limited.
- Others read "the logged-out version of the Page published for indexing", which is the www SSR above.

## Sketch
```python
import sr, re, html as H, urllib.parse, datetime
v = sr.input["page"].rstrip("/").split("facebook.com/")[-1].split("?")[0]
href = urllib.parse.quote(f"https://www.facebook.com/{v}", safe="")
b = sr.browser(f"https://www.facebook.com/plugins/page.php?href={href}&tabs=timeline&width=500&height=1500"
               "&small_header=true&hide_cover=true&show_facepile=false", wait_ms=6000)
doc = b["html"]
seen = set(sr.state.get("seen", []))
# each post: permalink anchor wrapping <abbr data-utime>, then the post_message div
for m in re.finditer(r'href="(/[^"]+?/posts/(pfbid\w+))[^"]*"[^>]*>\s*<abbr data-utime="(\d+)"', doc):
    path, pid, ut = m.groups()
    if pid in seen: continue
    tail = doc[m.end(): m.end() + 20000]
    msg = re.search(r'data-testid="post_message"[^>]*>(.*?)</div>', tail, re.S)
    img = re.search(r'<img class="_1p6f[^"]*" src="([^"]+)"', doc[max(0, m.start() - 6000): m.end() + 20000])
    text = sr.html_to_text(msg.group(1)) if msg else None
    sr.emit({"id": pid, "url": "https://www.facebook.com" + path, "kind": "post", "text": text,
             "author": {"name": b["text"].split("\n")[0].strip() or v, "handle": v, "url": f"https://www.facebook.com/{v}"},
             "publishedAt": datetime.datetime.fromtimestamp(int(ut), datetime.timezone.utc).isoformat(),
             "media": [{"type": "image", "url": H.unescape(img.group(1))}] if img else []})
    seen.add(pid)
if not seen: sr.log("plugin showed no posts; try www SSR fallback")
sr.save_state({"seen": list(seen)[-200:]})
```
Note: in the sketch, the image regex window can grab a neighbouring post's image. Prefer splitting the DOM into post containers first (each post sits in a `div` that has its own `data-utime` and `post_message`).
