# Performance at 100k posts

Aurora should feel instant with a big library. This page records how that is measured, what the
numbers were before and after the scale work, and what changed.

## Measuring

```sh
# 1. A scratch library of 100,000 synthetic posts. Never point this at your real data folder.
mkdir -m 700 /tmp/aurora-perf
node scripts/synth-library.ts /tmp/aurora-perf 100000

# 2. A server on a spare port, using that folder
PORT=4390 SOCIAL_READER_DATA=/tmp/aurora-perf node server/main.ts

# 3. The numbers (headless Chromium through playwright-core)
npm run perf -- --url http://127.0.0.1:4390
```

The synthetic library has 12 disabled sources labelled "Synthetic (perf test)", 1,500 authors,
three years of posts that get denser toward today, 12% long articles, about 22% with a picture,
2% duplicates, and read, saved and archived state like a real reader's. Every item is marked as
demo data. The script refuses to write into a folder that looks like a real Aurora data folder.

`npm run perf` only reads, apart from one thing: scrolling the feed marks the posts it scrolls past
as read, as it would for a person. So each run changes the scratch library a little. Compare runs
on freshly generated libraries.

## Before and after

100,000 posts, 96 MB of item JSON (13.5 MB with brotli). Both columns ran on the same machine on
freshly generated libraries, with the same `npm run perf` script. Before is 74247f1; after is this
branch.

| | Before | After |
|---|---:|---:|
| `GET /api/library`, repeat fetch (br) | 1,367 ms | 18 ms |
| `GET /api/library`, 304 revalidation | 980 ms | 11 ms |
| Web app manifest (`?items=chunks`, br) | n/a | 6 KB in 6 ms |
| Newest chunk (4,000 posts, br) | n/a | 543 KB in 18 ms |
| First post visible | 3,830 ms | 448 ms |
| Whole library in the browser | 3,830 ms | 2,205 ms (in the background) |
| Long tasks during load (sum / longest) | 2,281 / 2,011 ms | 328 / 197 ms |
| Search "sqlite" settles (includes 160 ms typing debounce) | 416 ms | 296 ms |
| Search "garden -giveaway" settles | 607 ms | 298 ms |
| Long tasks while scrolling 24,000 px | 3,076 ms | 390 ms |
| JS heap after load | 298 MB | 293 MB |

Before the change the page was frozen for about two seconds on load and for most of the time
while scrolling. Afterwards the newest posts show in under half a second, the rest arrive without
a noticeable pause, and scrolling stays smooth.

Server-side, filtering 100k posts went from 212 ms to about 150 ms warm.

## What changed

**The server caches the item list** (`server/db.ts`). Reading and parsing 100k rows takes most of a
second, and it used to happen on every library request. Now temporary triggers record which items
this connection changed, so after marking a post read only that row is read again.
`PRAGMA data_version` catches commits from any other connection, such as the MCP server or a
second process, and forces a full re-read. Unchanged items keep the same object, so caches keyed by
item stay warm.

**The library is chunked by week** (`server/libraryWire.ts`). The items are cut into one chunk per
calendar week of publish dates, and busy weeks are split at 4,000 posts. Each chunk is serialized
once and named by a hash of its bytes.
- The web app asks for a manifest: everything but the items, plus the list of chunks.
- It then fetches only the chunks it does not already have. A chunk asked for by its hash never
  changes, so the browser may cache it.
- Marking a post read and getting a change event now costs a 6 KB manifest and one chunk,
  instead of 13.5 MB to download and 96 MB to parse.

**The classic `/api/library` is unchanged on the wire.** The phone app, terminal client and
desktop shell use it. It is now built from the same chunk bytes, and it is byte-for-byte the old
output (a test checks this). Its compressed body is kept per ETag, so repeat fetches and 304s are
almost free. The phone's device-token route list (DEVICE_ROUTES) is unchanged.

**The newest posts come first** (`web/src/libraryLoader.ts`).
- On a cold start the app fetches the newest chunks until it has about 2,500 posts, and shows them.
- It then fetches the rest four at a time.
- While that runs, the feed header shows "loading older…".
- Pictures are routed through the image proxy chunk by chunk, as `proxyLibrary` does for a whole
  library.
- Servers without chunk support get the old full request.

**The filter's per-item work is done ahead of time.** The haystack, noise verdict, normalised
author and day are cached per item. As chunks arrive, `warmItems` computes them in 12 ms slices, so
there is no single 1.5 s pause. Timestamps sort as plain strings instead of with `localeCompare`.

**Re-filtering is incremental.** `applyFilters(items, spec, ctx, prev)` takes the previous result.
When only a few items changed, it evaluates just those items and slots them into place. Posts
marked read while scrolling are an example. It falls back to a full pass whenever anything else
changed, or when a changed item shares a dedupe key with another item. The feed and the view
counts in the lens dock both use this. A test checks that the result matches a full pass.

**Lookups by id are layered** (`web/src/itemIndex.ts`). When only some items were replaced, the
previous 100k-entry Map is kept and the replaced items sit on top of it. This avoids rebuilding the
Map after every read.

## Full-text search

Measured on the same kind of freshly generated 100k library, with the server from commit 155ceaa
(before) and with the FTS5 index (after). `npm run perf` prints the search rows when the server
has `/api/search`. See [search.md](search.md) for how the index works.

| | Before | After |
|---|---:|---:|
| Building the index from nothing | none | 1.4 s, in the background |
| Restart with the index already on disk | none | 0.4 s to check every post |
| Size of `search.db` | none | 75 MB (the library database is 136 MB) |
| `GET /api/search "sqlite"` (median of 7) | none | 51 ms |
| `GET /api/search "garden -giveaway"` | none | 44 ms |
| `GET /api/search "\"release paper\""` | none | 34 ms |
| `GET /api/search "compil"` (prefix) | none | 48 ms |
| `GET /api/search` with no match | none | 13 ms |
| More like this (`/api/items/:id/related`) | none | 129 ms |
| One edited post, then a search | none | 29 ms, the edit is found |
| Search "sqlite" settles in the feed | 309 ms | 317 ms |
| Search "garden -giveaway" settles | 319 ms | 319 ms |
| Best matches visible after the last keystroke | none | 406 ms |
| First post visible / whole library loaded | 515 / 2351 ms | 543 / 2324 ms |

The feed filter itself is unchanged, so its settle time is the same within noise. Best matches
first measured 903 ms, because the ranked request waited for the feed filter's 160 ms debounce,
then the filter's main-thread pass, then its own debounce. It now follows the typed text, so the
request runs while the feed filters.

The synthetic library is a worst case for the index: its text comes from about 100 words, so a
search for any one of them matches a fifth or more of the library and BM25 has to score tens of
thousands of rows. Real libraries have far more distinct words and shorter posting lists. Searches
are capped at the 300 best candidates before the recency nudge, which keeps the cost flat.

## After night two

The second night merged full-text search, alerts, Your week, Ambient, the theme studio, motion,
AI spend tracking, the follows importer and the accessibility pass. This section re-checks speed
with all of it in, and records what was fixed. Same machine, 100k synthetic posts, fresh copies of
one generated library for every run. Other work was running on the machine at the same time (load
average about 4 to 5), so differences under about 10 ms are noise.

Three more scripts cover what `npm run perf` cannot see:

```sh
# Cold start: spawns its own server on a fresh copy, probes it every 25 ms for 15 s, and opens a
# page right at listen and again while the search index builds.
node scripts/perf-startup.ts --data /tmp/aurora-perf-copy --port 4512

# In-process server timings: cold item read, Your week, and the alerts pass after 500 new posts.
# It writes to the folder, so give it a throwaway copy.
node scripts/perf-server.ts /tmp/aurora-perf-copy2

# What the first page load is made of (builds into a temporary folder, never web/dist).
node scripts/bundle-report.ts --top 25
```

"Before" is main at 406b6eb with everything merged; "after" is this branch.

| | Before | After |
|---|---:|---:|
| **Cold start** (perf-startup) | | |
| Process start to listening | 451 ms | 498 ms |
| First post, page opened the moment the server listens | 2,365 ms | 1,231 ms |
| First post, page opened while the search index builds | 1,034 ms | 428 ms |
| Longest the server stopped answering in the first 15 s | 1,083 ms | 139 ms |
| Library read and ready to send, in the background | n/a | 612 / 873 ms after start |
| Search index for 100k posts built | 1.4 s | 2.0 s (in smaller slices) |
| **Server** (perf-server) | | |
| Item list, cold read | 878 ms | 577 ms |
| Your week, numbers for one week | 170 ms | 74 ms |
| Item list after a sync of 500 new posts | 9 ms | 13 ms |
| Alerts pass, 5 keyword alerts over those 500 posts | 33 ms | 35 ms |
| `GET /api/week` (median of 5, over HTTP) | 142 to 255 ms | 94 ms |
| **Browser** (`npm run perf`) | | |
| `GET /api/library`, cold (br) | 462 ms | 448 ms |
| `GET /api/library`, repeat fetch | 21 ms | 20 ms |
| First post visible | 447 ms | 471 ms |
| Whole library in the browser | 2,232 ms | 2,307 ms |
| Long tasks during load (sum / longest) | 319 / 191 ms | 339 / 209 ms |
| Search "sqlite" settles | 295 ms | 302 ms |
| Best matches visible | 404 ms | 403 ms |
| `GET /api/search "sqlite"` (median) | 49 ms | 51 to 61 ms |
| Long tasks while scrolling 24,000 px | 183 to 609 ms over six runs | 0 to 60 ms over 13 runs |
| Palette open, first time / first results | not measured | 68 / 103 ms |
| Your week open, to the first card | not measured | 325 ms |
| Ambient open, to the first slide | not measured | 360 ms |
| Theme studio open, from the Look sheet | not measured | 77 ms |
| JS heap after load | 296 MB | 316 MB |
| **Bundle** (`npm run build`) | | |
| Entry JS (minified / gzip) | 540.9 / 172.5 KB | 428.6 / 135.8 KB |
| Entry CSS (minified / gzip) | 203.8 / 40.0 KB | 173.0 / 34.0 KB |
| JS and CSS fetched by a whole perf session | n/a | 143 KB (compressed) |

Your week and Ambient open times go through the palette (open, type, Enter) and include fetching
their code the first time. Opening them a second time is 70 to 90 ms
faster. The search API medians moved within the noise of a busy machine; the index itself is the
same size and shape.

### What changed

**Nothing blocks the first page at startup** (`server/main.ts`, `server/db.ts`,
`server/libraryWire.ts`, `server/search.ts`). Profiling a cold start found four things holding
the event loop: the static files compressed at brotli's highest quality on the main thread, the
synchronous read of 100k posts, serializing them into week chunks, and FTS5's `optimize`, which
merges the whole search index in one statement. Now:

- `store.warmItems()` reads the posts in 12 ms slices right after start, and API requests wait
  for it instead of starting a second, blocking read. Reading in table order and sorting in
  JavaScript is about 2.5 times faster than walking the date index, for the blocking path too.
- The library wire builds its chunks in slices (`prepare()`), and compresses the full-library
  body on libuv's thread pool.
- A static file missed in the cache is answered with quick brotli at once; the best-compressed
  copy is made later in the background, one file at a time, so it never starves the thread pool.
- The search index builds in 15 ms slices after the library is ready, and its segments are merged
  a little at a time instead of with `optimize`.
- The other startup jobs were already spread out and stay so: AI classification at 5 s (only with
  a provider), the alerts check at 8 s, the edition at 20 s, the Your week check every 30 s (only
  Sunday evening does work), the follows importer resumes at 4 s only when a job is pending, and
  the spend database opens on first use.

**Scrolling no longer stalls when it marks posts read** (`core/filter.ts`, `web/src/App.tsx`,
`web/src/format.ts`). The scroll variance seen during the search work was real. Scrolling marks
posts read every 1.2 s, and each batch re-filtered the feed and every view in the lens dock. When
a batch held a post with a duplicate (about 0.2% of posts), the incremental re-filter gave up and
ran a full pass over 100k posts for the feed and each lens: 200 to 300 ms. Whether a run hit one
depended on which posts it scrolled past. Now a changed post with copies re-checks just its
dedupe group. The incremental path also finds changed posts by position and drops old results by
object instead of by id. The side rail's three counts share one pass. Post timestamps use a cached
date formatter, which was building a new one per post per render.

**Your week computes in about a third of the time** (`core/week.ts`). It skips demo filtering
when everything is demo, indexes only the posts it needs by id, compares ISO dates as strings
before parsing, and caches each post's topics.

**Ambient opens faster** (`core/ambient.ts`). It built every post's slide twice (slides and the
person list) and sorted with `localeCompare`. Slides are now kept per post object and sorted as
plain strings.

**Rarely used surfaces load on first use** (`web/src`). Your week (`WeekEntry.tsx` keeps the
listener and the side-pane card), Ambient (`AmbientEntry.tsx`), the follows importer, alerts,
sources, and the QR encoder for friend invites are now separate chunks, alongside the theme
studio, workshop, reader, AI settings and spend, palette and sign-in, which already were. Sheets
show the usual skeleton while their code loads; Your week and Ambient show a plain full-screen
veil. The friends sheet itself stays in the entry chunk: the feed uses its thread, share and
weekly-card pieces, and splitting the file is a bigger change than this pass.

## Limits and notes

- For a second or two after a cold start, features that look at every post only see the newest
  ones. These include the palette, person pages, counts and archive. The feed header says it is
  still loading.
- The first full read after the server starts takes about 0.6 s and runs in slices right after
  start. API requests that arrive before it finishes wait for it rather than blocking the server.
- The server holds the item list, one serialized copy of every chunk, and their compressed copies.
  After the first perf run at 100k posts the server process used about 450 MB of memory (RSS);
  with everything from night two merged it was about 540 MB before this pass and 600 to 640 MB
  after it. The extra is mostly the search index, plus memory the thread pool's compression keeps
  after the first full-library request. A fresh server that has built its search index sits at
  about 510 MB. Before the first pass it used about 980 MB, because every request rebuilt the whole
  library.
- The phone app still downloads the whole library when it changes. Moving it to the chunked sync
  is the next step for very large libraries on mobile data.
