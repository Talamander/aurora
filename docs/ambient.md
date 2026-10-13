# Ambient

Ambient is a lean-back, full-screen display of your feed. Put it on a second monitor, a TV, or
leave the desktop app window open on it. It slowly cycles the active profile's worth-reading posts:

- **Photos and video thumbnails** fill the screen and drift slowly (a Ken Burns move). Behind them
  sits a soft, blurred aurora made from the picture's own colours. Pictures that are much taller or
  wider than the screen are shown whole instead of cropped.
- **Short text posts** are set big in display type. The longer the post, the smaller the type.
- **Articles** get a title card with the headline and an excerpt in Literata.
- **Author, source and time** sit small in a corner. Fictional demo posts say so.
- **A clock** sits in the top-left corner (you can turn it off). There is no weather and Ambient
  makes no new network requests.

## Opening it

- The command palette: type "Ambient".
- The rail: the picture button above Workshop. On phones, it is the "Ambient" button at the foot
  of the Views sheet.
- Ask the AI: "put my feed on the TV", "screensaver of my photos", "slideshow of Mara's posts".
  The agent tool `open_ambient` takes an optional view, `photosOnly`, person and pace.
- A link: `http://127.0.0.1:4317/?ambient=1`.
- The desktop app: the tray item **Ambient on this screen** moves the Aurora window to the screen
  your mouse is on and goes full screen there.

Browsers only allow full screen after a click. When Ambient opens from the AI or from a link, press
the full-screen button in the top-right corner or the `f` key. The desktop app goes full screen by
itself.

### Link options

| Parameter | Example | Meaning |
|---|---|---|
| `ambient` | `ambient=1`, `ambient=photos` | Open Ambient (`photos` also turns on photos only) |
| `view` | `view=saved` | A view id or name |
| `person` | `person=mara` | One person's name or handle |
| `photos` | `photos=1` | Only posts with a picture |
| `pace` | `pace=30` | Seconds per post, rounded to 8, 15 or 30 |

The options are removed from the address bar when you leave Ambient.

## Controls

Move the mouse or touch the screen to show the controls. They fade away, together with the cursor,
after about three seconds.

- **Pace:** 8, 15 or 30 seconds per post.
- **Shuffle:** a new random order. People are spread out so you never see the same person twice
  in a row.
- **Photos:** only posts with a picture or video thumbnail.
- **View** and **Person:** narrow to one view or one person.
- **Clock:** show or hide the clock.

Your pace, shuffle, photos and clock choices are remembered in this browser.

| Key | Action |
|---|---|
| Space | Pause or play |
| ← → | Previous or next post |
| `s` | Save or unsave |
| `o` or Enter | Leave Ambient and open the post in Aurora |
| Shift+`o` | Open the original link in a new tab |
| `h` | Hide the post from the feed (Undo is in the toast) |
| `p` | Photos only on or off |
| `f` | Full screen on or off |
| Esc | Leave Ambient |

On touch screens, swipe left or right to move and tap to pause.

## Safety and privacy

- Pictures only load through Aurora's own image proxy, like the rest of the app.
- Videos are shown as their thumbnails. Nothing plays, so nothing plays with sound.
- Post text is rendered as plain text. No HTML from a post is ever drawn.
- Ambient never marks posts read, so you can leave it running without emptying your feed.
- Ambient is always dark, whatever the app theme, because it is meant for a dim room.

## Reduced motion

With "reduce motion" set in your system, Ambient only crossfades between posts. The pictures do
not drift and the aurora does not move.

## Omarchy

See [omarchy.md](omarchy.md#ambient) for a key binding that opens Ambient in its own window.
