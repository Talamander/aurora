# LinkedIn
Status 2026-10-12: partial. Logged out, company pages SSR the 10 latest posts (including reposts), and some public person profiles SSR their recent posts. There is no API, no RSS and no paging. Best tier: http (session tier for the home feed and for people with restricted profiles).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `linkedin.com`, `www.linkedin.com`, `*.linkedin.com` (country subdomains such as `uk.linkedin.com`), `lnkd.in` (shortener).
- Company: `/company/<slug>/` (also `/showcase/<slug>/`, `/school/<slug>/`). Person: `/in/<vanity>` (the trailing slash 301s to no slash [LIVE]). Post: `/posts/<vanity>_<slug>-activity-<id>-<4ch>`, `/feed/update/urn:li:activity:<id>/`. Article: `/pulse/<slug>`.
- Activity id time: `ms = int(id) >> 22` (snowflake-like). `7515397147006173184` decodes to 2026-10-12T13:05Z, which matched the "14h" label [LIVE]. Use this for `publishedAt`, because the cards only show relative times ("14h", "3d").

## Primary technique: company page SSR [LIVE]
- `GET https://www.linkedin.com/company/<slug>/` with a desktop Chrome UA and `Accept-Language: en-US,en;q=0.9` returns 200 and about 460 KB HTML. It contains 10 `<article ... main-feed-activity-card ... data-activity-urn="urn:li:activity:<id>" data-attributed-urn="urn:li:share:<id>|urn:li:ugcPost:<id>">` blocks.
- Per card (split on `<article` and end at `</article>`):
  - text: the element with `data-test-id="main-feed-activity-card__commentary"`, which is a `<p>` with inner links;
  - repost: the header contains "<Company> reposted this", and the actor lockup is then the original author (`data-test-id="main-feed-activity-card__entity-lockup"`);
  - images: `data-delayed-url="https://media.licdn.com/dms/image/v2/.../feedshare-shrink_800/..."` inside `data-test-id="feed-images-content"`, plus `article-cover_image-shrink_720_1280` for article shares and `image-shrink_800` for documents;
  - video: `<video ... data-sources="[{&quot;src&quot;:&quot;https://dms.licdn.com/playlist/vid/v2/.../mp4-720p-30fp-crf28/...&quot;,...}]" data-poster-url="https://media.licdn.com/.../videocover-high/...">` (HTML-unescape, then `json.loads`);
  - reactions: `data-test-id="social-actions__reaction-count"` (text number); comments: `social-actions__comments` (e.g. "12 Comments");
  - avatar: the first `data-delayed-url` with `profile-displayphoto` or `company-logo`.
- Cards contain NO permalink. Build one as `https://www.linkedin.com/feed/update/urn:li:activity:<id>/` [MEM: that URL opens publicly and redirects to the `/posts/` page].
- Header: `<title>Microsoft | LinkedIn`. One `application/ld+json` describes the Organization.

## Person profile SSR [LIVE for a famous public profile]
- `GET https://www.linkedin.com/in/<vanity>` returned 200 and about 590 KB for `williamhgates`. It had 11 activity URNs in `profile-feed-activity-card` blocks ("<Name> shared this" or "<Name> reposted this"), each with an `href="https://www.linkedin.com/posts/<vanity>_...-activity-<id>-XXXX"` and the text inline, plus a list of `/pulse/` articles.
- Many members restrict their public profile, and logged-out visitors are then sent to `/authwall` [DOCS]. `/in/<v>/recent-activity/all/` 301s to the profile root [LIVE]; there is no logged-out activity page.

## Single public post [LIVE]
- `GET https://www.linkedin.com/posts/<...>-activity-<id>-XXXX` returns 200 and about 180 KB with `<script type="application/ld+json">` of `@type: SocialMediaPosting`.
- Fields: `datePublished` (ISO, exact), `headline`, `articleBody` / `text` (full text), `author{name, url, image.url}`, `image.url` (a video thumbnail or image), `interactionStatistic[]{interactionType: LikeAction|CommentAction, userInteractionCount}`, `commentCount`, `comment[]`.
- Use it to hydrate exact times and full text for the few new ids per run: 1 extra request per new post, 3 to 5 at most per run.

## Hosts to declare
`www.linkedin.com`, `media.licdn.com` (images, avatars, posters), `dms.licdn.com` (video mp4, captions), `static.licdn.com` (placeholders only).

## Limits & politeness
- LinkedIn is the most scrape-hostile site in this pack. Use 1 page request per source per sync, at most 3 to 5 hydration requests, and a sync interval of 2 hours or more.
- Space requests 3 s or more apart. Never parallelize.
- Repeated logged-out hits are a known scraping signal [DOCS]. If a 999 or authwall appears, stop for the day.

## Failure signatures
- HTTP 999 with an empty or tiny body: LinkedIn's anti-bot response (common from datacenter IPs) [MEM].
- 302 or 303 to `https://www.linkedin.com/authwall?trk=...&sessionRedirect=...`: login is required for this profile [DOCS].
- A 200 page whose title is "Sign Up | LinkedIn" or which contains `authwall`: treat it the same way.
- Zero `main-feed-activity-card` articles: either the company has no posts, or the DOM changed. In October 2026, LinkedIn moved the URN out of the `data-urn` attribute [DOCS]; today's working attribute is `data-activity-urn` [LIVE]. Fall back to the regex `urn:li:activity:(\d+)` anywhere in the HTML.
- Logged-out pages give no paging cursor. You only ever see the latest 10 or so posts, so poll often enough not to miss posts from prolific companies.

## Fallbacks (in order)
1. Company or person SSR, then hydrate new ids via the `/posts/` JSON-LD. Optionally use `/feed/update/urn:li:activity:<id>/`.
2. `sr.browser(url)` and parse the same DOM. This helps only if HTTP gets an odd interstitial; it is not a bypass.
3. Session tier.

## Signed-in tier (follow list / home feed)
- The user logs into linkedin.com in the app's own browser profile.
- Run `sr.browser('https://www.linkedin.com/feed/?sortBy=RECENT', scroll=3, capture=r'/voyager/api/')`. The feed loads via `voyager/api/graphql?queryId=voyagerFeedDashMainFeed.<hash>` (or `/voyager/api/feed/updatesV2`). Its JSON is "normalized": `included[]` holds entities keyed by `$type`, e.g. `com.linkedin.voyager.dash.feed.Update` with `commentary.text.text`, `actor.name.text`, `metadata.backendUrn` (urn:li:activity), and `content.*` for images or video [MEM].
- For a person's posts: `https://www.linkedin.com/in/<v>/recent-activity/all/` (logged in), capturing `voyagerFeedDashProfileUpdates`.
- Follow list: `/mynetwork/network-manager/people-follow/following/` [MEM].
- Scroll slowly and read only. Never touch the reaction or comment buttons.

## Apify hints
- No-login company-post actors read the same logged-out company page and say it shows "roughly 9 to 11 posts, no cursor".
- One actor claims about 70 posts by paging through rotating residential proxies, which is outside our lines.
- Person-post actors all need cookies (`li_at`). We do not copy cookies; use the session tier instead.

## Sketch
```python
import re, html, json, datetime, sr
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'}
slug = sr.input['company']
r = sr.fetch(f'https://www.linkedin.com/company/{slug}/', headers=UA)
if r.status == 999 or 'authwall' in r.url:
    sr.log(f'linkedin blocked: {r.status} {r.url}'); raise SystemExit(1)
name = re.search(r'<title>([^|<]+)', r.text).group(1).strip()
for card in re.split(r'(?=<article[^>]*main-feed-activity-card)', r.text)[1:]:
    card = card[:card.find('</article>')]
    aid = re.search(r'urn:li:activity:(\d+)', card).group(1)
    t = re.search(r'main-feed-activity-card__commentary"[^>]*>(.*?)</p>', card, re.S)
    imgs = [html.unescape(u) for u in re.findall(r'data-delayed-url="([^"]+)"', card)
            if re.search(r'feedshare|image-shrink|article-cover', u)]
    vids = [json.loads(html.unescape(s))[-1]['src'] for s in re.findall(r'data-sources="([^"]+)"', card)]
    ts = datetime.datetime.fromtimestamp((int(aid) >> 22) / 1000, datetime.timezone.utc).isoformat()
    sr.emit({'id': aid, 'url': f'https://www.linkedin.com/feed/update/urn:li:activity:{aid}/',
             'text': sr.html_to_text(t.group(1)) if t else None, 'publishedAt': ts,
             'author': {'name': name, 'url': f'https://www.linkedin.com/company/{slug}/'},
             'kind': 'repost' if 'reposted this' in card[:3000] else 'post',
             'media': [{'type': 'image', 'url': u} for u in imgs] + [{'type': 'video', 'url': v} for v in vids]})
```
