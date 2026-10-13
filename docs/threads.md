# Thread reader

People write longform on social sites as threads: one post, then a reply to themselves, then
another. Aurora folds those chains into one card in the feed and opens the whole thread in the
Reader as a single article.

## How a thread is found

Grouping lives in `core/threads.ts`. It is pure, makes one pass over the library, and never
changes what is stored. A post joins a thread in one of two ways, and never across authors.

**Explicit replies.** When a source says which post a post replies to (`replyTo` on the item),
and that parent is in the library with the same author on the same platform, the two are linked.
Chains are walked back to their first post. Bluesky (`record.reply.parent`), the X API
(`referenced_tweets` of type `replied_to`) and the X archive importers (`in_reply_to_status_id`)
fill this in. A reply to someone else is never part of a thread, even if that person later replies
back.

**Numbered posts.** Feeds and sources without reply data still show threads by numbering them.
Posts join when all of these hold:

- same source, same platform and same author;
- the post carries a number at the start or end of its text: `1/`, `2/7`, `(3/7)`;
- the number is one more than the post before it in the chain (after a bare 🧵 opener, `1` or `2`);
- it arrives within 15 minutes of the post before it;
- any totals agree (`2/7` never follows `1/9`).

A thread only starts at `1/` or a 🧵. A lone `4/5`, a skipped number, a long gap, a fraction like
`1/2 cup` in the middle of a sentence, a date or a URL path does not start or join anything.
Reposts are skipped. A group needs at least two posts.

## In the feed

The thread shows as one card at the place of its newest visible post, reading from the first
post. The header has a small "Thread · 7" chip (just the count on narrow screens and in Columns).
Under the first post, the next two posts hang off a thin line, then "N more" and a button,
"Read the thread · 7 posts · 4 min". Compact density shows the button only. `Enter`, `o` or `r` on
the card opens the Reader too.

Columns folds threads the same way inside each column.

## In the Reader

The server builds the article for the thread's first post (`/api/articles/:id`) and saves it like
any other article, so EPUB export, highlights and reading position work as usual. Each post
becomes its paragraphs with the numbering removed, its pictures inline (video posts show the
thumbnail with "Video: open the post to play it"), any quoted post as a quote, and a small
"3 of 7" link to that post on its site. The article is rebuilt when a new post joins the thread.

Post text stays plain text. Nothing from a post is rendered as HTML, and only `https` images are
shown.

## Actions

Read, save and archive on a thread card apply to every post in the thread. All of it is local:
nothing is liked, bookmarked or changed on the source account.

## Turning it off

More settings has a "Threads" section with "Show threads as one card". It is on by default and
stored as `ui.threads`. Off, every post shows on its own and the Reader shows the first post alone.

## Phone app

The phone feed folds threads into one card with a "Thread · N posts · read it as one" line, and a
tap opens the thread article. Save, hide and mark read cover the whole thread. The phone app does
not read the `ui.threads` setting yet, so threads are always folded there.

## Performance

Grouping 100,000 posts takes about 15 ms on this machine (the test asserts under 120 ms). The
result is cached per library snapshot, so the feed only pays it when the library changes.

## Limits

- Mastodon, RSS and other sources without reply data only get numbered threads.
- The Reader marks the first post read when you reach the end; marking from the feed covers every
  post.
- The article title repeats the first line of the first post.
- No AI is involved anywhere in this feature.
