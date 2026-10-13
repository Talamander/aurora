# Time well spent

Time well spent is a calm, local view of where your reading time goes. It shows how long you actively read in each profile today and over the last week, and it lets you give a profile a gentle daily limit. It never blocks anything. No AI is involved, and nothing leaves Aurora's own server.

## Where to find it

- **Today ring** in the rail, next to the profile switcher: a small ring in the profile's colour with today's minutes ("7m"). Click it to open the sheet.
- **Command palette** (`Ctrl K`): run "Time well spent".
- **What's new**: the "See my time" button under "Also new".
- **Profile sheet** (edit a profile): the daily limit and a seven-day bar strip for that profile.
- **Your week**: a "Time well spent" line with the week's time by profile.
- **Phone app**: the profile sheet ("Read as") shows today's minutes next to each profile.

On phone-width web layouts the profile switcher is compact and has no ring; use the palette.

## What counts as reading time

Aurora counts time only while both of these are true:

- the Aurora window or tab is visible (not minimised, not a background tab), and
- you touched it in the last 60 seconds: a key, a click or tap, a scroll, a wheel turn or a mouse movement.

So leaving Aurora open on a second monitor while you do something else stops counting after a minute. The browser samples every five seconds and sends the totals to the server every 30 seconds, when the tab is hidden, and when the page closes. Time goes to the profile you were in when you read it: switching profile first books the time so far to the old profile.

The ring measures today's minutes against the profile's limit when it has one, or against an hour when it does not. The ring is a picture of the day, not a target.

## What is stored

Only daily totals: for each local calendar day, the number of seconds per profile ("all" for no profile). Nothing records which posts you read, when in the day, or for how long each one. The totals live in the library database as the setting `time.spent` and keep 35 days; older days are dropped as new time arrives.

The server caps each report at two minutes and each profile at 24 hours a day, ignores reports for days outside the window, and refuses unknown profiles, so a bad client cannot fill the setting.

## Daily limits

In a profile's settings, turn on **A gentle daily limit** and choose the minutes a day (5 to 720; it starts at 30). The limit is stored on the profile as `dailyMinutes` (null means no limit).

When today's time in that profile reaches the limit, the feed stops loading more posts and ends with a card: "That's your 30 minutes of Gaming for today." It offers:

- **Switch profile**: All plus up to three other profiles.
- **Five more minutes**: the card steps aside and comes back once, five minutes later, saying "That was five more minutes of Gaming." It is offered only once a day.
- **Keep going**: the card goes away for the rest of the day in that profile.

The card never covers the feed, never interrupts a post you are reading, and never asks twice in a day beyond the five minutes you asked for. It does not appear in Columns, in "See why", or on a feed that is already empty. Its state (snoozed or dismissed today) is kept per browser in `localStorage` and resets at midnight.

## The sheet

The Time well spent sheet lists today's minutes for each profile with time this week (and the profile's limit, if any), a bar of each profile's last seven days, and the current profile's seven-day strip with a dashed line at its limit. A button opens the profile's settings to set or change the limit.

## API

Both routes are behind the owner lock, and both are allowed for a paired phone.

- `GET /api/time` returns `{ log }`, where `log` maps `YYYY-MM-DD` to `{ profileId: seconds }`.
- `POST /api/time/tick` with `{ day, profile, seconds }` adds time. `day` must be `YYYY-MM-DD`, `profile` must be `all` or an existing profile id, and `seconds` must be a finite number of at least zero.

The pure logic (day keys, adding with caps, idle cut-off, limits, totals and formatting) is in `core/timeSpent.ts`, with tests in `tests/time-spent.test.ts`.

## Known limits

- Two visible Aurora windows that you move the mouse over can both count the same minute.
- The phone app shows the computer's totals but does not count its own reading time yet.
- Your week records made before this feature have no time line.
