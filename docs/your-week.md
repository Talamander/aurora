# Your week

Your week is a short, full-screen story about the last seven days of reading in Aurora. It is
meant to feel like a small reward at the end of the week, not a report. Everything in it is worked
out on your own computer from data Aurora already has. Nothing is sent anywhere unless you choose
to send it to a friend.

## Opening it

- **Sunday evening.** From 18:00 on Sunday, Aurora freezes the week's numbers for each profile.
  When the AI is set up, it also writes the paragraph. A "Your week is ready" card appears in the
  side pane on Sunday evening and on Monday, until you open it. You can change the hour with the
  `ui.week` setting (`{ "enabled": true, "hour": 18 }`).
- **Command palette.** Press Ctrl/Cmd K and choose "Your week".
- **Ask the agent.** "How was my week?" calls the `open_your_week` tool, which opens the story.
  On Monday morning it opens the week that just ended.
- **Phone (web).** In the Views sheet, tap "Your week".
- **Phone app.** On the feed, tap the sparkle button. The app shows a read-only, scrolling
  version. It can browse past weeks, but it cannot write the paragraph or share.

Past weeks stay available from the menu at the top of the story.

## Moving through it

- Tap the right two thirds of the screen, or press → or Space, to go forward.
- Tap the left third, or press ←, to go back.
- On a phone, swipe sideways.
- Press P to pause and Esc to close.

Cards move on by themselves, like a story. They stop moving while you hold the pointer down,
while the tab is hidden, and on the last card. If your system asks for reduced motion, cards never
move on by themselves and all animation is turned off.

## The cards

1. **Intro.** The dates and the week's title.
2. **The week in numbers.** Posts read, a small chart of each day, minutes in articles, saved
   posts and highlights, and your busiest reading day.
3. **Quietly handled.** How many posts were set aside: noise the app recognised, and posts your
   plain-English AI rules hid. Also an estimate of the scrolling time this saved.
4. **Who you spent it with.** The five people you read most, and your main sources.
5. **On the rise.** The topic that grew most compared with the week before.
6. **The best thing you read.** It is chosen from saved posts, highlights, how far you read and
   the length of the piece. It includes your highlight, if you made one.
7. **In your words.** A short paragraph written by your AI in the first person. It cites the
   posts it mentions, and each numbered marker opens that post.
8. **That was your week.** A poster you can save as a PNG, copy, or send to a friend.

Each profile has its own week. The "All" view covers everything.

## How the numbers are worked out

The code is in `core/week.ts` and is pure, so the unit tests in `tests/week.test.ts` cover it.

- **Weeks.** ISO weeks, Monday to Sunday in local time. Week ids look like `2026-W41`.
- **Posts read** and **saved** use the time you marked each post read or saved.
- **Minutes in articles** come from reading positions updated that week. Each one counts the
  article's word count at 230 words a minute, times how far you got. An article counts as
  finished at 85% or more.
- **Set aside** runs the normal noise and AI rule filters over the posts that arrived that week.
  A post hidden by an AI rule counts under rules; anything else counts as noise.
- **Time saved** is an estimate of 5 seconds for each post set aside.
- **People and sources** come from what you read and saved. In a week with fewer than three of
  those, they come from what arrived. Posts that friends shared with you are left out of
  "people". The same display name on two platforms counts as one person.
- **Topic growth** compares how many posts matched each of your topics this week and last week.
- **Demo posts** count only when the whole library is the demo library.

## The paragraph and the AI

The paragraph is written with the AI you set up in Aurora. The prompt contains the week's
numbers and a short list of notable posts. The posts are wrapped and labelled as untrusted data,
so their text is never treated as instructions. Citations are checked against the posts that
were sent, and any others are removed. "Write it again" asks for a new paragraph.

Writing is refused for a quiet week and when no AI is set up. Phones that are paired with the
computer can read the story, but they cannot ask for a new paragraph.

## Saving and sharing

- **Save picture** draws a 1080 by 1350 PNG on your computer and downloads it. **Copy** puts the
  same picture on the clipboard. The picture contains only text and shapes, with no images from
  other sites.
- **Send to a friend** uses the existing Friends system. It never happens automatically. You pick
  friends and can edit the note. The panel shows exactly what they will get: your note and the
  best post, sent through the end-to-end encrypted relay like any other share. The picture
  itself is not sent. You cannot share a post that a friend shared with you.

## Where it is stored

Frozen weeks are kept in the settings table under `week.<profile>.<week id>`, with a list of week
ids under `week.index.<profile>`. Until a week is frozen, its numbers are worked out live each time
you open it.

## Limits

- Minutes in articles use the last reading position only, so rereading an article does not add
  time.
- Archiving has no timestamp, so archived posts are not counted as a weekly activity.
- The time saved is a rough estimate.
