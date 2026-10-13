# Search and More like this

Aurora has two kinds of search, and they work together.

- **The feed filter** (`core/filter.ts`) runs in the browser on every post you have loaded. It
  decides which posts the feed shows. It matches whole words in the post, its title, author,
  links and quoted post.
- **Full-text search** (`server/search.ts`) is an SQLite FTS5 index on the server. It ranks posts
  by relevance and returns a short snippet for each. It also covers the bodies of saved articles
  and the notes on your highlights, and it matches the start of words, so `compil` finds
  "compilers".

While you type a search, the web app shows **Best matches** above the feed: the five most relevant
posts, with the matching words highlighted. The header says how many posts were ranked and how
many of them the feed filter misses (word starts, article bodies, highlight notes). The feed below
is unchanged, so filters and views behave exactly as before. "Hide" folds the block away.

The command palette (Ctrl/Cmd K) uses the same index for its Posts group, so it finds posts
anywhere in a large library, not only the newest ones.

## Search syntax

The syntax is the feed filter's, so the same text gives sensible results in both places.

| You type | Full-text search does |
|---|---|
| `sqlite wal` | posts with both words; each word also matches as a word start (`wal` finds "walk") |
| `"write ahead"` | the exact phrase |
| `sqlite -mysql` | leaves out posts with "mysql" (phrases work too: `-"hot take"`) |
| `from:ada rust` | "rust" in posts whose author name or handle starts with "ada" |
| `rust site:example.com` | "rust", then keeps posts linking to example.com |

A search made only of exclusions, such as `-crypto`, has nothing to rank. The API says so and the
web app shows only the feed filter's result. Quotes and words like `OR` or `NOT` inside your text
are treated as text, never as FTS5 operators.

## Ranking

Each post is one row with five columns, weighted for BM25: title 4, author 2.5, highlight notes 2,
post text 1, article body 0.6. The 300 best rows are then nudged by age: a post from today counts
up to 25% more than a much older one, so among equally good matches the recent ones come first.

## More like this

Every post has "More like this": in the post's "Why" panel, with the `i` key, and as the agent's
`related_posts` tool. It works like a small search engine query built from the post itself.

1. Take the post's words (title counted twice, plus its article body when there is one), leaving
   out short words, numbers and common English words.
2. Score each word by how often it appears in this post and how rare it is in the library
   (TF-IDF, using FTS5's own document counts). Words found in more than a fifth of the library
   only count when too few rarer ones are shared, which happens in small or uniform libraries.
3. Search for the ten best words with OR and rank with BM25.
4. Boost posts by the same author (x1.3) and posts that share one of your topics (x1.15 per topic),
   then apply the same age nudge as search.
5. Drop the post itself and its duplicates, and drop posts that share only one word unless the
   author or a topic backs it up.

The sheet shows each result with why it is there: "same author", shared topics, and the shared
words.

## The index

- It lives in `search.db` next to the library database, with owner-only permissions. It is a
  cache: delete it while Aurora is stopped and it is rebuilt on the next start. Back up the
  library database, not this file.
- On start, Aurora waits 2.5 seconds and then builds or checks the index in the background, in
  40 ms slices so requests keep being answered. At 100k posts a build from nothing takes about
  1.4 seconds, and a restart with the index on disk takes about 0.4 seconds, because each row
  keeps a signature of its text and only changed posts are rewritten. `GET /api/search/status`
  reports `{ indexed, total, building }`, and Best matches shows the progress while it builds.
- After that it stays in sync on its own. Before every search, the server compares its item list
  with what it indexed. Unchanged posts are skipped by object identity, and changes that only
  touch read or saved state are skipped too. New, edited and removed posts are picked up, and so
  are saved articles and highlight notes. A library change also schedules a sync 1.5 seconds
  later, so the index is warm before the next search.
- Snippets come back as plain text with match ranges (`{ text, ranges: [[start, end], ...] }`),
  never HTML. The web app splits the text at the ranges and wraps the matches in `<mark>`, so a
  post containing markup can never inject it.

## API

All routes are behind the owner lock like the rest of `/api`.

- `GET /api/search?q=...&limit=20&profile=...` returns
  `{ query, results: [{ id, score, snippet }], matched, ms, index, unsupported? }`. Results are
  limited to what the active profile (or the given one) can see; `profile=all` searches
  everything.
- `GET /api/items/:id/related?limit=10&profile=...` returns
  `{ id, results: [{ id, score, shared, sameAuthor, topics }] }`.
- `GET /api/search/status` returns `{ indexed, total, building }`.

## The agent

`search_posts` keeps its output, but when a query is given it now ranks with the index: posts
that pass the other filters come back best match first, followed by any word-filter matches the
index did not rank. It also finds words in article bodies and highlight notes. `related_posts`
takes a post id and returns similar posts, each with the words it shares.

## Limits

- Matching is by word start, not anywhere inside a word: `gres` does not find "postgres".
- Words are split the way SQLite's `unicode61` tokenizer splits them, with accents folded, so
  `cafe` finds "café". Languages written without spaces, such as Chinese or Japanese, match only
  whole runs of text.
- `site:` is applied after ranking, on up to 1,200 candidates.
- The MCP server (`server/mcp.ts`) still uses the plain word filter for `search_posts`, because it
  opens the library read-only and must not write the index.
- The phone app has no search screen yet, so it has no search route.
