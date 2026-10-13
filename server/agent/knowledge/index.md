# Knowledge pack index

These are per-platform notes for building actors. Every status was checked live from the dev machine on 2026-10-12, with no login and no cookies. Each file marks every claim as [LIVE] (verified that day), [DOCS] (current docs, issues or blog posts) or [MEM] (memory, unverified). Before writing an actor, read the platform file, then re-probe the main endpoint once with `http_get`, because these platforms change weekly.

Tier order: api, then http, then browser, then session (the user logs into the app's own browser profile). Lines we hold: read-only, no CAPTCHA solving, no stealth or fingerprint evasion, no copying cookies from the user's normal browser, and polite volumes (hourly polling at most).

| Platform | URL patterns / hostnames | Best tier | Status 2026-10-12 | File |
|---|---|---|---|---|
| YouTube | youtube.com, www/m.youtube.com, youtu.be; `/@handle`, `/channel/UC…`, `/c/`, `/user/`, `watch?v=`, `/shorts/` | http (ytInitialData / innertube browse) | works. The official RSS `feeds/videos.xml` is mostly 404 (broken). | youtube.md |
| Instagram | instagram.com, www.instagram.com, instagr.am, ig.me; `/<user>/`, `/p/<code>/`, `/reel/<code>/` | http (profile HTML preloader; browser fallback) | partial. Logged-out you get the 12 newest posts. `web_profile_info` returns 401 `require_login`. | instagram.md |
| Threads | threads.com, www.threads.com, threads.net (301 to threads.com); `/@<user>`, `/@<user>/post/<code>` | http (SSR `data-sjs` JSON; browser for more) | works. You get 4 posts from the HTML; a scrolling browser gets more from `/graphql/query`. | threads.md |
| TikTok | tiktok.com, www/m.tiktok.com, vm/vt.tiktok.com; `/@user`, `/@user/video/<id>`, `/photo/<id>` | http (unsigned `/api/creator/item_list/` with secUid) | works. The SSR `itemList` is empty now. | tiktok.md |
| Facebook | facebook.com, www/m/web.facebook.com, fb.com, fb.me; `/<vanity>`, `/profile.php?id=`, `/<vanity>/posts/pfbid…` | browser (`/plugins/page.php` Page Plugin) | partial. You get 5 posts from the plugin, or 1 from plain HTML. mbasic is shut down. | facebook.md |
| X / Twitter | x.com, twitter.com, mobile.*, fxtwitter/vxtwitter/fixupx.com, xcancel.com, nitter.*; `/<handle>`, `/<h>/status/<id>` | http (FxTwitter API; x.com SSR HTML gives about 5 posts) | partial. Syndication timeline returns 429, guest GraphQL returns 404, xcancel returns 451, and nitter.net is offline. | x-twitter.md |
| Reddit | reddit.com, www/old/new/np/sh.reddit.com, redd.it, i/v.redd.it; `/r/<sub>`, `/user/<u>`, `/comments/<id>` | http (`.rss` Atom) | partial. `.json` returns 403 "blocked by network security". old.reddit sends you to login. RSS allows about 1 request per minute per IP. | reddit.md |
| LinkedIn | linkedin.com, *.linkedin.com, lnkd.in; `/company/<slug>`, `/in/<vanity>`, `/posts/…-activity-<id>`, `/feed/update/urn:li:activity:<id>` | http (company page SSR) | partial. You get the 10 latest company posts and some person posts, with no paging. | linkedin.md |
| Pinterest | pinterest.com + country TLDs, pin.it, i.pinimg.com; `/<user>/`, `/<user>/<board>/`, `/pin/<id>/` | api (`/<user>/feed.rss`, `/<user>/<board>.rss`) | works. Each feed returns 25 items. | pinterest.md |
| Snapchat | snapchat.com, www.snapchat.com; `/@<user>`, `/add/<user>`, `/spotlight/<id>` | http (`__NEXT_DATA__`) | partial. Content appears only for "Public Profiles" (live story, Spotlight, highlights). | snapchat.md |
| Bluesky | bsky.app, *.bsky.social, custom-domain handles, `at://`, `did:plc:` | api (`public.api.bsky.app` getAuthorFeed) | works. The built-in connector exists. | bluesky.md |
| Mastodon / Fediverse / Lemmy | any instance: `/@user`, `/users/user`, `@user@host`; Lemmy `/c/<comm>`, `/u/<user>` | api (`/api/v1/accounts/:id/statuses`, Lemmy `/api/v3/post/list`) | works | mastodon.md |
| Hacker News | news.ycombinator.com (`/user?id=`, `/submitted?id=`, `/item?id=`) | api (Algolia `search_by_date`) | works. hnrss.org is flaky (502 then 200). | hackernews.md |
| Telegram | t.me, telegram.me; `t.me/<channel>`, `t.me/s/<channel>`, `t.me/<channel>/<id>` | http (`t.me/s/<channel>` HTML) | works (public channels only) | telegram.md |
| Substack | `<pub>.substack.com`, custom domains, `substack.com/@<handle>`, open.substack.com | api (`/feed` RSS or `/api/v1/posts`) | works | substack.md |
| Patreon | patreon.com: `/<vanity>`, `/cw/<vanity>`, `/posts/<slug>-<id>` | http (`/api/posts?filter[campaign_id]=`) | works. Locked posts give metadata only. | patreon.md |
| Nostr | npub/nprofile/hex/NIP-05; njump.me, primal.net, snort.social, iris.to | api (relay WebSocket REQ) | works. api.nostr.band is down. | nostr.md |
| Twitch | twitch.tv, www/m.twitch.tv, clips.twitch.tv; `/<login>`, `/<login>/videos`, `/videos/<id>` | http (`gql.twitch.tv/gql` with public web Client-Id) | works | twitch.md |
| Kick | kick.com; `/<slug>`, `/<slug>/videos/<uuid>`, `/<slug>/clips/<id>` | http (`kick.com/api/v2/channels/<slug>`) | works | kick.md |
| Vimeo | vimeo.com, player.vimeo.com; `/<user>`, `/channels/<x>`, `/groups/<x>`, `/showcase/<id>` | api (`/<user>/videos/rss`) | works | vimeo.md |
| SoundCloud | soundcloud.com, m.soundcloud.com, on.soundcloud.com; `/<user>`, `/<user>/<track>`, `/<user>/sets/<x>` | http (hydration then `api-v2` with anonymous client_id) | works. Per-user RSS is empty for musicians. | soundcloud.md |
| Medium | medium.com/@user, `<user>.medium.com`, `medium.com/<pub>` | api (`/feed/@user`) | works | feeds-misc.md |
| Tumblr | `<blog>.tumblr.com`, tumblr.com/<blog> | api (`/rss`) | works. The v1 JSON API returns 403. | feeds-misc.md |
| GitHub | github.com/<user>, /<owner>/<repo> | api (`.atom` feeds) | works | feeds-misc.md |
| Letterboxd | letterboxd.com/<user> | api (`/<user>/rss/`) | works | feeds-misc.md |
| Goodreads | goodreads.com/user/show/<id>-<slug> | api (`/review/list_rss/<id>`) | works | feeds-misc.md |
| Podcasts (Apple / Spotify / RSS) | podcasts.apple.com/…/id<n>, open.spotify.com/show/<id> | api (iTunes lookup gives feedUrl; Spotify oembed title then iTunes search) | works. Spotify-exclusive shows have no RSS. | feeds-misc.md |
| Lobsters | lobste.rs (`/~user`, `/t/<tag>`, `/s/<id>`) | api (`.json` / `.rss`) | works | feeds-misc.md |
| Dev.to | dev.to/<user> | api (`/api/articles?username=`) | works | feeds-misc.md |
| Any site without a feed (events pages, listings, blogs without RSS) | any host | http (feed discovery, JSON-LD, framework data, then browser) | technique notes; Luma events [LIVE] | generic-site.md |
| Product Hunt | producthunt.com | api (`/feed` Atom, daily launches only) | partial. There is no per-user feed. | feeds-misc.md |

## Cross-cutting notes
- Default headers: a desktop Chrome UA. For Meta sites (Instagram, Threads, Facebook), also send normal navigation headers (`Accept: text/html…`, `Accept-Language`, `sec-fetch-dest: document`, `sec-fetch-mode: navigate`, `sec-fetch-site: none`). Without them, Meta returns an empty shell.
- Never send cookies copied from anywhere. Only the session tier (the app's own browser profile) carries the user's login.
- Session tier mechanics: the profile name is the manifest `platform` slug (`facebook`, `x`, `instagram`, `linkedin`). A `tier: "session"` actor calls `sr.browser(url, scroll=..., capture=...)` and the host renders it inside that profile; the actor sees only the page result, never cookies. `browser_profiles` lists which profiles exist. With no profile, call `request_login` (when available) and stop without installing.
- Same-host many-sites actors (Mastodon instances, Substack custom domains, generic site readers): use manifest `hostsFromInput` rather than hard-coding one instance.
- Media CDN URLs from Instagram, Threads, Facebook, TikTok and Telegram are signed and expire. Store them as thumbs, link the permalink, and re-fetch rather than hotlink long-term.
- Timestamps you can derive from ids:
  - Instagram media pk: `(pk >> 23) / 1000 + 1314220021.721` (unix seconds).
  - LinkedIn activity id: `id >> 22` (milliseconds).
  - Twitter/X snowflake: `(id >> 22) + 1288834974657` (milliseconds).
- Reddit RSS limit is about 1 request per minute per IP, shared across all Reddit actors. Combine subreddits (`/r/a+b+c/new/.rss`).
- Platforms with a public follow graph (useful for "import who I follow" without login):
  - Bluesky `getFollows`; Mastodon `/following`; GitHub `/following`; Nostr kind 3;
  - Substack `public_profile.subscriptions`; Letterboxd `/following/` HTML.
