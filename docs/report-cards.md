# Source report cards

Report cards answer one question: which sources earn their place? They show what you actually did with each source over the last 30 days. Everything is worked out on this computer from your reading state. No AI is involved, and nothing is sent anywhere.

## Where to find them

- **Sources sheet** (press `g`): pick the **Report card** tab at the top.
- **Command palette** (`Ctrl K`): run "Source report cards".
- **What's new**: the "See report cards" button.

The cards follow the profile you are in. In a profile you see that profile's sources. In All you see every source.

## What each card shows

For each source, over the last 30 days (local calendar days, today included):

| Number | Meaning |
| --- | --- |
| a day | Posts per day. A source added less than 30 days ago is divided by its age, not by 30. |
| read | Posts you opened or marked read. |
| saved | Posts you saved. |
| highlighted | Posts with at least one highlight in the reader (shown when above zero). |
| read later | Read later posts finished / added (shown when above zero). |
| alerts | Posts that triggered one of your alerts (shown when above zero). |
| you hid | Posts you hid (archived) yourself. |
| rules hid | Share of posts your rules keep out of the feed: noise, muted words and plain-English AI rules. It is the rules alone, whatever you read or hid. |

A small sparkline shows daily volume as a grey area, with what you read as a line over it.

"Kept" means you did something lasting with a post: you saved it, highlighted it, finished it in Read later, or an alert fired on it.

## The verdict

Each source gets one of four verdicts. Each comes with a plain sentence and the numbers behind it, for example "You kept 2 of 412 posts in 30 days (14 a day for so little); your rules hid 61%."

- **New**: added less than 7 days ago, so too new to judge.
- **Keep**: you keep a fair share of what it posts (at least 2%, or anything at all from a small source). A quiet source, with nothing or fewer than 10 posts in the window, is also kept: it costs you nothing.
- **Quieter**: busy but rarely kept (60 or more posts, under 1% kept), or your rules already hide half of it. A topic, a mute or a move to another profile may help.
- **Let go**: 30 or more posts, none kept, and either you read under 10% or your rules hide 70% or more.

The verdict is a nudge, never an automatic action. Cards sort with "let go" first, then "quieter", then "keep" and "new", busiest first inside each group. **Worth a look** narrows the list to "let go" and "quieter".

## Actions

Every action is local. Aurora never unfollows, mutes or changes anything on the source platform.

- **Pause syncing / Resume syncing**: stops or restarts fetching new posts. Imports and the demo library have no sync, so they have no pause button.
- **Mute in this feed** (in All): adds the source to the current filter's excluded sources. Undo it with the usual undo.
- **Remove from &lt;profile&gt;** (in a profile): takes the source out of that profile. The toast offers Undo.
- **Move to a profile / Add to a profile**: in a profile, moves the source to another profile. In All, adds it to a profile.
- **Open in Columns** (desktop widths): adds a column for that source and shows Columns.

## Asking the assistant

The in-app assistant has a read-only `source_report` tool with the same numbers and verdicts for the active profile. Ask "which sources should I drop?" and it answers with the numbers. It suggests pausing, muting or moving a source but does not do it unless you ask.

## Performance

The stats are one pass over the posts in the 30-day window (`core/sourceReport.ts`). They are computed only when the Report card tab opens, a moment after the sheet appears, and again only when the library changes. On a synthetic library of 100,000 posts across 60 sources, a warm run takes about 25 ms. The first run, before the filter cache is warm, takes about 190 ms. In the app the feed has normally warmed the cache already. See [performance.md](performance.md) for the wider budget.
