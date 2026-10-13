# Routines

Routines are jobs the AI does for you on a schedule, described in one sentence:

- "Every weekday at 7:30, make a Work brief from my Work profile"
- "Sunday night, list the long reads I saved this week and queue the best three in Read later"
- "Every 2 hours, if anyone in my Family profile posted photos, put them on a Family page"
- "After each sync, save any post that mentions my name"

Open **Routines** from the rail (the circular arrows), the command palette, or ask the agent ("every morning, …"), which makes one with `create_routine`.

## How a routine gets turned on

1. You describe the job. Aurora reads the schedule out of the sentence and shows it back ("Weekdays at 07:30") before you save.
2. The routine is saved **off**. Nothing runs yet.
3. Press **Preview the first run**. A cheap model (your classify model, or Haiku on Claude) writes a short plan of what the first run will do, using only the tools a routine may use. This is a dry run: no tools are called and nothing in your library changes.
4. Read the plan and press **Turn on**. Only a person can do this, from the sheet. The agent can make, edit and turn off routines, but it cannot turn one on, and a routine run cannot make or change routines.

Changing a routine's task or profile turns it off again until you preview the new plan.

## Schedules

Times are in this computer's local timezone.

| You say | Runs |
| --- | --- |
| "every day at 7", "daily at 7pm", "every morning" | Every day at that time (morning 07:00, afternoon 15:00, evening 18:00, night 20:00, noon 12:00) |
| "weekdays at 7:30", "weekends at 9" | Mon to Fri, or Sat and Sun |
| "Sunday night", "Mon, Wed and Fri at 8:15am" | Those days |
| "every 2 hours", "hourly" | Every N hours (1 to 24) from when it was turned on |
| "after each sync" | Shortly after new posts arrive, at most once every 30 minutes |

If the computer was asleep through a timed slot by more than six hours, that slot is skipped instead of running late. Interval routines run as soon as they are due.

## What a run can do

Each run is an agent thread (kind `task`, origin `routine`) that you can open from the agent's history. It runs unattended, so it never asks you questions, and it never moves your screen: pages and views it saves appear in the sidebar without being opened.

A run can only use these tools: `library_overview`, `search_posts`, `related_posts`, `get_post`, `read_article`, `search_highlights`, `save_page`, `save_view`, `save_topic`, `set_posts_state` (saved, hidden, Read later and other collections). That is a subset of what chat can use. It has no source tools at all, so a routine cannot add or remove sources, sign in, sync a platform, or post, like, follow or bookmark anywhere. Because no source tools are reachable, nothing touches Meta or X sessions, including on SR_CLOUD.

Post text reaches the model wrapped as untrusted data, as in chat. A post that says "ignore your instructions" is just a post.

When a routine works in a profile, the server switches to that profile for the length of the run and switches back afterwards.

The result is a short summary (with links to the posts it cites) on the routine's card, and usually a page named after the routine that each run updates in place.

## Spending

- Routines are their own AI task, **Routines**, in AI settings > Spend, with the usual monthly cap for automatic work. When that cap is reached, scheduled runs stop and the "AI paused" banner shows. "Run now" still works.
- Each run stops at its own limit (default $0.50). With Claude this is enforced by the Agent SDK's budget; other providers are held to 24 turns and 10 minutes.
- Each routine has a monthly limit (default $5). When a scheduled run would go past it, the routine pauses and the banner shows. Raise the limit under Edit to resume.
- Previews use the cheap model and are recorded against the Routines task.

## Run history

The last 200 runs across all routines are kept in settings (`routines.runs`), with status (ok, error, skipped), duration, cost, summary, steps and the agent thread. The sheet shows the latest run on each card and earlier runs under "Earlier runs".

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/routines` | Routines with next run, last run, month spend, AI readiness |
| POST | `/api/routines` | `{ text }` or `{ prompt, schedule, name?, profile?, runCapUsd?, monthCapUsd? }`; always created off |
| PATCH | `/api/routines/:id` | Any of the above plus `enabled` |
| DELETE | `/api/routines/:id` | |
| POST | `/api/routines/:id/plan` | Makes the dry-run plan (cheap model) |
| POST | `/api/routines/:id/run` | Runs now |

Routines are stored in the `routines` setting, so the agent's changes can be undone like other settings.
