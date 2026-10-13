# Social Reader: design direction

## Revision 4, 2026-10-12 22:06 CDT: Aurora

Tal said the timeline skeleton was right but it did not feel like "the future". Three directions
were explored on the same timeline with real posts (`design/explore-r7/index.html`: Aurora,
Forecast, Deck). Tal picked Aurora and asked for it in both dark and light. The Revision 3 layout
stays; this revision replaces the look.

**Concept.** A feed lit by its own pictures. Each post glows with a blurred, saturated copy of its
first image (or video thumbnail, link image, or the author's avatar), so the timeline takes its
colour from what people posted rather than from the chrome.

- **Glass cards.** Posts are rounded glass cards (radius 26) floating over the dark ground, each
  with its aura behind it (`.post-aura`: the image blurred 60px and saturated). The selected post
  glows brighter, seen posts dimmer. Posts with no image use a soft glow in the platform's hue.
  `prefers-reduced-transparency` removes the aura.
- **Hero line.** Above the feed: a mono kicker ("Monday night · 5 sources · synced 1h ago") and a
  52px headline with the count in the warm gradient ("135 in everything", "85 worth reading").
- **Lens dock.** A floating glass dock at the bottom of the feed holds the views as lenses, each
  with its live count; the active lens is lit with the soft gradient. "+" saves the current
  filters as a new view. Phones keep the tab bar instead.
- **"Lit by" line.** The Why button became a pill at the end of each post's actions that says why
  the post is there: "lit by #aiandmodels", "lit by Keyword …", "from Bluesky (@bsky.app)", with
  "no noise" or "your call" appended when the noise rule applies. Clicking it (or `w`) opens the
  full explanation as before. Action buttons are icon-only with accessible labels.
- **Rules pane.** Glass cards; switches glow teal when on; a new "New in this feed from" card shows
  the avatars of authors with unseen posts, and clicking one filters to that person.

**Tokens.**

| Role | Dark | Light |
|---|---|---|
| Ground | `#05060a` | `#f3f4f7` |
| Surface / raised | `#0e1016` / `#171a22` | `#ffffff` / `#eceef3` |
| Line | `#1e2129` | `#e1e4ea` |
| Ink | `#eef0f6` | `#0b0d12` |
| Card glass | `rgba(13,15,21,.6)` | `rgba(255,255,255,.82)` |
| Lamp (accent: links, new dot, avatar rings) | `#ffad7a` | `#d4461a` (text `#b53a12`) |
| Lit gradient (hero number, active lens, end mark) | `#ffc56b`, `#ff7a9c`, `#a69bff` | `#f08a24`, `#e8467c`, `#6d5cf0` |
| Glow-on (switches, "lit by" reason) | `#4fe0c6` | `#0fa88c` |
| Aura opacity / saturation | .62 / 1.9 | .34 / 1.5 |

Type stays Geist and Geist Mono. Hero 52px weight 680, tracking -0.055em (40px on phones).

## Revision 3, 2026-10-12 21:20 CDT: a timeline, not an inbox

Tal clarified that the problem was the reader layout, not only the colours: "i dont want to feel
like i am reading emial. i want to feel like i am experiencing a new form of social media, just
for me." They chose a timeline and asked to keep the Revision 2 look. This revision replaces the
list-plus-reader-pane layout; colour and type tokens from Revision 2 stay.

- **One column of whole posts** (max 680px), like Bluesky or Threads. Each post is a card with the
  author's avatar (their photo when the source gives one, otherwise initials tinted by platform),
  name, handle, time, a blue dot when new and the source on the right.
- **Everything inline.** Full post text, image grids, quote cards, video cards and a link card
  for the first link. Long posts clamp with "Show more". Articles show a hero image (capped at
  280px tall), title and excerpt, and "Read here · N min" expands the whole article in place,
  code blocks included.
- **Actions under each post:** Save, Collect, Why, Hide, Open on the source. "Why" opens the
  explanation and the per-post controls (noise override, mute or only this author, seen or
  unseen, manage source) inside the card. All local.
- **Reading state follows the scroll.** Posts that scroll past the top are marked seen after a
  moment, but stay in the feed until the filters change, so nothing jumps.
- **Endless scroll** in pages of 30, ending in "You are caught up." with the set-aside count.
- **Rules pane on desktop** (from 1241px): "Your rules" with the three everyday toggles, All
  filters and Undo, then the sources you follow with their last sync. Mid-width hides it (rules
  stay in the filter sheet); phones get a Feed / Views / Rules / Sources tab bar.

## Revision 2, 2026-10-12 21:13 CDT: Tal's feedback

Tal did not love the first look: too dark and brown, the serif type felt off, and it felt generic.
They chose "crisp modern sans". This revision supersedes the colour and type tokens below; the
layout, states and behaviour are unchanged.

- **Ground.** Cool neutrals. Light: `#f6f7f9` ground, `#ffffff` surface, `#0d1117` ink. Dark:
  `#0b0c0f` ground, `#101216` surface, `#eceef2` ink. No warm tint and no lamp glow.
- **Accent.** One electric blue with the same single role as before ("on" filters, selection, focus,
  primary button): `#2f5bff` light, `#5b80ff` dark, white text on it.
- **Type.** Geist (variable) for everything, set tight: headings 600 to 680 weight with -3.5 to
  -4.5% tracking, reading column 17/1.7. Geist Mono carries the personality in metadata: counts,
  timestamps, tags, section labels and code. Both bundled via @fontsource.
- **Brand.** A small blue square before the name, repeated in the app icon.


## Brief (self-authored from BUILD_BRIEF.md)

- **What / who:** a personal reader for one person (Tal) that pulls the worthwhile posts out of their social accounts and feeds, without ads, ranking games or platform chrome.
- **Core action, first ten seconds:** open it, see a short, trustworthy list of things worth reading, read one comfortably, keep or dismiss it, and tighten the filter when something unwanted slips through.
- **Platforms:** desktop browser first (local web app / installable PWA), phone-sized browser immediately; native mobile later reusing `core/`.
- **Three words:** quiet, exact, yours.
- **Money:** none. No paywall, no onboarding carousel, no store assets.
- **Voice:** a well-read friend who keeps your clippings. Plain, specific, never chirpy.

## Exploration

Three core screens rendered at 1280x800 in `design/explore.html` (`design/explore.png`):

- **A. A reading room after hours** (place, dark, serif Newsreader, amber lamp, colour-material). **Won.** It is the only one where reading is the hero: a long serif column under a pool of lamp light, the list beside it, filters as quiet chips. It is most *this* app: the thing you open at night to read what you would have scrolled past.
- **B. A sorting table for the post** (object, light, expanded Bricolage, identity hue per source, shape). Lost as a whole: the two-column card grid reads as a dashboard and makes long text cramped. **Kept from it:** the big count as the headline ("38 worth reading") and the "Why these" explanation panel, plus a small owned hue per source.
- **C. A mixing desk** (object, cobalt colour field, mono + Fraunces, faders). Lost: the faders promise weighting we do not do, mono hurts long reading, and a saturated blue field is tiring for an evening reader.

## The category default we refuse

Social clients copy the platform: an infinite card timeline, engagement counts under every post, avatars as the main visual, a blue accent (Twitter, Bluesky, Tapbots) and a compose button. We refuse all of it. No compose, no like counts in the list, no infinite "for you". The list is short because the filter did its job, and the reader view is a page, not a card.

## Tokens

Dark ("after hours") is the default; light ("reading room by day") is a full theme, not an inversion.

| role | dark | light |
|---|---|---|
| ground | `#14120f` | `#ecebe6` |
| surface (list, rail) | `#181511` | `#f5f4f0` |
| raised (selected, chip) | `#241f18` | `#e3e0d7` |
| line | `#2c271f` | `#d6d2c7` |
| ink | `#ede5d7` | `#1c1915` |
| ink-2 (meta) | `#b4a78e` | `#544c40` |
| ink-3 (quiet) | `#8f8471` | `#6d6556` |
| lamp (accent fill, one role: "on" filters and the focus ring) | `#f3c76b` | `#f3c76b` |
| lamp-ink (accent as text) | `#f3c76b` | `#8a5a08` |
| warn | `#f08a6c` | `#a8321a` |

Source identity hues (owned, small marks only, never surfaces): X `#e9e3d6`/`#1c1915`, Bluesky `#6fa8ff`, Mastodon `#5fc7ad`, Reddit `#ff8a5c`, YouTube `#ff6b6b`, RSS `#e9a24a`, Import `#c9b88f`. Demo items carry a hatched mark and the word "Demo".

**Type.** Newsreader (variable, optical size) for headlines and the reading column: an editorial serif made for screens, with real optical sizes so 15px list text and 44px headlines both look right. Atkinson Hyperlegible Next for UI and metadata: designed for low-vision legibility, which matters in dense filter controls. Bundled locally via @fontsource (no network).

Steps: display 44/1.08 Newsreader 400 (-1.5%), title 30/1.15 Newsreader 400, reading 19/1.62 Newsreader 400, list 16/1.42 Newsreader 400, UI 14/1.4 Atkinson 400/600, meta 12.5/1.35 Atkinson 400, label 11.5 Atkinson 600 +4% caps (one per group at most).

**Space.** 4-based scale: 4, 8, 12, 16, 24, 32, 48, 72. Side margin 24 (desktop panes), 16 (phone). Radius family 8 (chips, rows), 14 (sheets, popovers), 999 (pills).

**Depth.** Ground (flat), panes (surface + hairline), floating (filter sheet, toasts, phone bottom bar: `0 18px 48px -18px rgba(0,0,0,.55)`).

## The richness source

Colour and material: lamp light. A soft radial warm pool sits at the top of the reading pane (and behind the headline count on phones), the selected list row is lit from the left, and "on" filters glow amber as small objects. Everything else is dark wood-brown neutrals. The source hues are tiny owned marks, like coloured spines on a shelf.

## The signature interaction

**Set aside.** When a filter hides items, the count headline rolls down ("38 worth reading" to "31"), the hidden rows fold away (height and opacity, 180ms, spring-ish ease), and a "7 set aside · undo" receipt appears at the foot of the list for 6 seconds. Tapping "why" on any receipt opens the hidden list with each item's reason. Reduced motion: instant swap, receipt still shown.

## Voice

Rules: (1) say the number and the reason, never an adjective ("31 hidden by “giveaway”", not "Cleaned up your feed!"); (2) no exclamation marks, no "Oops"; (3) name the platform and the action exactly, including what we cannot do ("X bookmarks need your approval in X's own login page").
