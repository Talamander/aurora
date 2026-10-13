# YouTube
Status 2026-10-12: works (http) — channel tab HTML (`ytInitialData`) and innertube `/youtubei/v1/browse` return 200 with full video/shorts grids; yt-dlp flat playlist works; the official RSS feed is UNRELIABLE (404 most of today). Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `www.youtube.com`, `m.youtube.com`, `youtube.com`, `youtu.be`. Inputs: `@handle`, `/@handle`, `/channel/UC…`, `/c/name`, `/user/name`, a video URL (`watch?v=`, `/shorts/ID`, `youtu.be/ID`).
- Need the channel id `UC` + 22 chars. [LIVE] GET `https://www.youtube.com/@mkbhd` (200, ~2.8 MB) contains all of:
  `<link rel="canonical" href="https://www.youtube.com/channel/UC…">`, `<meta itemprop="identifier" content="UC…">`, `"externalId":"UC…"`, and `<link rel="alternate" type="application/rss+xml" href="…feeds/videos.xml?channel_id=UC…">`.
- From a video URL: watch page `ytInitialPlayerResponse.microformat.playerMicroformatRenderer.externalChannelId` [LIVE].
- Same page also exposes `"INNERTUBE_CLIENT_VERSION":"2.20261012.01.00"` and `INNERTUBE_API_KEY` [LIVE]; read them from the page rather than hardcoding.
- Uploads playlist ids derive from the channel id: `UU` + id[2:] (all), `UULF` + id[2:] (long videos only), `UUSH` + id[2:] (shorts only), `UULV` (lives) [MEM, widely used].

## Primary technique (http)
1. GET `https://www.youtube.com/@{handle}/videos` (or `/channel/UC…/videos`) and `/shorts`, `/streams`, `/posts` with headers `User-Agent: <desktop Chrome>`, `Accept-Language: en-US,en;q=0.9` (keeps relative-date strings in English). Parse `var ytInitialData = (\{.*?\});</script>` [LIVE].
2. Pagination / or skip HTML entirely: POST `https://www.youtube.com/youtubei/v1/browse?prettyPrint=false`, `Content-Type: application/json`, optional `X-YouTube-Client-Name: 1`, `X-YouTube-Client-Version: <ver>`, `Origin: https://www.youtube.com`, body
   `{"context":{"client":{"clientName":"WEB","clientVersion":"<ver>","hl":"en","gl":"US"}},"browseId":"UC…","params":"<tab params>"}` [LIVE, no key/cookie needed].
   Tab params seen today [LIVE]: Videos `EgZ2aWRlb3PyBgQKAjoA`, Shorts `EgZzaG9ydHPyBgUKA5oBAA%3D%3D`, Live `EgdzdHJlYW1z8gYECgJ6AA%3D%3D`, Posts `EgVwb3N0c_IGBAoCSgA%3D`. Read them from `tabs[].tabRenderer.endpoint.browseEndpoint.params` instead of hardcoding.
   Next page: body `{"context":…, "continuation":"<token>"}`; token at last grid item `continuationItemRenderer.continuationEndpoint.continuationCommand.token`; results in `onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems`.
3. Exact timestamps: grids only carry relative text ("4d ago"). For each NEW video id (not in `sr.state.seen`), GET `https://www.youtube.com/watch?v={id}` and read `ytInitialPlayerResponse.microformat.playerMicroformatRenderer.publishDate` (e.g. `2026-09-10T00:02:22-07:00`) or `<meta itemprop="datePublished" content="…">` [LIVE]. Cap at ~10 detail fetches per run.
4. RSS (cheapest when up): `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (15 newest incl. shorts, exact `<published>`, `media:statistics views`). [LIVE] today: 4 of 5 requests 404 (Google HTML 404 page), one 200 with 15 entries; `playlist_id=UULF…` returned 500 and 404. [DOCS] RSS-Bridge PR #5117 (~Oct 7 2026) and Miniflux/FreshRSS issues report 404 for every channel for long stretches in 2026, earlier a 09:00–12:00 UTC pattern. Treat as opportunistic: try once, on 404/500 fall to step 1.

## Response shape
- ytInitialData tabs: `contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer{title,selected,content.richGridRenderer.contents[]}`.
- Videos tab item [LIVE]: `richItemRenderer.content.lockupViewModel`:
  id `contentId`; type `contentType` (`LOCKUP_CONTENT_TYPE_VIDEO`); title `metadata.lockupMetadataViewModel.title.content`; views/age `…metadata.contentMetadataViewModel.metadataRows[0].metadataParts[].text.content` (`"7M"`, `"4d ago"`; `accessibilityLabel` has `"7 million views"`, `"4 days ago"`); thumbs `contentImage.thumbnailViewModel.image.sources[].url` (last = largest); duration badge `…overlays[].thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel.text` (`"14:13"`).
- Shorts tab item [LIVE]: `richItemRenderer.content.shortsLockupViewModel`: id `onTap.innertubeCommand.reelWatchEndpoint.videoId`; thumb `…reelWatchEndpoint.thumbnail.thumbnails[0].url` (`frame0.jpg`, 1080x1920); title/views from `accessibilityText` (`"iPhone Duo is here, 7.8 million views - play Short"`) or `overlayMetadata.primaryText.content` / `secondaryText.content` [MEM].
- Channel meta: `metadata.channelMetadataRenderer{title, externalId, vanityChannelUrl, avatar.thumbnails[0].url, description}` [LIVE].
- RSS entry: `yt:videoId`, `title`, `link[@href]`, `author/name`, `published`, `media:group/media:description`, `media:thumbnail[@url]` (`i4.ytimg.com/vi/ID/hqdefault.jpg`), `media:statistics[@views]` [LIVE].
- Permalinks: `https://www.youtube.com/watch?v={id}` (videos), `https://www.youtube.com/shorts/{id}`. Stable thumb: `https://i.ytimg.com/vi/{id}/hqdefault.jpg`.

## Hosts to declare
`www.youtube.com`, `i.ytimg.com`, `i1-4.ytimg.com` (or `*.ytimg.com`), `yt3.googleusercontent.com`, `yt3.ggpht.com` (avatars). yt-dlp path adds nothing else for flat listing.

## Limits & politeness
No published limit. One channel = 1–3 requests + ≤10 watch-page fetches. Hourly sync is plenty. Heavy bursts trigger "Sign in to confirm you're not a bot" (on watch/player, not browse) [DOCS, common yt-dlp issue]; back off for hours if seen.

## Failure signatures
- RSS: HTTP 404 with HTML `<title>Error 404 (Not Found)!!1</title>`, or 500 [LIVE]. Not a dead channel.
- EU/consent: redirect to `consent.youtube.com` [MEM]; add `Cookie: SOCS=CAI` only if the user approves (it is a consent cookie, not a login) — otherwise use innertube POST which is not gated.
- Channel missing: 404 on `/@handle`; innertube returns `alerts[].alertRenderer` with "This channel does not exist." [MEM].
- Renderer churn: YouTube moved grids from `videoRenderer` to `lockupViewModel` in 2025; code should search recursively for `videoId`/`contentId` keys as a fallback.

## Fallbacks (in order)
1. RSS once (exact dates, cheap) → 2. tab HTML/innertube browse (+watch-page dates) → 3. `yt-dlp --flat-playlist -J --playlist-end 15 https://www.youtube.com/@x/videos` (and `/shorts`) [LIVE: 1.4 s, gives `id,title,url,duration,view_count,thumbnails`, channel_id; `timestamp`/`upload_date` are None in flat mode; `--extractor-args youtubetab:approximate_date` gives approximate timestamps [MEM]] → 4. `sr.browser` on the tab page.
Manifest for 3: `"python": {"requires": ["yt-dlp"]}` (pin a recent version; yt-dlp 2026.08.19 worked today).

## Signed-in tier
App browser profile, user logs into Google. Subscriptions feed: `https://www.youtube.com/feed/subscriptions` → same `ytInitialData` grid (lockupViewModel, items carry channel info) or innertube browse `browseId: "FEsubscriptions"`. Follow list: `https://www.youtube.com/feed/channels` (`browseId: "FEchannels"`) lists subscribed channels → convert each to a public channel source (better than scraping the feed) [MEM]. Logged-out these redirect to sign-in.

## Apify hints
streamers/youtube-channel-scraper and streamers/youtube-scraper: input `startUrls`, `maxResults`, `maxResultsShorts`, `maxResultStreams`; scrape "public web + innertube surfaces", push error item for missing/age-restricted channels [DOCS].

## Sketch
```python
import re, json, sr
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
seen = set(sr.state.get("seen", []))
inp = sr.input["channel"].strip()           # "@mkbhd", URL, or UC id
base = inp if inp.startswith("http") else ("https://www.youtube.com/channel/" + inp if inp.startswith("UC") else "https://www.youtube.com/@" + inp.lstrip("@"))
html = sr.fetch(base.rstrip("/") + "/videos", headers=H).text
cid = re.search(r'"externalId":"(UC[\w-]{22})"', html).group(1)
data = json.loads(re.search(r"var ytInitialData = (\{.*?\});</script>", html).group(1))
meta = data["metadata"]["channelMetadataRenderer"]
author = {"name": meta["title"], "handle": meta.get("vanityChannelUrl", "").rsplit("/", 1)[-1],
          "url": "https://www.youtube.com/channel/" + cid, "avatar": meta["avatar"]["thumbnails"][0]["url"]}
tab = next(t["tabRenderer"] for t in data["contents"]["twoColumnBrowseResultsRenderer"]["tabs"] if t.get("tabRenderer", {}).get("selected"))
fetched = 0
for it in tab["content"]["richGridRenderer"]["contents"][:15]:
    lv = it.get("richItemRenderer", {}).get("content", {}).get("lockupViewModel")
    if not lv: continue
    vid = lv["contentId"]; title = lv["metadata"]["lockupMetadataViewModel"]["title"]["content"]
    if vid in seen: continue
    pub = None
    if fetched < 10:
        w = sr.fetch(f"https://www.youtube.com/watch?v={vid}", headers=H).text; fetched += 1
        m = re.search(r'itemprop="datePublished" content="([^"]+)"', w); pub = m and m.group(1)
    sr.emit({"id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "author": author, "title": title,
             "publishedAt": pub, "kind": "video",
             "media": [{"type": "video", "url": f"https://www.youtube.com/watch?v={vid}", "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"}]})
    seen.add(vid)
sr.save_state({"seen": list(seen)[-500:], "channel_id": cid})
```
