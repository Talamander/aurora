# Snapchat
Status 2026-10-12: partial. Only Snapchat "Public Profiles" (creators/brands) expose content logged out, through `__NEXT_DATA__`: the current public Story (only while it is live, 24 h), Spotlight highlights and curated highlights. Plain user accounts show only a name and snapcode. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `www.snapchat.com`, `snapchat.com`, `story.snapchat.com` (legacy). Profile: `/@<username>`; `/add/<username>` gives a 308 to `/@<username>` [LIVE].
- Spotlight item: `/spotlight/<snapId>`. Username is lowercase `[a-z0-9._-]{3,15}`.
- In curl, put a literal `@` in the URL. Percent-encoded `%40natgeo` returned 404 [LIVE].

## Primary technique [LIVE]
- `GET https://www.snapchat.com/@<u>` with browser navigation headers returns 200, about 40 to 70 KB. No cookies are needed.
- Parse `<script id="__NEXT_DATA__" type="application/json">`, then `props.pageProps`. Keys: `userProfile`, `story`, `curatedHighlights`, `spotlightHighlights`, `spotlightStoryMetadata`, `pageMetadata`, `...Cursor`.
- `userProfile.$case`:
  - `"publicProfileInfo"` (creator; content available): `publicProfileInfo.{username, title, profilePictureUrl, subscriberCount, bio, websiteUrl, hasSpotlightHighlights, hasCuratedHighlights}` [LIVE: mrbeast].
  - `"userInfo"` (regular account, NO content): `{username, displayName, snapcodeImageUrl}` [LIVE: natgeo]. Emit nothing, and tell the user the account isn't a public profile.

## Response shape
- `story`: `null` when there is no live story [LIVE]. When present, it has the same shape as the highlight entries below: `story.snapList[]` [MEM; the shape is inferred from highlights].
- `spotlightHighlights[]` / `curatedHighlights[]` [LIVE]: each has `{storyType, storyId.value, storyTitle.value, snapList[], thumbnailUrl...}`.
- `snapList[]` [LIVE]: `snapId.value` (empty for curated), `snapMediaType` (0 = image, 1 = video), `snapUrls.mediaUrl` (mp4/jpg on `cf-st.sc-cdn.net`), `snapUrls.mediaPreviewUrl.value` (thumb), `timestampInSec.value` (string, Unix seconds), `snapTitle`, `audioTranscriptionObjectUrl`.
- `spotlightStoryMetadata[]` [LIVE]: `videoMetadata.{name, description, thumbnailUrl, uploadDateMs, viewCount, contentUrl, durationMs, creator.personCreator.{username,name,url}}`.
- Item id: use `snapId.value`, or fall back to the media URL path (`/d/<key>.`) when snapId is empty.
- Permalinks: Spotlight `https://www.snapchat.com/spotlight/<snapId>`; stories `https://www.snapchat.com/@<u>`.

## Hosts to declare
`www.snapchat.com`, `cf-st.sc-cdn.net`, `bolt-gcdn.sc-cdn.net`, `*.sc-cdn.net`. Media URLs carry signed `mo=` params; they last a while, but don't rely on them long-term.

## Limits & politeness
1 request per profile per 1 to 3 hours. Stories expire after 24 h, so poll every 2 to 6 h at most if the user wants stories. No observed limits at this volume.

## Failure signatures
- 404 HTML on a percent-encoded `@` or a nonexistent user.
- `userProfile.$case == "userInfo"` means a private/regular account with no public content.
- `story == null` means no live story (normal).
- Highlights are often months old; the newest Spotlight for mrbeast was 2025-07 [LIVE]. Sort by timestamp and don't treat them as a feed of new posts.

## Fallbacks (in order)
1. `__NEXT_DATA__` via `sr.fetch`.
2. `sr.browser` of the same URL (same data; only useful if the HTML changes).
3. No signed-in tier is useful: the Snapchat web app (web.snapchat.com) is chat-only and has no follow feed of stories [MEM]. Treat it as not supported.

## Signed-in tier
Not supported (see above).

## Apify hints [MEM]
Apify Snapchat actors scrape the same public-profile `__NEXT_DATA__` (profile, stories, spotlight) and say only Public Profiles work.

## Sketch
```python
import sr, re, json, datetime
u = sr.input["username"].lstrip("@").split("/")[-1].lower()
NAV = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
       "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"}
r = sr.fetch(f"https://www.snapchat.com/@{u}", headers=NAV)
pp = json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', r.text, re.S).group(1))["props"]["pageProps"]
prof = pp["userProfile"]
if prof.get("$case") != "publicProfileInfo":
    raise SystemExit(sr.log("not a Snapchat Public Profile; no public content") or 0)
p = prof["publicProfileInfo"]
author = {"name": p.get("title") or u, "handle": u, "url": f"https://www.snapchat.com/@{u}", "avatar": p.get("profilePictureUrl")}
groups = ([pp["story"]] if pp.get("story") else []) + (pp.get("spotlightHighlights") or [])
for g in groups:
    for s in g.get("snapList", []):
        url = s["snapUrls"]["mediaUrl"]; sid = (s.get("snapId") or {}).get("value") or url.split("/d/")[-1].split(".")[0]
        ts = int((s.get("timestampInSec") or {}).get("value") or 0)
        sr.emit({"id": sid, "url": f"https://www.snapchat.com/spotlight/{sid}" if g.get("storyType") == 15 else author["url"],
                 "author": author, "kind": "story" if g is pp.get("story") else "spotlight",
                 "publishedAt": datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat() if ts else None,
                 "media": [{"type": "video" if s.get("snapMediaType") == 1 else "image", "url": url,
                            "thumb": (s["snapUrls"].get("mediaPreviewUrl") or {}).get("value")}]})
```
