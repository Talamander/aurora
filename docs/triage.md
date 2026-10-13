# Triage

Triage clears new posts one at a time. It takes the feed you are looking at, in the active
profile, and shows each unread post as one big card over a glow taken from its own picture. You
make one choice per card and the next one slides up. When the deck is empty you get a short tally,
for example "Cleared 42 · kept 5 · later 3", and a way back to the feed.

Every choice is a local state change on this computer, made through the same undoable path as the
feed. Nothing is liked, saved, hidden or marked on the source site.

## Opening it

- Press `t` in the feed.
- Command palette (`Ctrl K`): "Triage new posts".
- The "Since you were away" card has a Triage button.
- What's new: "Clear the deck".
- Phone app: the "Triage N new" button under the feed's headline.

## The choices

| Choice | Keys | Swipe | What it does |
| --- | --- | --- | --- |
| Keep | `→` or `l` | right | Saves the post and marks it seen |
| Later | `↑` or `r` | up | Adds it to Read later and leaves it unread there |
| Hide | `←` or `h` | left | Archives it (hides it from the feed) and marks it seen |
| Skip | `↓`, `j` or Space | down | Marks it seen |

`z` takes the last choice back and brings the card back to the top, as many times as you like. `o`
opens the original post in a new tab without deciding anything. `Esc` leaves Triage; whatever you
did not reach stays as it was.

On a phone, swipe the card or tap one of the four buttons under it. Swipes are never the only way
to do something. While you drag, the card tilts and the edge it is heading for lights up in that
choice's colour: teal for Keep, amber for Later, rose for Hide, grey for Skip. A short drag or a
diagonal one springs back without deciding.

## What is in the deck

The deck is the current feed, in the order it shows, with the view, search and filters you have
on. It leaves out posts you have already read, posts that are archived and posts already in Read
later. The deck is fixed when Triage opens, so choices never reshuffle what is coming. It holds at
most 200 posts at a time.

## Motion and accessibility

Each card leaves in under 200 ms in the direction of its choice. With reduced motion turned on
(in the system or, on the phone, in Aurora's settings) cards crossfade instead and the end screen
does not breathe. The buttons carry their keyboard shortcuts, a live region announces each choice
and how many are left, and focus returns to where it was when Triage closes. Post text is shown as
plain text, never as HTML.

## Where it lives

- `core/triage.ts`: the deck, what each choice writes, the swipe thresholds and the tally. Tested
  in `tests/triage.test.ts`.
- `web/src/Triage.tsx` and `web/src/triage.css`: the web and desktop view.
- `mobile/app/triage.tsx`: the phone screen, using the same core logic.
