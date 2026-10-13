# Front page

The front page sets today's best posts for the active profile like the front page of a newspaper:
a masthead with the date and the profile's name, a lead story, two or three stories under it, an
"In brief" column of short posts, a strip of pictures, and a "From your people" box. It is a calm
way to see what mattered today without scrolling the whole feed.

Everything is picked and laid out on your own computer from the library Aurora already has. The
front page makes no AI calls, and nothing on it was written by anyone but your sources.

## Opening it

- **Command palette.** Press Ctrl/Cmd K and choose "Front page" (also found by typing "paper",
  "headlines", "today" or "digest").
- **What's new.** The "Front page" entry under "Also new", with a "Read the front page" button.
- **URL.** Add `?front=1` to the address. The parameter is removed once the page opens.

Press Escape or the close button to go back to the feed. Clicking any story opens it the same way
the feed would: articles open in the reader (and are marked read in Aurora), other posts open in
the post view. Opening a story never marks anything on the source account.

## How stories are picked

The ranking lives in `core/frontPage.ts` and uses only signals already in the library:

- **Same filters as the feed.** Posts hidden by your filters, noise rules or AI rules are left
  out, as are archived posts. Of a set of duplicates only the primary copy is considered.
- **Recency.** Posts from the last 36 hours are news. If fewer than 12 qualify (a quiet day, or a
  library that has not refreshed for a while), the 160 newest posts are used instead, and the
  masthead says how old the newest post is when it is more than three days old.
- **Score.** Freshness counts most and halves every 18 hours. Unread posts, articles with a
  title, posts with a picture and longer posts score higher. Sources you save from often get a
  boost (saved posts over all posts from that source, smoothed so one save from a small source
  does not dominate). Likes and reposts add a small, capped bonus where the source reports them.
- **Lead.** The best story with a picture and something to read; failing that, the best story
  with a picture; failing that, the best story of all, set as a large banner headline.
- **Secondary stories.** Up to three substantial stories (an article, a post with a real
  standfirst, or a picture), one per source while there are other sources, then from any source.
- **In pictures.** Up to six picture posts.
- **From your people.** Up to four people whose posts you have saved or read most, each with
  their best story not already on the page.
- **In brief.** Up to seven of the remaining stories.

No story appears twice. Headlines are an article's title, or a post's first sentence when it is
short enough, otherwise its opening words.

## Layout and type

At desktop widths the page uses a broadsheet grid: the lead and the secondary row on the left, In
brief in a ruled column on the right, then pictures and your people across the full width. It
narrows to a single column on phones. Headlines and standfirsts use the reader font (Literata),
loaded only when the front page opens, and colours come from the current theme in both dark and
light.

## Safety

Post text is untrusted and is only ever rendered as text, never as HTML. Pictures are shown only
when they are https URLs or already go through Aurora's local image proxy, and every image is
loaded without a referrer.

## Caveats

- With few sources the secondary row repeats sources, and with few pictures the lead is set as
  text and the pictures strip is hidden.
- The front page is a desktop and web view; the phone app has no separate front page yet, though
  the web page reflows to phone widths.
