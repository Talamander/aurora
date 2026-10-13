# Pinterest
Status 2026-10-12: works. User and board RSS return 25 items, and the internal `/resource/*/get/` JSON API works logged out. Best tier: http (RSS first, resource API for richer data).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `pinterest.com`, `www.pinterest.com`, country domains (`pinterest.co.uk`, `.ca`, `.de`, `.fr`, `.com.au`, `.jp`, ...), `pin.it` (shortener: follow the redirect), `i.pinimg.com` (media).
- User: `/<username>/` (also `/<username>/_created/`, `/<username>/_saved/`). Board: `/<username>/<board-slug>/`. Pin: `/pin/<numeric id>/`.
- Normalize country domains to `www.pinterest.com`; the same username works there.
- Board slugs: list them via BoardsResource (below) when the user gives only a username and wants a specific board.

## Primary technique: RSS [LIVE]
- User feed (latest pins saved or created by the user): `https://www.pinterest.com/<username>/feed.rss` returned 200, `text/xml`, 25 items.
- Board feed: `https://www.pinterest.com/<username>/<board-slug>.rss` returned 200 with 25 items (no trailing slash; `.rss` appended to the slug).
- RSS 2.0 `channel/item`: `title` (the pin title or the description when there is no title), `link` and `guid` (`https://www.pinterest.com/pin/<id>/`), `pubDate` (RFC 822, e.g. "Tue, 06 Oct 2026 18:44:32 GMT").
- `description`: HTML `<a href="pin"><img src="https://i.pinimg.com/236x/aa/bb/cc/<hash>.jpg"></a>` followed by the description text.
- Upgrade image size by replacing `/236x/` with `/736x/` or `/originals/`. Originals may be `.png`; on 404, keep 736x.
- `channel/title` is the display name and `channel/link` the profile URL. RSS has no avatar and no video URLs.

## Richer: resource JSON API [LIVE]
- These are plain GETs with no cookies. Send `Accept: application/json` and `x-pinterest-pws-handler` (the page template, e.g. `www/[username].js`).
- `data` is URL-encoded JSON: `{"options":{...},"context":{}}`.
- Pins created by a user: `https://www.pinterest.com/resource/UserActivityPinsResource/get/?source_url=/<u>/_created/&data={"options":{"username":"<u>","page_size":25,"field_set_key":"grid_item"},"context":{}}` with `x-pinterest-pws-handler: www/[username]/_created.js`.
- Boards: `.../resource/BoardsResource/get/?source_url=/<u>/&data={"options":{"username":"<u>","page_size":25,"field_set_key":"profile_grid_item","privacy_filter":"all","sort":"last_pinned_to"},"context":{}}`. Each item gives `url` (`/nasa/nasa-news/`), `name`, `id`, `pin_count`.
- Board pins: `BoardFeedResource` with options `{"board_id":"<id>","board_url":"/<u>/<slug>/","page_size":25}` [MEM].
- Envelope: `resource_response.status == "success"`, `resource_response.data[]`, and `resource_response.bookmark` (the paging cursor). Pass it as `options.bookmarks:["<bookmark>"]`; `"-end-"` means done.
- Pin fields: `id`, `created_at` (RFC 822), `title` / `grid_title`, `description`, `link` (outbound), `images.{170x,236x,474x,736x,orig}.url`, `is_video`, `videos.video_list.V_720P.url` (or `V_HLSV4`, when it is a video), `story_pin_data` (idea pins: pages with blocks), `pinner{username, full_name, image_large_url, id}`, `board{url,name}`, `repin_count`, `reaction_counts`, `comment_count`, `aggregated_pin_data.aggregated_stats.saves`.

## Hosts to declare
`www.pinterest.com`, `i.pinimg.com`, `v1.pinimg.com` (video), `s.pinimg.com` (static, only in a browser tier).

## Limits & politeness
- One RSS request per source per sync (60 minutes or more). Use the resource API only when RSS lacks what is needed (video, originals, saves).
- Space requests 2 s or more apart.
- Pinterest has not throttled 4 requests in a row from here. There is no documented anonymous limit.

## Failure signatures
- Unknown user or board: RSS returns 404 (or 200 with zero items) [MEM].
- Resource API errors: `resource_response.status: "failure"` with `error.message`, or HTTP 403 when headers are missing (send both headers) [MEM].
- `field_set_key` changes can alter keys. If `images` is missing, try `field_set_key:"react_grid_pin"`.
- Secret boards are never visible.

## Fallbacks (in order)
1. RSS (user or board).
2. Resource API (above).
3. `sr.browser('https://www.pinterest.com/<u>/_created/', capture=r'/resource/.*Resource/get')`: the page fetches the same JSON.
4. Profile HTML embeds `<script id="__PWS_INITIAL_PROPS__" type="application/json">` (or `__PWS_DATA__`) with the initial pins [MEM].

## Signed-in tier (follow list / home feed)
- The user logs into pinterest.com in the app's own browser profile.
- Home feed: `sr.browser('https://www.pinterest.com/', scroll=3, capture=r'/resource/UserHomefeedResource/get')`. The data shape is the same as pins above.
- Following: `https://www.pinterest.com/<me>/_following/` captures `UserFollowingResource` (`data[].username`). Each followed user can then use the RSS path, with no login needed.

## Apify hints
- Popular Pinterest actors use the same `/resource/*Resource/get/` endpoints (often via a headless browser to obtain them), paginating with `bookmarks`.
- RSS is the lightweight path that most actors ignore.

## Sketch
```python
import re, html, sr, xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'}
u, board = sr.input['username'], sr.input.get('board')
url = f'https://www.pinterest.com/{u}/{board}.rss' if board else f'https://www.pinterest.com/{u}/feed.rss'
r = sr.fetch(url, headers=UA)
ch = ET.fromstring(r.text).find('channel')
for it in ch.findall('item'):
    desc = it.findtext('description', '')
    img = re.search(r'<img src="([^"]+)"', html.unescape(desc))
    pid = re.search(r'/pin/(\d+)', it.findtext('link')).group(1)
    sr.emit({'id': pid, 'url': it.findtext('link'), 'title': it.findtext('title', '').strip()[:300],
             'text': sr.html_to_text(desc), 'publishedAt': parsedate_to_datetime(it.findtext('pubDate')).isoformat(),
             'author': {'name': ch.findtext('title'), 'handle': u, 'url': f'https://www.pinterest.com/{u}/'},
             'kind': 'pin',
             'media': [{'type': 'image', 'url': img.group(1).replace('/236x/', '/736x/'), 'thumb': img.group(1)}] if img else []})
```
