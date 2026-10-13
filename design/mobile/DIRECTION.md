# Aurora for phones: design direction

## Brief (self-authored)

Tal delegated the phone app: "make it FAST, SECURE and SEXY", Android first, iOS on the roadmap.
Aurora is a private, agentic social reader. It runs on your own computer (or your own server),
pulls your feeds through connectors you approved, filters them with rules and an AI you control,
and never writes back to the platforms. The phone app is a remote for that server: it pairs once
with a QR code shown on the desktop, then reads the same library over the same JSON API and SSE.

- **Who:** Tal, and anyone running their own Aurora. One reader, many sources.
- **Core action, first ten seconds:** open the app and see what is worth reading since last time,
  lit by its pictures, with the number that says how much there is.
- **Platforms:** Expo (React Native, TypeScript). Android ships first, iOS from the same code
  (needs a Mac or EAS to build, see docs/mobile.md).
- **Feel:** lit, quiet, quick. References from outside apps: a city at night seen from a plane,
  a cinema foyer, a lightbox of slides.
- **Money:** none. Self-hosted.
- **Scope:** the core screens below, done at the critic's bar on the feed only (Tal asked to keep
  it brief and skip ceremony).

## Direction

The desktop direction (design/DIRECTION.md, Revision 4: Aurora) carries over unchanged. A phone is
where a feed lit by its own pictures is most at home: the screen is small, dark and held close,
so the aura behind each card is the light in the room.

What changes on the phone:

- **The hero line** sits at the top of the feed, 40px, the count in the lit gradient, and
  collapses into the top app bar on scroll.
- **Lenses become chips.** The desktop lens dock is a horizontal chip row under the hero, each chip
  with its live count. The active chip is lit with the soft gradient.
- **Navigation** is the platform's own: a Material 3 navigation bar on Android, a floating tab bar
  on iOS. Five destinations: Feed, Today (morning edition and pages), Agent, Sources, Settings.
  The person screen and the reader open from a post.
- **The agent composer** floats above the navigation bar on the feed: one line, "Ask about your
  feed", the only primary action on the screen.
- **Set aside** (the signature) works the same: hiding a post folds it away and a receipt
  ("7 set aside by “giveaway” · Undo") holds at the foot of the feed. Android uses
  `performAndroidHapticsAsync(Confirm)` on save and hide, iOS `impactAsync(Light)`; undo is a
  `selectionAsync` tick. Reduced motion: no fold, receipt still shown.

What stays the same: tokens, Geist and Geist Mono on both platforms (bundled), radius 26 cards,
platform hues as small owned marks, the voice rules.

## Tokens (phone)

Exactly the desktop table (design/DIRECTION.md, Revision 4), plus:

| Role | Value |
|---|---|
| Side margin | 16 |
| Card radius / chip radius / sheet radius | 26 / 999 / 28 |
| Hero | Geist 40, weight 680, tracking -0.055em |
| Title | Geist 22, weight 640, tracking -0.03em |
| Body | Geist 16 / 24 (reader 18 / 29) |
| Meta | Geist Mono 12, tracking .02em, ink-3 |
| Spacing | 4, 8, 12, 16, 24, 32, 48 |
| Targets | 48dp Android, 44pt iOS |

The pictures in the mockup are drawn stand-ins (CSS gradients), because the real images come from
the user's own feeds at runtime.

## Content

- **Feed:** kicker "Tue 07:42 · 6 sources · synced 4 min ago"; hero "38 worth reading"; chips
  Worth reading 38, Everything 135, Saved 12, Videos 9, Longform 6. Posts: Simon Willison on the
  new sampling profiler (RSS, picture), Low Tide Films kayaking the Apostle Islands sea caves
  (YouTube, 18:04), @mira.bsky.social on the lakefront at 6am (Bluesky, picture), r/homelab
  three-node cluster in a shoebox (Reddit), "SQLite ships a native vector index" (Hacker News,
  412 points). Receipt: "7 set aside by “giveaway” · Undo".
- **Reader:** the Simon Willison post as longform, 9 min read, with "Listen" and "Ask about this".
- **Agent:** a thread asking what changed in local-first sync this week, with cited posts.
- **Today:** the morning edition "Quiet week for launches, loud week for sync", three sections,
  Listen.
- **Person:** Mira Okafor, @mira.bsky.social, 14 posts this month, 3 saved, notes.
- **Sources:** six connectors with counts and last sync, one needing sign-in.
- **Pair:** the QR camera frame, the server name, the approval step.
- **Settings:** server, this device, theme, haptics, reduce motion, sign out of this server.

## Voice

The desktop rules: the number and the reason, never an adjective; no exclamation marks; name the
platform and the action exactly ("Approve this phone on your computer: Settings, AI, Phones").

## Critique, round 4 (core screen only, self-scored)

Shots: `shots/r4/` (sheet, review, pairs/core.png). Scan: 9 FAILs, all answered below.

| Line | Score | Note |
|---|---|---|
| Hero and hierarchy | 4 | "38 worth reading" owns the screen; the count is the only lit gradient. |
| Richness on the core screen | 5 | Every card carries its own picture and its aura; the chrome stays neutral. |
| Platform fit | 4 | Material navigation bar, tonal composer and 48dp targets on Android; floating glass tab bar on iOS. Cards stay glass on Android because the aura is the direction. |
| Words | 4 | Kicker, count and "lit by" reasons say the number and the reason. No adjectives. |
| Finish | 4 | Three depths: ground, glass card, floating composer. Shadows could be unified to two styles. |

Deliberate FAILs:

- "Large blurred blob": these are the post auras, a blurred copy of each post's own picture, the
  Revision 4 concept Tal picked. They are content-derived, not ambient orbs.
- "2 warm-to-violet gradients": the hero count and the app mark. Both are the identity; chips,
  buttons and the navigation pill were moved to the solid lamp colour.
- "Listen · 6 min" contrast: dark ink on a white pill; the scan reads the photo behind the pill.
- `SFNS.ttf` page error: no macOS fonts on this Linux machine; the iOS frame falls back to the
  system face, which only affects the iOS tab labels.
