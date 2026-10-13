# Alerts

An alert is a watch written in plain English: "tell me when MKBHD posts a phone review", "ping me
if anyone in Family posts photos", "alert me about Rust 2.0 news". When a new post matches, Aurora
tells you on this computer and keeps the post in the Alerts list.

## Making one

- Ask the AI anywhere ("tell me when…"). It turns the sentence into an alert with the
  `manage_alert` tool, and Undo removes it again.
- Or open **Alerts** (the bell in the rail, or Views → Alerts on a phone-sized window) and type
  in the "Tell me when" box. Without an AI set up, the box makes a keyword alert from
  comma-separated words.
- **What would it catch?** on any alert runs it over the last week of posts and shows what it
  would have caught. It records nothing.

Alerts can be paused or deleted from the same sheet. Each one lists what it caught, with a
one-line reason ("by Priya Raman, mentions “SQLite”").

## How matching works

Every alert has some of: people, sources, words, a kind of media (photos or videos), a profile,
and a free-form description.

1. **Cheap checks first.** People match by handle or name, sources by id, words as whole words
   ("rust" does not match "trust"), media by attachment type, and a profile by the same routing
   the feed uses. All the cheap conditions on an alert must hold.
2. **The AI only for what is left.** If the alert also has a description, only posts that passed
   the cheap checks go to the AI, in batches of 25, using your classify model (or Claude Haiku).
   Post text is wrapped in `<untrusted>` and the AI is told to treat it as data.

Cost limits: only posts that arrived since the last pass and were published in the last 72 hours
are looked at, demo posts never fire, and at most 150 posts an hour go to the AI. Posts over that
cap are skipped, not queued. A single pass announces at most five posts per alert.

A pass runs a few seconds after each sync, after an import that added posts, and once at startup.
The first pass after you upgrade only records a starting point, so old posts do not flood you.

## Where you hear about it

- **Web:** a toast with Open (one post) or See all, and a browser notification when the tab is
  in the background. Aurora asks for notification permission only when you click Turn on.
- **Desktop app:** a native notification when the window is not focused. Clicking it opens the
  post.
- **Waybar:** `aurora status --waybar` shows `◆ 11 ⚑ 2` with the class `alert` and lists the
  caught posts first in the tooltip. See [omarchy.md](omarchy.md).
- **Phone:** a dot on the bell in the header and a read-only Alerts screen. Paired phones can
  only read hits and mark them seen; they cannot create, change or delete alerts.

**Quiet hours** (off by default; 22:00 to 07:00 when turned on) keep collecting hits without a pop-up:
no browser or desktop notification. The small in-app toast still shows if Aurora is open.

## Privacy

Nothing leaves your machine. There is no push service, email or webhook: every notification is
shown by Aurora itself, the browser, or your desktop. The AI step uses the same provider you set
up for everything else. Alerts never touch your accounts on any platform.

Alerts and their hits are stored in the local database as settings (`alerts`, `alerts.hits`,
`alerts.watermark`, `alerts.quiet`). The last 300 hits are kept.
