# Reddit
Status 2026-10-12: partial. Anonymous `.json` is blocked (403 "blocked by network security") and old.reddit redirects to login. Atom `.rss` works but is limited to about 1 request per minute per IP. Best tier: http (RSS); session tier for scores, comments and the home feed.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `reddit.com`, `www.reddit.com`, `old.reddit.com`, `new.reddit.com`, `np.reddit.com`, `sh.reddit.com`, `redd.it` (short post links), `i.redd.it`, `v.redd.it`, `preview.redd.it`.
- Path patterns: `/r/<sub>`, `/user/<name>` or `/u/<name>`, `/r/<sub>/comments/<id36>/<slug>`, `/r/<sub>/s/<code>` (a share link that redirects to the canonical comments URL).
- Post id: base36, e.g. `1x4eiym`. The fullname is `t3_<id>`.
- No numeric id resolution is needed; everything is addressed by subreddit name or username.

## Primary technique: Atom RSS [LIVE]
- Subreddit, newest: `https://www.reddit.com/r/<sub>/new/.rss?limit=25`. Also `/hot/.rss` and `/top/.rss?t=day`.
- User posts: `https://www.reddit.com/user/<name>/submitted/.rss`. User comments: `/user/<name>/comments/.rss`. Both: `/user/<name>/.rss`.
- Multi-sub in ONE request (key to staying under the limit): `https://www.reddit.com/r/a+b+c/new/.rss?limit=100` [DOCS].
- Headers: any UA works, browser or descriptive (`linux:social-reader:0.1 (personal read-only feed reader)` returned 200 too). The response is `application/atom+xml`, about 25 entries by default (`limit` raises it up to 100).
- Rate headers on every RSS response: `x-ratelimit-used: 1`, `x-ratelimit-remaining: 0.0`, `x-ratelimit-reset: 20..58` (seconds). That means 1 request per minute per IP. The second request within the window got 429 with an empty body [LIVE].

## Response shape (Atom)
- `feed/entry`: `id` = `t3_<id>`; `title`; `link@href` = permalink; `published` and `updated` (ISO 8601).
- Author: `author/name` = `/u/<name>` (strip the `/u/`) and `author/uri`. Subreddit: `category@term` (or `u_<name>` for profile posts).
- `content` (type=html, entity-escaped): the selftext HTML wrapped in `<!-- SC_OFF --><div class="md">`. For link posts it holds `<a href="<external>">[link]</a>` and `[comments]`; take the `[link]` href as the external URL.
- `media:thumbnail@url` when there is a preview (`preview.redd.it`, `b.thumbs.redditmedia.com`). Full-size images: look for `i.redd.it` links in the content.
- Not present: score, comment count, gallery items, video URLs. RSS never exposes metrics.
- Feed-level `icon`/`logo` give the subreddit icon. There is no user avatar.

## Hosts to declare
`www.reddit.com`, `i.redd.it`, `preview.redd.it`, `external-preview.redd.it`, `b.thumbs.redditmedia.com`, `a.thumbs.redditmedia.com`, `v.redd.it` (videos, DASH only), `styles.redditmedia.com` (icons).

## Limits & politeness
- About 1 RSS request per 60 s per IP is the hard reality. This limit is shared across ALL Reddit actors on the machine.
- Wait at least 61 s between Reddit requests, or read `x-ratelimit-reset` and sleep that long plus 1 s.
- Combine subreddits with `+` into one request.
- Keep the default sync at 60 minutes or more.
- On 429, sleep until reset. Never loop.

## Failure signatures
- `GET /r/<sub>/new.json` and `/user/<u>/submitted.json` return 403, `text/html`, about 190 KB, page text "You've been blocked by network security. If you think you've been blocked by mistake, file a ticket below" [LIVE]. The same happens with a descriptive UA [LIVE]. Reddit has blocked anonymous `.json` since about 2026-05-30 [DOCS]. Do not retry it, do not fake fingerprints, and do not use proxies.
- `old.reddit.com/...json` returns 302 to `https://old.reddit.com/login/?reason=lor2&dest=...` [LIVE]. old.reddit is login-only when logged out.
- RSS 429 has an empty body plus `x-ratelimit-remaining: 0.0` [LIVE].
- Private or banned subreddits and suspended users: 403 or 404 on RSS [MEM].
- `limit` above 100 is ignored.

## Fallbacks (in order)
1. RSS (above): combine subs, 1 request per minute.
2. Personal RSS token, in the signed-in tier: the same RSS URLs with `?feed=<token>&user=<name>` appended. Reports say it works on public feeds and may relax throttling [DOCS, unverified]. It also unlocks the private front page `https://www.reddit.com/.rss?feed=<token>&user=<name>`.
3. `sr.browser('https://www.reddit.com/r/<sub>/new/')` capturing JSON (shreddit loads partials and `gql.reddit.com`/`/svc/shreddit/` HTML fragments). This is heavy and anonymous browsers may hit the same block page. Use only if RSS is gone.
4. Official OAuth API: app approval under the "Responsible Builder Policy" is manual and slow [DOCS]. Only if the user brings their own credentials.

## Signed-in tier (follow list / home feed)
- The user logs into reddit.com in the app's own browser profile.
- Subscriptions: in that browser context, `https://www.reddit.com/subreddits/mine/subscriber.json?limit=100` (`data.children[].data.display_name`, `url`, `icon_img`). Followed users appear as `u_<name>` subreddits. Logged-in `.json` should work because the cookies are the user's own, from our profile [MEM, unverified].
- Home feed: `https://www.reddit.com/.json?limit=50` or `/new/.json` inside the browser context. The JSON shape is `data.children[].data` with `{id, name, title, selftext, author, subreddit, permalink, url, created_utc, score, num_comments, thumbnail, preview.images[0].source.url, is_video, media.reddit_video.fallback_url, gallery_data, media_metadata}`. Set `raw_json=1` to avoid `&amp;`.
- Personal RSS: open `https://www.reddit.com/prefs/feeds/` in the profile and read the `feed=` and `user=` values from the private RSS links. Store them in `sr.state`; they come from the app's own profile, not the user's normal browser.

## Apify hints
- Since May 2026, Apify Reddit actors have split into three groups:
  - RSS-based (no scores or comments);
  - HTML/shreddit parsers;
  - headless-browser `.json` reads through residential proxies with "challenge warm-up".
- The last group crosses our evasion line. RSS plus the session tier is our path.

## Sketch
```python
import re, html, time, sr, xml.etree.ElementTree as ET
NS = {'a': 'http://www.w3.org/2005/Atom', 'm': 'http://search.yahoo.com/mrss/'}
subs = sr.input.get('subreddits') or []; user = sr.input.get('user')
url = (f'https://www.reddit.com/user/{user}/submitted/.rss' if user
       else f"https://www.reddit.com/r/{'+'.join(subs)}/new/.rss?limit=100")
r = sr.fetch(url, headers={'User-Agent': 'linux:social-reader:0.1 (personal read-only feed reader)'})
if r.status == 429:
    sr.log('reddit rss 429; retry next sync'); raise SystemExit(0)
root = ET.fromstring(r.text)
for e in root.findall('a:entry', NS):
    body = html.unescape(e.findtext('a:content', '', NS))
    ext = re.search(r'<a href="([^"]+)">\[link\]</a>', body)
    th = e.find('m:thumbnail', NS)
    sr.emit({'id': e.findtext('a:id', '', NS), 'url': e.find('a:link', NS).get('href'),
             'title': e.findtext('a:title', '', NS), 'html': body, 'text': sr.html_to_text(body),
             'publishedAt': e.findtext('a:published', '', NS),
             'author': {'name': e.findtext('a:author/a:name', '', NS).removeprefix('/u/'),
                        'url': e.findtext('a:author/a:uri', '', NS)},
             'links': [ext.group(1)] if ext else [], 'kind': 'post',
             'media': [{'type': 'image', 'url': th.get('url'), 'thumb': th.get('url')}] if th is not None else []})
```
