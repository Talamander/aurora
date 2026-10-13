# Accessibility

Aurora should work from the keyboard alone and make sense to a screen reader, in every theme,
without looking any less like itself. This page says what was checked, how to check it again, and
what has not been checked.

## Run the sweep

```sh
npm start                                   # or any running Aurora
npm run a11y -- http://127.0.0.1:4317       # summary; exits 1 on a serious or critical issue
npm run a11y -- URL --verbose               # every failing element with axe's reason
npm run a11y -- URL --presets aurora,nord,matte-black --only timeline,palette --json out.json
npm run a11y -- URL --desktop 960x1400 --phone 720x1400   # tiled-window sizes (Hyprland halves and thirds)
```

`scripts/a11y.mjs` opens each surface in Chromium (`CHROMIUM=/path` to override
`/usr/bin/chromium`) with reduced motion on, and runs axe-core against WCAG 2.0, 2.1 and 2.2 A
and AA plus axe's best-practice rules. By default it covers three presets (Aurora, Gruvbox,
Solarized) in dark and light. To test a preset it changes the server's `ui.look` setting and puts
it back afterwards, so point it at a scratch server if you would rather it did not touch yours.

Surfaces: the timeline, keyboard help, Ask panel, command palette, Sources, Filters, the Why
panel, the reader, Read later, Highlights, Workshop, AI settings, Look, Friends, New profile, and on
a 390px phone the timeline with its Views, Rules and Sources sheets. Run it against an empty data
directory for the first-run screen and with `SR_CLOUD=1` for the lock screen.

Aurora often lives in a tiled window, so `--desktop` and `--phone` change the two window sizes
(defaults 1440x900 and 390x844). From 861 to 1240px wide the desktop layout drops the rules pane;
at 860px and below the phone layout takes over. `npm run smoke` also runs at 960x1400 and 720x1400.

Two kinds of target-size result are dropped as noise: a post that happens to sit under the
floating lens dock or phone tab bar when the page loads, and content covered by an open sheet.

## Results (2026-10-13)

| | critical | serious | moderate | minor |
|---|---|---|---|---|
| Before, library of 46 posts, 98 surface runs | 8 | 1,459 | 0 | 46 |
| After, same runs | 0 | 0 | 0 | 0 |

Counts are failing elements summed over runs, so one bad element on the timeline counts once per
surface. The empty library (first run, 38 runs) and the lock screen (8 runs) had no serious or
critical issues before or after. All twelve presets were swept in dark and light on ten surfaces
(240 runs) with no contrast failures after the fixes.

What was fixed:

- **Names that matched what is on screen.** Avatar buttons showed initials that were not in their
  name ("Everything from Hugo Lefèvre"); the initials are now drawn by CSS, so speech users and
  screen readers get one name. The unread dot is announced as an image named "New".
- **Lists that are lists.** The "Clear all" button sat directly inside a list of filter chips.
- **Dialogs.** Sheets were `<aside role="dialog">`, which is not a valid pairing; they are plain
  dialogs now. The command palette let Tab escape it, because its result rows (arrow-key options
  with `tabIndex=-1`) counted as Tab stops in the focus trap. Dialogs with an autofocused field
  (the palette) returned focus to themselves on close, so focus fell to the page; the opener is
  now recorded before the field takes focus. Closing the Ask panel also returns focus to whatever
  opened it.
- **Contrast in every preset.** Aurora light's lamp (white on `#d4461a`, 4.48:1) is a shade
  darker. The teal "glow" was used as text in places (the Workshop's "Done", "API" tiers, the Why
  pill's highlight, sign-in states) at 2.8 to 3:1 in light themes; text now uses a new
  `--glow-ink` token that is the glow mixed toward the ink colour in light mode and the glow itself
  in dark. Small muted text was nudged to 4.5:1 on raised surfaces in Tokyo Night, Catppuccin,
  Nord and Everforest, and Tokyo Night light gets its own warning red.
- **Dark-only presets in light mode.** Matte Black, Osaka Jade and Ristretto have no light palette;
  in light mode they painted dark colours over light base tokens, so platform colours, warnings
  and toasts were the light-mode values on a dark ground (the X hue was near-black on black). These
  presets now always paint dark.
- **Keyboard.**
  - A "Skip to the feed" link is the first Tab stop.
  - `j`/`k` move focus to the post, not only the highlight, so a screen reader reads the post's
    author and title and Tab goes straight to that post's actions.
  - The feed keeps focused items clear of the sticky header and the floating dock
    (`scroll-padding`).
  - The focus ring follows each control's own rounded shape instead of forcing a 4px corner.
- **Announcements.** The Ask panel says "Working on it" when a run starts and reads the finished
  reply once (without citation markup), instead of nothing; streamed tokens are not announced one
  by one. The conversation is a labelled log.
- **Smaller things.** The MCP command box can be focused and scrolled by keyboard. Profile colours
  are announced as "Blue", "Pink" and so on, not hex codes.
- **The `?` sheet** lists every feed shortcut (some were missing: `o`, `r`, `l`, `m`, `Tab`, `?`)
  and a second section for the reader's keys.

Already in place before this pass: labelled icon buttons in most places, a focus trap and focus
return in sheets, `role="status"` toasts, a global reduced-motion rule plus per-animation
fallbacks, radio groups for segmented controls, and alt text policy (decorative images have empty
alt).

## Keyboard map

Press `?` anywhere in the feed for the full list. In short: `j`/`k` move between posts, `Enter`
opens, `r` reader, `l` Read later, `s` save, `e` hide, `w` why, `/` search, `f` filters, `g`
sources, `.` ask, Ctrl/Cmd K search everything, Alt/Cmd 1-9 profiles, `z` undo, `Esc` closes.
In the reader: `j`/`k` scroll, `g`/`G` top and end, `h` highlight, `l` listen, `+`/`-` size,
`o` original.

## Not checked

- **Real screen readers.** Nothing here was tried with Orca, NVDA, JAWS, VoiceOver or TalkBack;
  this machine has no way to drive one from a script. Names, roles and live regions were checked
  with axe and by reading the DOM, which catches wiring mistakes but not how it actually sounds.
  The first real test should be the Ask panel announcements and `j`/`k` focus in Orca and
  VoiceOver.
- **Contrast over pictures and gradients.** axe cannot measure text drawn over blurred post images,
  glass, or gradients and reports those as "needs review". The hero count, glass dock and lit
  buttons were checked by eye in screenshots, not measured.
- **Widgets and pages the AI builds.** These run in sandboxed frames with their own markup; the
  sweep does not look inside them.
- **The phone app (Expo), desktop shell (Electron) and terminal client.** Only the web app was
  swept. The Electron app loads the same web app, so most of this carries over.
- **Zoom and text spacing.** 200% zoom and WCAG text-spacing overrides were not tested.
- **Windows High Contrast / forced colours.** Not tested.
