# Bring your follows

Moving to Aurora shouldn't mean re-following hundreds of accounts by hand. Bring your follows
reads the following lists in the data exports platforms already give you and turns them into
Aurora sources in one move.

Open it from the first-run screen ("Bring your follows"), from Sources & imports, from the
command palette (Ctrl/Cmd K, "Bring your follows"), or ask the AI to "import my follows".

## What it reads

| Platform | What to drop | Where to get it |
|---|---|---|
| YouTube | `subscriptions.csv`, or the whole Takeout ZIP | takeout.google.com: pick only "YouTube and YouTube Music", then keep only subscriptions |
| Instagram | `following.json` (or `followers_and_following/following.json`), the HTML variant, or the ZIP | Accounts Center, Your information and permissions, Download your information, "Followers and following", JSON |
| TikTok | `user_data.json` (or `user_data_tiktok.json`), `Following.txt`, or the ZIP | Settings and privacy, Account, Download your data, JSON |
| Mastodon | `following_accounts.csv` | Preferences, Import and export, Data export, Follows |
| Reddit | `subscribed_subreddits.csv`, or the ZIP | reddit.com/settings/data-request |
| Substack | any export or CSV that lists `name.substack.com` links, or paste the links | your Substack settings |
| Bluesky | nothing: type your handle | Aurora reads your public follows through the open `app.bsky.graph.getFollows` API |
| X | `following.js` from the archive | Shown honestly as account numbers: the archive has no handles, so these can't be followed from the file. Paste profile links instead |
| Any reader | an OPML file | Feedly, Inoreader, NetNewsWire and the like |

You can also paste profile links or handles, one per line (`https://www.youtube.com/@name`,
`https://www.instagram.com/name`, `name@mastodon.social`, `r/subreddit`, a feed URL).

A followers list (people who follow *you*) is recognised and refused with a pointer to the
following list.

## How it works

1. **Pick.** Files are read in your browser. A ZIP is opened in place: only the central directory
   and the files named like following lists are read, so a multi-gigabyte Takeout archive is fine
   and nothing else in it (watch history, messages, photos) is touched. Only the extracted
   accounts are sent to the Aurora server on this computer.
2. **Review.** Accounts are grouped by platform with avatars where the export has them. Search,
   select all or none per platform, and pick which profile each platform's accounts go to.
   Accounts you already follow are marked and left unselected. Each group says plainly what will
   happen:
   - **Instant**: Bluesky, Mastodon, subreddits, Substack, OPML feeds and YouTube channel feeds
     are open, so they're added straight away at no cost.
   - **Connector ready**: the platform already has a working AI-built connector, so each account
     becomes a new source on that same connector with the account as its input. No AI call.
   - **One AI build**: no connector yet. The AI builds one for the first account, written to take
     the account as input, and every other account then reuses it. The estimate comes from the
     cost of past builds on this computer (or the first-24-builds range, $0.09 to $0.74, until
     there are three).
3. **Progress.** Nothing starts until you press "Follow N accounts". Then each account shows its
   status: queued, adding, added (with how many posts arrived), already followed, waiting for a
   connector, failed with the reason, or stopped. You can close the sheet; the import keeps going
   in the background and resumes after a restart. "Stop" stops after the current account.

## Limits that keep it polite

- One AI build per platform, never one per account. 300 YouTube subscriptions don't start 300
  builds; the AI's own limit of three jobs at a time still applies.
- Within one platform, accounts are added one at a time with a gap (4 seconds for Reddit, which
  rate-limits feeds; about a second elsewhere). Platforms run side by side.
- Imports of more than 40 accounts for a connector platform check every 3 hours instead of every
  hour.
- If a connector fails for the first three accounts, the rest of that platform is paused with a
  note to check it in the Workshop, instead of hammering a broken connector.
- YouTube channels use their public feed first. If YouTube refuses a channel feed, that channel
  falls back to the connector lane.
- Up to 5,000 accounts per import, 150 MB per file inside an export, 3,000 Bluesky follows.

## What it never does

- It never follows, unfollows, likes or posts anything on any platform. "Following" here means
  reading public posts into this computer.
- It never asks for a password and never logs in to a platform. Bluesky is read through the
  public read-only API; everything else comes from files you chose.
- It never reads anything from disk on its own: only files you pick or drop.
- Export contents are untrusted data. Every value is length-capped and checked against tight
  patterns, links must be http(s), nothing is rendered as HTML, and bad rows are skipped with a
  reason instead of failing the file. The server re-checks every account it receives.

## Known gaps

- The X archive lists account ids, not handles, and Aurora doesn't look them up.
- Export formats change. The Instagram and TikTok parsers accept the shapes seen so far (the
  `relationships_following` object and the plain array for Instagram; the `Following` list in
  any nesting, plus the text export, for TikTok). If a newer export isn't recognised, the pick
  step says so and paste-links still works.
- Substack's own export format isn't pinned down; any file listing `*.substack.com` links works.
