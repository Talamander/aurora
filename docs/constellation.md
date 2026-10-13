# Constellation

Constellation is a full-screen map of your reading world, drawn as a slowly drifting night sky.
The people you read, the sources they come from and the topics you follow become stars, planets
and bright four-point sparkles. It answers questions like "who do I actually spend time with?" and
"which sources feed the topics I care about?" at a glance.

Everything is worked out on your own computer from the library Aurora already has. Constellation
makes no AI calls and no network requests (apart from the local avatar proxy the feed already
uses), and nothing is sent anywhere.

## Opening it

- **Command palette.** Press Ctrl/Cmd K and choose "Constellation" (also found by typing "map",
  "sky", "network" or "who do I read most").
- **Rail.** The constellation button in the rail tools, next to Ambient.
- **What's new.** The "Constellation" entry under "Also new", with a "Look up" button.
- **URL.** Add `?constellation=1` to the address, like `?ambient=1` and `?week=1`. The parameter
  is removed from the address once the map opens.

The map always shows the active profile. Switching profile while it is open rebuilds it.

## What you see

- **People** are glowing dots, or their avatar once they are big enough. Each person is an author
  of posts in your library.
- **Sources** are planets with a faint orbit ring, coloured by platform using the current theme's
  hues (Bluesky blue, RSS orange, and so on). Platforms without a theme colour get a stable colour
  of their own.
- **Topics** are four-point sparkles, each with its own colour.

**Size** follows how much you engaged with a node over the last 90 days in the active profile.
Reading a post counts 1, saving it 3, highlighting in it 3, and keeping it in Read later or another
collection adds a little more. A small extra for the sheer number of posts lets busy sources show
even when you rarely open them.

**Lines** join a person to the sources they appear in and the topics they post about (their top
two of each), and a topic to the sources that feed it most (its top three).

To keep the sky readable and fast, the map holds at most about 150 nodes: up to 24 sources, 16
topics and 110 people. People appear when you engaged with them at least once or they posted at
least three times in the window. If the library has real posts, the demo posts are left out.

The sky follows the theme. In dark themes it is a deep night with aurora light drawn from the
theme's own gradient; in light themes it is a pale dawn with the same colours mixed in gently.
Changing the theme while the map is open repaints it.

## Using it

Hover a node (or move focus to it) to see a card with its name, how many posts you read, saved
and highlighted, how many posts it has in the window, and its latest post. The other nodes dim so
its links stand out.

- **Click a person** to open the existing person view for them.
- **Click a source** to filter the feed to only that source.
- **Click a topic** to filter the feed to only that topic.

Filtering closes the map and shows a toast with Undo, which puts the feed back as it was. The
People, Sources and Topics chips in the header hide or show each kind of node. Fit brings the
whole sky back into view.

### Keyboard

- Arrow keys move focus to the nearest node in that direction.
- Enter opens the focused node, the same as clicking it.
- `+` and `-` zoom, `0` fits the whole sky.
- Escape closes a pinned card first, then the map. Focus returns to whatever opened it.

Feed shortcuts are switched off while the map is open, so typing never changes the feed behind
it. A screen-reader list of every node is also available inside the map, and each move is
announced.

### Mouse and touch

- Drag to pan, scroll to zoom.
- On a phone, drag to pan and pinch to zoom. A tap shows the node's card docked at the bottom of
  the screen with an Open button; tap Open to act on it.
- On tall, narrow screens the layout is turned on its side so it fills the screen.

## Reduced motion

With "reduce motion" set in the system, the layout is computed in one go and drawn still: no
drifting, no live settling and no animated entrance.

## Performance

The layout is a small force simulation written for Aurora (no extra libraries). It runs in short
slices between frames, so the sky forms in front of you over about a second without blocking
input. Once settled, drawing drops to about 30 frames a second while nothing is happening and only
the slow drift moves. The map's code is loaded only when it is first opened.

## Privacy and safety

- Everything is computed locally from your library; no AI, no network.
- Post text in the cards is treated as untrusted and shown as plain text only.
- Opening a node only changes Aurora's own feed filters or opens Aurora's person view. Nothing is
  followed, liked or changed on any source account.

## Code

- `core/constellation.ts`: building the graph (engagement weights, caps, links), node sizes, the
  force simulation and nearest-node search for the keyboard. Pure functions with tests in
  `tests/constellation.test.ts`.
- `web/src/Constellation.tsx` and `web/src/constellation.css`: the canvas sky, card, keyboard and
  pointer handling.
- `web/src/ConstellationEntry.tsx`: the small, always-loaded entry that opens the map from the
  palette, rail, What's new and the URL, and loads the rest on demand.
