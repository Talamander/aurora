# Any site without a feed (events pages, blogs without RSS, listings, changelogs)
Status 2026-10-12: technique notes, not one platform. Verified on luma.com/sf (JSON-LD, 20 events) and github.com/<user> (Atom) [LIVE]. Best tier: http; browser only when the HTML is an empty JS shell.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Order of attack (stop at the first that works)
1. A real feed after all. Look in the HTML head for `<link rel="alternate" type="application/rss+xml|atom+xml|feed+json">`, then try `/feed`, `/rss`, `/atom.xml`, `/index.xml`, `/feed.json` [MEM]. If one exists, tell the user add_feed is enough and stop building.
2. schema.org JSON-LD: `<script type="application/ld+json">`. Walk every block recursively for `@type` in `Event`, `BlogPosting`, `NewsArticle`, `Article`, `VideoObject`, `Product`, or an `ItemList` of them. Events give `name`, `url`, `startDate`, `endDate`, `location{name,address}`, `organizer`, `image`, `offers` [LIVE on Luma].
3. Framework data in the HTML: `__NEXT_DATA__` (Next.js pages router), `self.__next_f.push` chunks (Next.js app router, string-escaped RSC, regex inside), `window.__NUXT__`, `__APOLLO_STATE__`, `__INITIAL_STATE__`, `data-sjs` / `data-props` attributes [MEM].
4. A JSON API the page calls: run browser_probe once and read the captured JSON URLs. Prefer calling that endpoint directly with sr.fetch if it needs no signature or token minted by page JS.
5. Plain HTML parsing (regex or `html.parser` from the stdlib): anchor on repeating card markup (`<article>`, `<li class="...event...">`, `<a href="/events/...">`).
6. sr.browser and parse the rendered `html` / `links` only when 1 to 5 fail.

## Mapping to RawPost
- `id`: the item's own stable slug or id from its URL (`/e/<slug>`, `/posts/<id>`); never the list position.
- `url`: absolute permalink of the item (resolve relative links against the page URL).
- `publishedAt`: the post or publish date. For events use the start time and say so in the summary (upcoming events will be dated in the future, which is expected). Never leave it empty when the page has any date.
- `title` for the headline, `text` for a one-paragraph summary (date, place, price for events), `media` for the card image.
- `author`: the site or organizer name, `url` the listing page.

## Generic actors
- One actor can read many pages of the same site through its input (city slug, calendar slug, user name).
- For "read any site the user names", take the page URL as input and set `"hostsFromInput": ["url"]` in the manifest, so the host is allowed per source without editing the manifest.

## Politeness and limits
- One page request per run, hourly or slower (events pages: every 3 to 6 hours is plenty).
- Re-emitting the same items each run is harmless (the feed dedupes by id) but use state to skip seen ids when the list is long.
- Respect `robots.txt` disallow rules for the exact path; if a page needs a login or shows a challenge page, stop and report it.

## Failure signatures
- 200 with a tiny body and only `<div id="root">`: JS shell, go to step 4 or 6.
- 403 or a Cloudflare "Just a moment..." page: bot protection. Do not try to get past it; report it.
- JSON-LD present but only `Organization` / `WebSite`: the list is not in JSON-LD; go to step 3.
