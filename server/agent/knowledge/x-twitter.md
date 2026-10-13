# X / Twitter
Status 2026-10-12: partial. Logged out, `x.com/<handle>` serves about 5 recent original posts in its SSR HTML, and a third-party JSON API (FxTwitter) returns 20 per page with paging. Every official logged-out timeline route is dead. Best tier: http (session tier for a real feed).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `x.com`, `twitter.com`, `mobile.twitter.com`, `mobile.x.com`, `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`, `xcancel.com`, `nitter.*`.
- Handle: the first path segment of `x.com/<handle>` (strip `@`, `?`, `/status/...`). Reserved first segments that are not handles: `home`, `i`, `search`, `explore`, `settings`, `messages`, `notifications`, `hashtag`, `intent`.
- Tweet id: `/status/(\d+)`. A snowflake id encodes time: `ms = (id >> 22) + 1288834974657`.
- Numeric user id: not needed for the techniques below. If you want it, it is in the SSR as `restId:"11348282"` and in FxTwitter as `author.id`.

## Primary technique A: x.com SSR HTML (official site, about 5 posts) [LIVE]
- `GET https://x.com/<handle>` with a desktop Chrome UA and no cookies returns 200 and about 167 KB. Since the 2026 web rewrite (TanStack Start + Relay, assets under `abs.twimg.com/x-web/`), the page embeds the dehydrated GraphQL results.
- Embedded operations: `UserByScreenName` (profile) and `UserOriginalsTimeline` (variables `count:20, cursor:null, sortByMostLiked:null`). Only about 5 tweets are actually included. The timeline is chronological, original posts only (no reposts, no replies).
- The format is seroval JS (`$R[66]={key:"..."}`), NOT JSON. Do not try `json.loads` on the whole script. Split on `tweet_results:` and regex inside each segment (see the sketch).
- Per tweet: `rest_id:"<id>"` (the first one in each segment), `details:{created_at_ms:<int>, full_text:"..."}`, `counts:{favorite_count, retweet_count, reply_count, quote_count, bookmark_count}`, `views:{count:"<str>"}`, `media_entities2:[{media_url_https, type:"photo"|"video", expanded_url}]`, author `core:{name, screen_name}` and `avatar:{image_url}` (the `_normal.jpg` suffix can become `_400x400.jpg`).
- `full_text` ends with a `https://t.co/...` media link; strip the trailing t.co link. Long posts (`NoteTweet`) may be truncated.
- Profile header data sits in the router state: `avatarUrl`, `bannerUrl`, `name`, `screenName`, `followers`, `tweets`, `restId`.

## Primary technique B: FxTwitter API (third-party, open-source FxEmbed) [LIVE]
- `GET https://api.fxtwitter.com/2/profile/<handle>/statuses` returns 200 JSON with `{code, results:[...], cursor:{top,bottom}}`, 20 to 21 statuses per page, newest first, and includes reposts. Paging: add `?cursor=<cursor.bottom>` [DOCS].
- Per status: `id`, `url` (the original author's URL), `text` (t.co links stripped), `raw_text.text`, `created_at` ("Mon Oct 12 21:32:24 +0000 2026"), `created_timestamp` (unix seconds), `author{id, name, screen_name, avatar_url, url}`, `reposted_by{screen_name,...}` (present means a repost), `replying_to`, `likes`, `reposts`, `replies`, `quotes`, `bookmarks`, `views`, `media.all[]{type:"photo"|"video"|"gif", url, thumbnail_url, width, height}`, `quote` (a nested status, when present), `lang`.
- It is not X; it depends on a volunteer service that could vanish or rate-limit. Poll gently (one request per source per hour). Label the actor notes "third-party".

## Single tweet (hydrate ids, e.g. from the SSR) [LIVE]
- `GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>&lang=en` returns 200 JSON: `text`, `created_at` (ISO), `user{name, screen_name, profile_image_url_https}`, `favorite_count`, `mediaDetails[]{type, media_url_https, video_info.variants[]}`, `photos[]`, `quoted_tweet`.
- The token is loosely checked (`token=a` worked today). The official formula is `((int(id)/1e15)*math.pi)` converted to base 36 with zeros and the dot removed [MEM].

## Hosts to declare
`x.com`, `api.fxtwitter.com`, `cdn.syndication.twimg.com`, `pbs.twimg.com` (images, avatars), `video.twimg.com` (mp4/m3u8), `abs.twimg.com` (only in a browser tier).

## Limits & politeness
- One x.com profile GET per source per sync (60 minutes or more).
- Back off on 429. Never rotate IPs or UAs.
- Guest tokens are unnecessary for the routes above; do not mint them repeatedly.

## Failure signatures
- `syndication.twitter.com/srv/timeline-profile/screen-name/<h>` returned 429 with the 20-byte body `Rate limit exceeded` on the very first request [LIVE]. The cdn.syndication variant also returned 429 today [LIVE], and 404 in another 2026 report [DOCS]. Treat it as dead, including the embed widget.
- Guest token: `POST api.x.com/1.1/guest/activate.json` with the public web bearer still returns `{"guest_token":...}` [LIVE]. But guest GraphQL `api.x.com/graphql/<qid>/UserOriginalsTimeline` returned 404 with an empty body [LIVE]. X hides auth-walled operations behind a 404 [DOCS]. Guest UserTweets worked for some people in August 2026 [DOCS], but the queryIds rotate every few weeks and requests are fingerprint-bound. Not worth it.
- Nitter/xcancel: X legal action in August and September 2026. xcancel suspended "until further notice" in mid-September and returns 451; nitter.net answers HTTP 200 with a static page whose meta description is "nitter.net is offline." (no content) [LIVE 2026-10-12]; xcancel.com/<h>/rss returned 451 [LIVE]. A few private instances (see the tracker status.d420.de) serve RSS behind bot checks. Do not rely on them, and do not solve their challenges.
- `publish.twitter.com/oembed` now 301s to `publish.x.com/oembed` [LIVE]. It covers single tweets only; not followed further.
- SSR wall: after about 5 posts, the logged-out page shows "See <name>'s full profile" plus "Log in or sign up for X". Scrolling triggers no further JSON fetches [LIVE, headless Chromium].
- Suspended or protected accounts have `profileStatus` other than `"Available"`, or `privacy.protected:!0`.
- Logged-out search redirects (307) to login [DOCS].

## Fallbacks (in order)
1. FxTwitter statuses (20 per page, includes reposts). Hydrate with x.com SSR or tweet-result if FxTwitter is down.
2. x.com SSR (about 5 posts). Good enough for hourly polling of most accounts.
3. `sr.browser('https://x.com/<h>')` and DOM text: it adds nothing over (2) when logged out.
4. Session tier.

## Signed-in tier (follow list / home feed)
- The user logs into x.com in the app's own browser profile.
- Then run `sr.browser('https://x.com/home', scroll=4, capture=r'/i/api/graphql/|api\.x\.com/graphql/')`. The legacy operation names are `HomeTimeline` ("For you") and `HomeLatestTimeline` ("Following" tab, chronological; prefer this one). For a profile: `x.com/<h>` gives `UserTweets`/`UserOriginalsTimeline`. For the follow list: `x.com/<h>/following` gives `Following` (`user_results.result.core.screen_name`).
- The 2026 rewrite renamed some operations, so do not hardcode names or queryIds. Walk every captured JSON body for objects with `__typename == "Tweet"` and `rest_id`.
- Accept both schemas: legacy `legacy.full_text`, `legacy.created_at`, `legacy.extended_entities.media[]`, `core.user_results.result.legacy.screen_name`; and new `details.full_text`, `details.created_at_ms`, `media_entities2[]`, `core.user_results.result.core.screen_name`.
- Reposts: `legacy.retweeted_status_result` or `retweeted_status_results`. Unwrap `TweetWithVisibilityResults` via `.tweet`.
- Read only. Scroll slowly (2 to 3 s between scrolls) and stop after the previously seen id (`sr.state['last_id']`).
- The repo also has an official-API bookmarks connector (`server/connectors/xApi.ts`, OAuth with the user's own dev app). Do not duplicate it.

## Apify hints
- Popular "no login" X actors (2026) either use guest-token GraphQL with frequent queryId refresh and residential proxies, or they are wrappers over paid APIs. twscrape needs account cookies.
- Our lines exclude the proxy and account-pool approaches, so stick to the routes above.

## Sketch
```python
import re, json, datetime, sr
UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'}
h = sr.input['handle'].lstrip('@').split('/')[-1]
iso = lambda s: datetime.datetime.fromtimestamp(s, datetime.timezone.utc).isoformat()
r = sr.fetch(f'https://api.fxtwitter.com/2/profile/{h}/statuses', headers=UA)
if r.status == 200 and r.json().get('results'):
    for t in r.json()['results']:
        a = t['author']
        sr.emit({'id': t['id'], 'url': t['url'], 'text': t.get('text'), 'publishedAt': iso(t['created_timestamp']),
                 'author': {'name': a['name'], 'handle': a['screen_name'], 'url': a['url'], 'avatar': a.get('avatar_url')},
                 'kind': 'repost' if t.get('reposted_by') else 'post',
                 'media': [{'type': 'image' if m['type'] == 'photo' else 'video', 'url': m['url'], 'thumb': m.get('thumbnail_url')}
                           for m in (t.get('media') or {}).get('all', [])],
                 'metrics': {'likes': t.get('likes'), 'reposts': t.get('reposts'), 'replies': t.get('replies'), 'views': t.get('views')}})
else:  # fallback: official SSR, ~5 originals
    html = sr.fetch(f'https://x.com/{h}', headers=UA).text
    seen = set()
    for seg in html.split('tweet_results:')[1:]:
        tid = re.search(r'rest_id:"(\d+)"', seg).group(1)
        ft = re.search(r'full_text:"((?:[^"\\]|\\.)*)"', seg); ts = re.search(r'created_at_ms:(\d+)', seg)
        if tid in seen or not ft or not ts: continue
        seen.add(tid)
        text = re.sub(r'\s*https://t\.co/\w+$', '', json.loads('"' + ft.group(1) + '"'))
        sn = re.search(r'screen_name:"(\w+)"', seg).group(1)
        sr.emit({'id': tid, 'url': f'https://x.com/{sn}/status/{tid}', 'text': text, 'publishedAt': iso(int(ts.group(1)) / 1000),
                 'author': {'name': sn, 'handle': sn, 'url': f'https://x.com/{sn}'}, 'kind': 'post',
                 'media': [{'type': 'image', 'url': u} for u in re.findall(r'media_url_https:"([^"]+)"', seg)]})
```
