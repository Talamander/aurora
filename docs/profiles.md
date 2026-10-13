# Profiles: hours and On this day

A profile is a separate Aurora for one part of your life, such as Work, Gaming or Family. Each one
has its own sources, views, rules and look. This page covers two small things built on top of
profiles: profile hours, which switch profiles by themselves at set times, and On this day, which
brings back posts you saved or highlighted on this date in the past.

## Profile hours

Open a profile from the profile switcher in the sidebar (edit the current profile, or New profile) and turn on **Use it at set times**.
Pick the days, the from and to times, and one of:

- **Switch by itself.** When the time comes, Aurora switches to the profile and shows a short note,
  for example "Work hours: switched to Work. Undo". When the hours end, it switches back to the
  profile you were on before, with "Work hours are over: back to All. Undo".
- **Only suggest.** Aurora shows a small "09:00–17:00 is usually Work time" hint with a Switch button in the feed and never switches by
  itself. Profiles made before profile hours existed, and the built-in templates, start here.

Below the times, the sheet reads the schedule back in plain English, such as "Weekdays, 09:00 to
17:00. Aurora switches to Work then, and back afterwards."

You can also ask the agent: "switch me to Work on weekdays 9 to 5" sets the hours on the Work
profile, with switching by itself turned on.

### The rules

- **A switch you make yourself always wins.** Aurora only acts at the moment hours start or end. If
  you switch away from Work at 10:00, Aurora leaves you there until the next start or end of some
  profile's hours. Undo on the note counts as such a switch.
- **Back to where you were.** At the end of the hours, Aurora only switches back if you are still on
  the profile it switched you to. If you moved somewhere else in the meantime, it stays put.
- **Opening Aurora during the hours.** If you open Aurora at 11:00 on a weekday and Work's hours are
  on, Aurora switches to Work once, as if the hours had just started. If you then switch away, it
  does not switch again until the next boundary. Several open tabs share this state, so only one
  of them acts.
- **Overlapping hours.** When the hours of two profiles overlap, the shorter window wins. A Lunch
  profile from 12:00 to 13:00 beats a Work profile from 09:00 to 17:00. When two windows are the
  same length, the profile listed first wins. When Lunch ends at 13:00, Aurora is back inside
  Work's hours, so it switches to Work.
- **Overnight hours.** A window whose end time is earlier than its start time runs past midnight,
  and belongs to the day it starts on. Friday 22:00 to 02:00 runs from Friday night into Saturday
  morning. It does not start again on Saturday night unless Saturday is ticked too. A window whose
  start and end times are the same covers the whole day.
- **Local time.** Hours follow your computer's clock and time zone, including daylight saving
  changes. A 09:00 to 17:00 window is 09:00 to 17:00 on the clock, even on the day the clocks
  change.

### Where it works

Profile hours run in the web app and in the desktop app, while Aurora is open. Nothing runs in the
background when Aurora is closed. The phone app ignores profile hours for now.

Waybar and `aurora status` keep working as before: they show whichever profile is active, so
during Work's hours they show Work. Profile hours do not change which profile the terminal tools
use by default.

## On this day

When you saved or highlighted posts on today's date in an earlier month or year, a small card at the
top of the feed shows up to three of them: "A year ago you saved…", "3 months ago you
highlighted…". Select one to open the post. When there are more, "All 5 from this day" opens the
full list. You can also open it from the command palette (Ctrl K), "On this day", on any day.

- The card only appears on days that have something, and only in the normal feed (not while
  searching or showing hidden posts).
- It follows the current profile: in Work you only see posts from Work's sources.
- Posts in the archive are left out. When a post was both saved and highlighted, the highlight is
  shown, with its quote.
- The card's menu (the three dots) has **Hide for today**, which hides it until tomorrow, and
  **Turn off On this day**, which hides it for good. Turn it back on from the palette sheet with
  **Show on the feed**.

On this day is worked out on your computer from dates Aurora already has. It does not use the AI
and does not send anything anywhere.
