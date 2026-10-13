# Hacker News
Status 2026-10-12: works — Algolia `search_by_date` and the Firebase API both returned 200 with no auth. hnrss.org gave 502, then 200 on retry (flaky). Best tier: api.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `news.ycombinator.com`. Patterns:
  - `/user?id=<name>`, `/submitted?id=<name>`, `/threads?id=<name>` (comments), `/item?id=<n>`;
  - `/front`, `/newest`, `/best`, `/ask`, `/show`, `/favorites?id=<name>`.
- Usernames are case-sensitive. No id lookup is needed.

## Primary technique
- Posts by a user [LIVE]: `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_<name>&hitsPerPage=30`. In `tags`, a comma means AND and parentheses mean OR.
  - Comments by a user: `tags=comment,author_<name>`.
  - Both: `tags=author_<name>`.
  - Front page: `tags=front_page`.
  - Show HN or Ask HN: `tags=show_hn` or `ask_hn`.
  - Points threshold: `&numericFilters=points>100`.
  - Incremental: `&numericFilters=created_at_i>1760000000`.
- A keyword watch is a good "source" too: `search_by_date?query=rust&tags=story`.
- Firebase (official) [LIVE]:
  - `https://hacker-news.firebaseio.com/v0/user/<name>.json` gives `submitted[]`, a list of item ids that mixes stories and comments.
  - `/v0/item/<id>.json` returns one item.
  - `/v0/topstories.json`, `newstories`, `beststories`, `askstories`, `showstories` return up to 500 ids.
  - It is N+1, so prefer Algolia for lists.
- RSS:
  - `https://news.ycombinator.com/rss` (front page) [LIVE 200].
  - hnrss.org has rich feeds: `/submitted?id=`, `/threads?id=`, `/newest?points=100`, `/frontpage`. It is flaky today (502, then 200) [LIVE].

## Response shape (Algolia hit, [LIVE])
- id: `objectID`.
- time: `created_at` (ISO) and `created_at_i` (unix).
- author: `author` (no avatar exists on HN).
- story: `title`, `url` (external, may be null for Ask HN), `story_text` (HTML), `points`, `num_comments`.
- comment: `comment_text` (HTML), `story_id`, `story_title`, `parent_id`.
- `_tags` contains `story`/`comment`, `author_x` and `story_<id>`.
- permalink: `https://news.ycombinator.com/item?id=<objectID>`. The external link is a separate field; put it in `links`.

## Hosts to declare
`hn.algolia.com`, `hacker-news.firebaseio.com`, `news.ycombinator.com`, optionally `hnrss.org`.

## Limits & politeness
- Algolia: 10,000 requests per hour per IP [DOCS, long-standing].
- Firebase: no stated limit.
- Scraping news.ycombinator.com HTML is rate-limited aggressively (403 or a "Sorry" page). Avoid it except for favorites.

## Failure signatures
- Algolia returns 200 with `hits: []` for an unknown author. It does not 404, so check `nbHits`.
- Firebase returns the literal `null` for a missing user or item.
- hnrss.org gives intermittent 502s; retry once, then fall back.

## Fallbacks (in order)
1. Algolia.
2. Firebase `user.submitted` plus item fetches, limited to the first 30.
3. hnrss.org.

## Signed-in tier
- HN has no follow concept. Favorites are public: `https://news.ycombinator.com/favorites?id=<name>` (HTML, rows `tr.athing`).
- Upvoted items are private, and the read-only rule means no need to log in.

## Sketch
```python
import sr
u = sr.input["username"]; since = sr.state.get("since", 0)
r = sr.fetch(f"https://hn.algolia.com/api/v1/search_by_date?tags=story,author_{u}&hitsPerPage=30&numericFilters=created_at_i>{since}")
hits = r.json()["hits"]
for h in hits:
    sr.emit({"id": h["objectID"], "url": f"https://news.ycombinator.com/item?id={h['objectID']}",
             "author": {"name": h["author"], "handle": h["author"], "url": f"https://news.ycombinator.com/user?id={h['author']}"},
             "title": h.get("title"), "text": sr.html_to_text(h.get("story_text") or ""),
             "links": [h["url"]] if h.get("url") else [], "publishedAt": h["created_at"], "kind": "story",
             "metrics": {"points": h.get("points"), "comments": h.get("num_comments")}})
if hits: sr.save_state({"since": max(h["created_at_i"] for h in hits)})
```
