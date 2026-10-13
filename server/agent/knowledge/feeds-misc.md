# Feed-friendly platforms (RSS/Atom/JSON, no actor usually needed)
Status 2026-10-12: all work logged-out (details per row). Best tier: api (feed). The built-in RSS connector handles every RSS/Atom URL below. Prefer "add feed" with the resolved URL; write an actor only for JSON-only sources or extra fields.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Medium — works [LIVE]
- Hosts: `medium.com`, `<user>.medium.com`, custom domains, `medium.com/<publication>`.
- Feeds, all 200 `text/xml` with 10 items each:
  - `https://medium.com/feed/@<user>`, `https://<user>.medium.com/feed`;
  - publication: `https://medium.com/feed/<publication-slug>`;
  - tag: `https://medium.com/feed/tag/<tag>` [MEM].
- Items carry `content:encoded` (full HTML for free posts, a snippet for member-only posts), `dc:creator` and `atom:updated`.
- Images come from `cdn-images-1.medium.com` / `miro.medium.com`.
- Only 10 items per feed. Hourly polling is fine.

## Tumblr — works (RSS) [LIVE]
- Hosts: `<blog>.tumblr.com`, `www.tumblr.com/<blog>`, `tumblr.com/<blog>/<postId>`.
- Feed: `https://<blog>.tumblr.com/rss` returned 200 with 20 items. `description` is NPF-rendered HTML with `<img src="https://64.media.tumblr.com/...">` and srcset.
- Tag feed: `https://<blog>.tumblr.com/tagged/<tag>/rss` [MEM].
- The v1 JSON API is gone: `https://<blog>.tumblr.com/api/read/json` gave 403 [LIVE].
- The v2 API (`api.tumblr.com/v2/blog/<blog>/posts?api_key=`) needs an OAuth consumer key from a registered app. Use it only if the user registers their own (free); do not create accounts.
- Media hosts: `64.media.tumblr.com`, `va.media.tumblr.com` (video).
- Dashboard (signed-in): capture `www.tumblr.com/api/v2/timeline/dashboard` in the app browser [MEM].

## GitHub — works [LIVE]
- Feeds: user public activity `https://github.com/<user>.atom` [LIVE, 30 entries, `media:thumbnail` avatar].
  - Repos: `https://github.com/<owner>/<repo>/releases.atom` [LIVE], `/tags.atom`, `/commits/<branch>.atom`.
  - Discussions: none.
- JSON: `https://api.github.com/users/<user>/events/public?per_page=30` [LIVE 200].
  - Repo releases: `/repos/<o>/<r>/releases?per_page=10`.
  - Unauthenticated limit: 60 requests per hour per IP (headers `x-ratelimit-remaining`) [DOCS]. Prefer Atom.
- The follow list is public: `api.github.com/users/<user>/following`.
- Hosts: `github.com`, `api.github.com`, `avatars.githubusercontent.com`.

## Letterboxd — works [LIVE]
- Feed: `https://letterboxd.com/<user>/rss/` returned 200 with 100 items. Items cover diary entries and reviews, plus list items.
- Extra tags: `letterboxd:filmTitle`, `letterboxd:filmYear`, `letterboxd:watchedDate`, `letterboxd:memberRating`, `letterboxd:rewatch`, `letterboxd:memberLike`, `tmdb:movieId`.
- The poster image is inside `description` HTML (`a.ltrbxd.com`). Declare `letterboxd.com` and `a.ltrbxd.com`.
- There is no public API. The follow list is HTML at `letterboxd.com/<user>/following/`.

## Goodreads — works [LIVE]
- Resolve: user URL `goodreads.com/user/show/<id>-<slug>`. The numeric id is needed.
- Shelf feed: `https://www.goodreads.com/review/list_rss/<id>?shelf=read` (also `currently-reading`, `to-read`, `%23ALL%23`). It returned 200 with 100 items.
  - Fields: `book_id`, `title`, `author_name`, `book_large_image_url`, `user_rating`, `user_read_at`, `user_date_added`, `user_review`, `link`.
- Activity feed: `https://www.goodreads.com/user/updates_rss/<id>` [LIVE, 10 items].
- The Goodreads API has been closed to new keys since 2020. Private profiles return an empty or login page.
- Declare `www.goodreads.com` and `i.gr-assets.com` (covers).

## Podcasts (Apple, Spotify, any RSS) — works [LIVE]
- Apple Podcasts: `podcasts.apple.com/<cc>/podcast/<slug>/id<NUM>` maps to `https://itunes.apple.com/lookup?id=<NUM>&entity=podcast`. Read `results[0].feedUrl` [LIVE: Hard Fork gave `https://feeds.simplecast.com/6HKOhNgS`].
- Search: `https://itunes.apple.com/search?term=<q>&media=podcast&limit=5` [LIVE].
- Spotify: a show URL `open.spotify.com/show/<id>` has no RSS.
  1. `https://open.spotify.com/oembed?url=<show url>` gives the `title` [LIVE 200].
  2. Search iTunes for that title and check that `collectionName` matches.
  3. Use `feedUrl`.
  - Spotify-exclusive shows have no RSS: report "Spotify-only, unsupported" plainly.
- Podcast Index (`api.podcastindex.org`) needs a free key and HMAC headers. Use it only if the user supplies a key.
- Feed items: `enclosure@url` (audio), `itunes:duration`, `itunes:image`, `pubDate`. Declare the feed host, the image host and the audio host (often redirect chains through `chrt.fm`, `pdst.fm`, `traffic.megaphone.fm`). Media are links only, so this needs no download.

## Lobsters — works [LIVE]
- JSON: `https://lobste.rs/newest.json`, `/hottest.json`, `/t/<tag>.json`, `/~<user>/stories.json` [MEM for user json]. Story detail: `/s/<short_id>.json`.
- Fields [LIVE]: `short_id`, `created_at`, `title`, `url`, `score`, `comment_count`, `description_plain`, `submitter_user`, `tags`, `short_id_url`, `comments_url`.
- RSS: `https://lobste.rs/~<user>/stories.rss` [LIVE 200], `/t/<tag>.rss`, `/rss`.
- Small volunteer-run site: poll no more than hourly.

## Dev.to (Forem) — works [LIVE]
- `https://dev.to/api/articles?username=<user>&per_page=30` returned 200.
  - Fields: `id`, `title`, `description`, `url`, `published_at`, `cover_image`, `tag_list`, `public_reactions_count`, `comments_count`, `reading_time_minutes`, `user{name,username,profile_image}`.
- Organizations: `?username=<org>`. Tag: `?tag=<tag>&top=7`. Body: `/api/articles/<id>` (`body_html`).
- RSS: `https://dev.to/feed/<user>` [MEM].
- Hosts: `dev.to`, `media2.dev.to`, `dev-to-uploads.s3.amazonaws.com`.

## Product Hunt — works (feed) [LIVE]
- Feed: `https://www.producthunt.com/feed` returned 200 `application/atom+xml` with 50 entries (today's launches). Category: `/feed?category=<slug>` [MEM].
- Per-maker and per-user feeds: none.
- The GraphQL API v2 needs a developer token from a free account. Use it only if the user supplies one.
- Profiles and products otherwise need `sr.browser`, and Cloudflare sits in front.

## Generic tips for every feed here
- Dedupe by `<guid>` / `<id>`, falling back to `<link>`.
- Send a normal UA. Honor `ETag`/`Last-Modified` (`If-None-Match`); `sr.fetch` passes headers.
- A 200 with HTML instead of XML usually means a login wall or a Cloudflare challenge. Report it plainly; do not retry in a loop.
