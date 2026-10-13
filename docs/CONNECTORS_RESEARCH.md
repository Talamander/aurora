# Connectors Research

Verified on: 2026-10-12. Sources are official docs unless marked "third-party". Items marked "live-tested" were probed with curl from this machine on that date. Items marked "unverified" could not be confirmed against an official source this session; treat them as leads, not facts.

## 1. X (Twitter): bookmarks

**Endpoint.** `GET https://api.x.com/2/users/{id}/bookmarks`. `{id}` must be the numeric ID of the authenticated user, since bookmarks are private to the user who made them. Paging uses `max_results` (1 to 100; the spec gives no default) plus `pagination_token`, and responses carry `meta.next_token` / `meta.previous_token`. Expansions and fields follow the usual v2 parameters (`tweet.fields`, `expansions=author_id,attachments.media_keys`, `user.fields`, `media.fields`).
Source: https://docs.x.com/x-api/users/get-bookmarks

**Auth.** Use OAuth 2.0 Authorization Code with PKCE (a user-context token), or OAuth 1.0a user context.
- Authorize URL: `https://x.com/i/oauth2/authorize`. Token URL: `https://api.x.com/2/oauth2/token`.
- Required scopes: `tweet.read users.read bookmark.read`. Add `offline.access` to get a refresh token. Without it, the access token dies after 2 hours and there is no refresh.
- The authorization code expires in 30 seconds. `code_challenge_method` accepts `S256` or `plain`.
- A local app can register as a public client (Native App, which sends `client_id` in the body and has no secret) or as a confidential Web App (which has a client secret). The redirect URI must be registered, e.g. `http://127.0.0.1:<port>/callback`.
Source: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code

**Rate limit.** 180 requests per 15 minutes per user. No per-app limit is listed. Rate limits and billing are separate, so staying under the limit still costs money.
Source: https://docs.x.com/x-api/fundamentals/rate-limits

**Pricing (current model).** Pay-per-use launched on 2026-02-06. You buy credits up front in the Developer Console, with no subscription or minimum spend.
- "Owned Reads" cost $0.001 per resource returned, effective 2026-04-20, and `/2/users/{id}/bookmarks` is explicitly one of them. Example: reading 1,000 bookmarks costs about $1.
- Standard Post reads cost $0.005 per resource. There is a 3M Post-read cap per billing cycle.
- Resources are deduplicated within a 24-hour UTC window (soft guarantee). You can set a spending cap per cycle.
- Promotional credits (changelog 2026-10-02): new pay-per-use accounts can earn up to $70 in free credits.
- Legacy Basic/Pro plans still exist for existing subscribers only.
Sources: https://docs.x.com/x-api/getting-started/pricing , https://docs.x.com/changelog

**Free tier.** The official pricing page no longer lists a Free tier. The changelog mentions only "Legacy Free tier users", who received a $10 voucher on 2026-02-06. Third-party guides say Free closed to new signups that day. Verdict: no free path to read bookmarks for a new developer account. In practice, budget a few dollars of credits.

**Known caveat (unverified).** Older docs said the endpoint returns only the ~800 most recent bookmarks. The current docs do not state a cap. Test with a real account.

**ToS notes for a personal reader.** You need an approved developer account plus a Project/App in the Developer Console. Store tokens locally, never commit them. Displaying your own bookmarks to yourself is the intended use. Respect deletions: if the app re-syncs, drop posts the API no longer returns. The 2026-04-16 changelog removed Following, Likes and Quote-Posts *writes* from self-serve tiers; reads of owned data stay.

**Fallback: the official archive.** Settings > Your account > Download an archive of your data. The archive contains `data/tweets.js`, `data/like.js` and so on: JS files that wrap JSON (`window.YTD.<name>.part0 = [...]`). Bookmark status is **unverified and conflicting**:
- A recent third-party post says newer archives include `data/bookmark.js`, holding only `tweetId` and `bookmarkedAt`, with no text, author or media.
- Other third-party guides (from vendors who sell exporters) say bookmarks were never included.
- The X help page returned 403 to our fetcher.
Verdict: request an archive and inspect it. Even if `bookmark.js` exists, you still need IDs plus hydration (API or exporter) to get the content.
Third-party: https://devcommunity.x.com/t/bookmarks-in-archive-download/137707

**Fallback: browser-extension exporters.** `prinsss/twitter-web-exporter` is a userscript that captures the web app's own GraphQL responses while you scroll. It makes no calls to the X API. It supports bookmarks, likes, home/list timelines, search and more, and exports JSON, CSV or HTML.
Caveats: it only works on the web app, captures only what you scroll past, and breaks when the site changes.
Field names, read from source (`src/components/table/columns-tweet.tsx`, commit ddf2b0c, 2026-08-31). Each exported tweet object has these keys:
- `id`: tweet rest_id (string)
- `created_at`: formatted string, default format `YYYY-MM-DD HH:mm:ss Z` (user-configurable). It is not Twitter's raw date.
- `full_text`, `screen_name`, `name`, `profile_image_url`, `user_id`, `in_reply_to`
- `media`: array of `{ type, url, thumbnail, original, ext_alt_text }`
- `retweeted_status`, `quoted_status`: the source tweet's ID, or empty
- `media_tags`
- `favorite_count`, `retweet_count`, `bookmark_count`, `quote_count`, `reply_count`, `views_count`
- `favorited`, `retweeted`, `bookmarked`
- `url`: tweet permalink
- `metadata`: present only when "Include all metadata" is checked. It holds the raw GraphQL tweet object.
Source: https://github.com/prinsss/twitter-web-exporter
Note: scraping the web app is a grey area under X's ToS. Importing a file the user exported themselves keeps our app clean.

## 2. Bluesky (AT Protocol)

**Public, unauthenticated.**
- Endpoint: `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle|did>`. Live-tested: returns 200 JSON with no auth.
- Params: `limit` 1 to 100 (default 50; live-tested that 101 is rejected), `cursor`, `filter` (`posts_with_replies` default, `posts_no_replies`, `posts_with_media`, `posts_and_author_threads`, `posts_with_video`), `includePins`.
- Official docs say `public.api.bsky.app` and `api.bsky.app` "do not support authentication". The public host is cached, and Bluesky asks developers to use it for "public web" use cases. Rate limits are "generous" with no published number, and the docs say to contact Bluesky if you hit them.
Sources: lexicon https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json ; rate limits https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md (docs moved from docs.bsky.app to https://bsky.network/docs/, which is JS-rendered)

**Authenticated home timeline.** `app.bsky.feed.getTimeline` takes `limit` 1 to 100 (default 50) and `cursor`. Call it through the user's PDS (e.g. `https://bsky.social` or the PDS resolved from the DID), which proxies to the AppView.
- Auth options:
  - (a) An app password via `com.atproto.server.createSession`. Bluesky says single-purpose tools and CLIs may use this.
  - (b) atproto OAuth (PKCE + PAR + DPoP). Bluesky recommends it for apps with their own login flow.
- For a single-user local reader, an app password is the simplest acceptable choice. Persist the session and refresh it with `refreshSession` instead of logging in repeatedly.
- PDS limits: 3000 requests per 5 minutes per IP overall. `createSession` is limited to 30 per 5 minutes and 300 per day per account. A third-party report says bsky.social's live login limit is stricter (10 per day).
- Cost: free.
Sources: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getTimeline.json , https://atproto.com/guides/sdk-auth , https://bsky.network/docs/oauth-client/

**RSS.** `https://bsky.app/profile/<handle>/rss` is live-tested and returns 200 `application/xml` RSS 2.0, with no auth.
**Export.** Settings > Account > Export my data downloads a CAR repo file. Alternatively, call `com.atproto.sync.getRepo`. The export contains your own records only (posts, likes), not a timeline.

## 3. Mastodon

- **RSS:** `https://<instance>/@<user>.rss` gives public posts. Live-tested on mastodon.social, returning 200 `application/rss+xml`. Hashtag feeds `/tags/<tag>.rss` also exist. Admins or users can disable feeds per instance.
- **Home timeline:** `GET /api/v1/timelines/home` requires a user token with scope `read:statuses`. `limit` defaults to 20, max 40. Pages with `max_id` / `since_id` / `min_id`.
- **Bookmarks:** `GET /api/v1/bookmarks` requires scope `read:bookmarks`. `limit` defaults to 20, max 40. Paginate *only* via the `Link` header (`rel="next"`/`"prev"`), because bookmark IDs are internal.
- **Auth:**
  - Register an app per instance with `POST /api/v1/apps`, then use the OAuth 2 authorization code flow.
  - Request the narrowest scopes: `read:statuses read:bookmarks` (plus `read:accounts` for `verify_credentials`).
  - Simpler alternative: Preferences > Development > New application, which generates a personal access token for your own account.
- **Rate limits (defaults):** 300 requests per 5 minutes per account and 300 per 5 minutes per IP. Headers: `X-RateLimit-Limit/Remaining/Reset`.
- **Cost:** free. Instance rules and policies apply.
- **Export:** Preferences > Import and export gives CSVs (follows, lists, bookmarks, blocks) and an ActivityPub archive of your own posts.
Sources: https://docs.joinmastodon.org/methods/timelines/ , https://docs.joinmastodon.org/methods/bookmarks/ , https://docs.joinmastodon.org/api/rate-limits/

## 4. Reddit

- **RSS:**
  - Subreddit feeds (`https://www.reddit.com/r/<sub>/.rss`) work. Live-tested: 200 `application/atom+xml`.
  - User feeds (`/user/<name>/.rss`) returned 429 in our tests, so expect throttling. Send a descriptive User-Agent and poll slowly.
  - Unauthenticated `.json` returned 403 in our tests.
- **API access state:**
  - reddit.com, redditinc.com and the Reddit help center all blocked our fetcher, so the official text is unverified.
  - Third-party reports agree that since the Responsible Builder Policy (updated 2025-11-11), every new app or OAuth client needs manual approval, including personal "script" apps. Approvals are reported as slow or often denied.
  - Free access is non-commercial and capped at about 100 queries per minute per OAuth client.
  - Commercial use is paid, priced historically at $0.24 per 1K calls (unverified for 2026).
  - Existing approved credentials keep working.
- **Saved items:** `GET https://oauth.reddit.com/user/<username>/saved` takes scope `history` ("comments or submissions I've saved or hidden"; the `save` scope only writes). It is a standard listing: `limit` max 100, `after`/`before`, and about 1,000 items deep.
Source: https://github.com/reddit-archive/reddit/wiki/oauth2
- **Fallbacks:**
  - (a) Personal private RSS feeds for saved items, linked from reddit.com/prefs/feeds with a `feed=` token. Long-standing, but unverified for 2026.
  - (b) A GDPR data request (reddit.com/settings/data-request) returns CSVs, including saved posts and comments.
  - Verdict: use RSS for subreddits. Use a data-request import for saved items unless API approval is granted.

## 5. YouTube

- **RSS:** `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` takes no auth and returns Atom with roughly the latest 15 entries. Playlist variant: `?playlist_id=UU<rest-of-channel-id>`.
- **Live-test result:** every channel we tried returned **HTTP 500**, and the playlist variant returned 404.
- Third-party reports (Invidious issues, n8n and Google AI forums, Oct 2026) describe intermittent or persistent 404/500 errors since late 2025, often worse from datacenter IPs. Treat RSS as best-effort: poll gently and back off.
Third-party: https://github.com/iv-org/invidious/issues/6074
- **Reliable fallback: YouTube Data API v3.**
  - Use an API key for public data, or OAuth (`youtube.readonly`) to read your own subscriptions.
  - `channels.list` (to get the uploads playlist) and `playlistItems.list` cost 1 unit each, from a default 10,000 units per day.
  - The quota page currently says `search.list` has its own bucket of 100 calls per day at 1 unit each. Avoid search anyway.
  - Cost: free within quota.
Source: https://developers.google.com/youtube/v3/determine_quota_cost
- **Export:** Google Takeout (YouTube) includes subscriptions as CSV, which you can use to seed the channel list.

## 6. Threads, Instagram, LinkedIn, Facebook

None of these offer an official API for reading your personal home feed.
- **Threads:**
  - The Threads API (graph.threads.net) covers publishing plus reading and displaying *your own* posts and replies. Scopes: `threads_basic`, `threads_content_publish`, `threads_manage_replies`, etc.
  - Limits: 250 posts per day per profile.
  - No home-feed endpoint is documented.
  - Export: Instagram/Threads "Download your information" via Accounts Center.
  Source: https://developers.facebook.com/docs/threads/overview
- **Instagram:**
  - The Basic Display API shut down on 2024-12-04.
  - "Instagram API with Instagram Login" works only with Professional (Business/Creator) accounts and returns only their own media. No feed access.
  - Export: Accounts Center > Download your information (JSON/HTML).
  - Third-party summary: https://github.com/pocketbase/pocketbase/pull/5588
- **Facebook:**
  - News Feed reading (`read_stream`) was removed years ago. `user_posts` (your own posts) requires App Review.
  - Export: Download Your Information (JSON).
  - Unverified this session.
- **LinkedIn:**
  - Member feed APIs are restricted to approved partners, and self-serve products cover sign-in and posting only.
  - Export: Settings > Data privacy > Get a copy of your data (CSV, including saved items/articles).
  - Unverified this session.

## 7. Recommended connector order for the prototype

1. RSS/Atom ingest (Bluesky, Mastodon, subreddits, YouTube best-effort). Free, no auth.
2. Bluesky `getAuthorFeed` via the public AppView (no auth), then `getTimeline` via an app password.
3. Mastodon home timeline and bookmarks via a personal access token.
4. File importers: twitter-web-exporter JSON, the X archive (`tweets.js`/`like.js`/`bookmark.js` if present), and the Reddit data-request CSV.
5. X bookmarks API, optional and paid: about $0.001 per bookmark, OAuth2 PKCE, user's own credits.

## 8. Local credential check (2026-10-12)

Only names were checked; no secret values were read.
- Environment variable names matching `X_|TWITTER|BLUESKY|BSKY|MASTODON|REDDIT`: none found.
- Config paths: `~/.config/twurl`, `~/.twurlrc`, `~/.config/toot`, `~/.config/tut`, `~/.config/rtv`, `~/.config/tuir`, `~/.config/praw.ini`, `~/.praw.ini`, `~/.config/bsky*`, `~/.config/bluesky*`, `~/.config/atproto*`, `~/.config/mastodon*`, `~/.config/twitter*`, `~/.config/gallery-dl`: none found.
- Project dir: no `.env*` files.
Result: no existing social connector credentials on this machine.
