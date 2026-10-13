# TikTok
Status 2026-10-12: works (http) — profile SSR gives `secUid` (but `itemList` is empty); the UNSIGNED `https://www.tiktok.com/api/creator/item_list/` returned 200 with 15 posts, no cookies, no X-Bogus. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `www.tiktok.com`, `tiktok.com`, `m.tiktok.com`, short links `vm.tiktok.com/…`, `vt.tiktok.com/…` (follow redirect). Profile `https://www.tiktok.com/@{uniqueId}`; post `https://www.tiktok.com/@{user}/video/{id}` or `/photo/{id}`.
- Need `secUid` (`MS4wLjABAAAA…`). [LIVE] GET `https://www.tiktok.com/@nasa` (200, ~390 KB) → `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">` → `__DEFAULT_SCOPE__["webapp.user-detail"]`:
  `statusCode` (0 = ok), `userInfo.user{id, uniqueId, secUid, nickname, avatarLarger, avatarThumb, signature, verified, privateAccount}`, `userInfo.stats{followerCount, videoCount, heartCount}`, `userInfo.itemList` = `[]` (empty today — posts are NOT in SSR any more).
- Cache `secUid` in state; it survives username changes.

## Primary technique (http, unsigned)
GET `https://www.tiktok.com/api/creator/item_list/?<query>` with `User-Agent: <desktop Chrome>`, `Referer: https://www.tiktok.com/` [LIVE 200, 320 KB]. Query (copied from yt-dlp 2026.08.19 `TikTokUserIE._build_web_query`):
`aid=1988 app_language=en app_name=tiktok_web browser_language=en-US browser_name=Mozilla browser_online=true browser_platform=Win32 browser_version=5.0 (Windows) channel=tiktok_web cookie_enabled=true count=15 cursor=<ms epoch, newest = now> device_id=<random 19-digit, 7250000000000000000..7325099899999994577> device_platform=web_pc focus_state=true from_page=user history_len=2 is_fullscreen=false is_page_visible=true language=en os=windows priority_region= referer= region=US screen_height=1080 screen_width=1920 secUid=<secUid> type=1 tz_name=UTC verifyFp=verify_<7 hex> webcast_language=en`.
`type=1` = newest→oldest. Next page: `cursor = itemList[-1].createTime*1000` while `hasMorePrevious`. For a feed, page 1 is enough.
Note: `/api/post/item_list/` (what the web app itself calls) needs msToken/X-Bogus/X-Gnarly signing — do not try to forge signatures; use `creator/item_list` or the browser tier.

## Response shape (creator/item_list)
Top: `{statusCode, status_code, status_msg, hasMorePrevious, itemList[], extra, log_pb}` [LIVE]. Item:
id `id`; text `desc`; time `createTime` (unix s); author `author{uniqueId, nickname, avatarThumb, avatarLarger, secUid}`; metrics `stats{playCount, diggCount, commentCount, shareCount, collectCount}`; video `video{cover, originCover, dynamicCover, playAddr, downloadAddr, duration(s), width, height}`; pinned `isPinnedItem` (pinned posts can appear first — sort by createTime); photo posts carry `imagePost.images[].imageURL.urlList[0]` and a different `CategoryType` [DOCS gallery-dl #7246]; `isAd`, `privateItem`.
Permalink: `https://www.tiktok.com/@{author.uniqueId}/video/{id}` (photo: `/photo/{id}`).
Media URLs are signed and EXPIRE (`x-expires=` param, ~1 day) and `playAddr` needs TikTok cookies to stream — store `cover` as thumb and link to the permalink; re-fetch, do not hotlink long-term.

## Other endpoints [LIVE]
- oEmbed: `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@nasa/video/{id}` → `{title (full caption), author_name, author_url, html, thumbnail_url…}`. One post only.
- Profile embed: `https://www.tiktok.com/embed/@{user}` (200) → `<script id="__FRONTITY_CONNECT_STATE__">` → `source.data["/embed/@user"].videoList[]` (`id, desc, coverUrl, originCoverUrl…`), ~11 items, NOT chronological; no createTime (derive from id: `int(id) >> 32` = unix seconds [MEM, well-known]). Fails if the creator disabled embedding.
- Single post embed: `https://www.tiktok.com/embed/v2/{id}` (200).

## Hosts to declare
`www.tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`, media `*.tiktokcdn.com`, `*.tiktokcdn-us.com` (US: `p16-common-sign.tiktokcdn-us.com`, `p19-…`), `*.tiktokv.com`, `v16-webapp-prime.us.tiktok.com` (or `*.tiktok.com`), `*.ibyteimg.com`, `*.byteoversea.com` [MEM for the last two].

## Limits & politeness
Unknown hard limit; keep ≤1 profile request + 1 item_list per source per hour. yt-dlp notes the API sometimes "keeps sending the same page" with a bad device_id. Generate one device_id the first time a source runs, keep it in `sr.state`, and reuse it, like a single browser visitor would. You may replace it once if it is clearly broken, but never rotate device_ids, user agents or fingerprints to get around rate limits or blocks: back off and report instead.

## Failure signatures
- SSR `webapp.user-detail.statusCode` 10221/10222/10223 (banned/private/not found) or missing `userInfo` → yt-dlp error "Unable to extract secondary user ID" [DOCS yt-dlp #17500, Aug 2026; seen on some big profiles]. Workaround: get `secUid` from oEmbed→post page `webapp.video-detail.itemInfo.itemStruct.author.secUid`, or yt-dlp `tiktokuser:<secUid>`.
- item_list `statusCode` ≠ 0, empty `itemList` with `hasMorePrevious:false`, or HTML instead of JSON (region block / captcha page) → stop, retry next run.
- Captcha interstitial (`verify` / `captcha` in body, or a slider) → do NOT solve; drop to browser tier later or report.
- yt-dlp 2026.07.04 broke ("Unable to extract universal data for rehydration"), fixed in 2026.08.19 [DOCS].

## Fallbacks (in order)
1. creator/item_list (above) → 2. `yt-dlp --flat-playlist -J --playlist-end 15 https://www.tiktok.com/@user` [LIVE: 5 entries with `id,title,description,url,timestamp,view_count,uploader`; manifest `"python":{"requires":["yt-dlp>=2026.8.19"]}`] → 3. `sr.browser("https://www.tiktok.com/@user", wait_ms=6000, scroll=2, capture=r"/api/(post|creator)/item_list")` and read `json[].body.itemList` (the page signs its own calls) → 4. profile embed `videoList`.

## Signed-in tier
App profile, user logs in. Following feed: `https://www.tiktok.com/following` → capture `/api/following/item_list/` [MEM]. Following list: profile → Following dialog captures `/api/user/list/?…&scene=21&secUid=…` → `userList[].user{uniqueId,secUid}`; turn into public profile sources [MEM]. Never auto-follow/like.

## Apify hints
clockworks/tiktok-profile-scraper & tiktok-scraper: input usernames + count, output rows `authorMeta, videoMeta, musicMeta, playCount, diggCount, createTimeISO`; error row for private/empty/not found; walks full history [DOCS]. Field names are a reasonable convention to mirror in `metrics`.

## Sketch
```python
import re, json, time, random, string, urllib.parse, sr
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
user = sr.input["username"].lstrip("@").split("/")[-1]
sec = sr.state.get("secUid")
if not sec:
    h = sr.fetch(f"https://www.tiktok.com/@{user}", headers={"User-Agent": UA, "Accept-Language": "en-US"}).text
    ud = json.loads(re.search(r'id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>', h).group(1))["__DEFAULT_SCOPE__"]["webapp.user-detail"]
    if ud.get("statusCode") != 0: raise SystemExit(f"profile status {ud.get('statusCode')}")
    sec = ud["userInfo"]["user"]["secUid"]
q = {"aid": "1988", "app_name": "tiktok_web", "channel": "tiktok_web", "device_platform": "web_pc", "browser_name": "Mozilla",
     "browser_platform": "Win32", "browser_version": "5.0 (Windows)", "browser_language": "en-US", "browser_online": "true",
     "cookie_enabled": "true", "language": "en", "app_language": "en", "os": "windows", "region": "US", "tz_name": "UTC",
     "count": "15", "cursor": str(int(time.time() * 1000)), "type": "1", "from_page": "user", "secUid": sec,
     "device_id": str(random.randint(7250000000000000000, 7325099899999994577)),
     "verifyFp": "verify_" + "".join(random.choices(string.hexdigits, k=7))}
r = sr.fetch("https://www.tiktok.com/api/creator/item_list/?" + urllib.parse.urlencode(q), headers={"User-Agent": UA, "Referer": "https://www.tiktok.com/"})
d = r.json()
for v in sorted(d.get("itemList", []), key=lambda x: -x["createTime"]):
    a = v["author"]; photo = "imagePost" in v
    media = ([{"type": "image", "url": i["imageURL"]["urlList"][0]} for i in v["imagePost"]["images"]] if photo
             else [{"type": "video", "url": f"https://www.tiktok.com/@{a['uniqueId']}/video/{v['id']}", "thumb": v["video"].get("cover")}])
    sr.emit({"id": v["id"], "url": f"https://www.tiktok.com/@{a['uniqueId']}/{'photo' if photo else 'video'}/{v['id']}",
             "author": {"name": a.get("nickname"), "handle": a["uniqueId"], "url": f"https://www.tiktok.com/@{a['uniqueId']}", "avatar": a.get("avatarThumb")},
             "text": v.get("desc"), "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(v["createTime"])),
             "media": media, "kind": "photo" if photo else "video", "metrics": v.get("stats")})
sr.save_state({"secUid": sec})
```
