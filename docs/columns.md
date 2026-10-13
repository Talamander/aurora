# Columns

Columns tiles several feeds side by side, TweetDeck style with a Hyprland feel: gaps, thin borders,
and the focused column ringed in the accent. Each column scrolls on its own.

## Turning it on

- Press `c` anywhere in the web app (not while typing), or
- click the columns button in the rail's tool row, or
- pick "Columns" in the command palette (`Ctrl+K`), or "Tile them" in What's new.

Press `c` again, or "One feed" in the Columns bar, to go back. Clicking a view, topic or source
in the rail also returns to the single feed with that choice.

The first time, Aurora builds a starter layout: Worth reading for All and up to three profiles,
then a topic or busy source, Read later or Saved if they have posts, and Everything to make three.

## What a column can show

Each column is a profile plus one of:

- a view: Worth reading, Saved, Everything, Archive or any saved view
- Read later
- a topic or a source
- a collection
- a search query

Add one with "Add column" or `n`. A column whose topic, source or view has been deleted
disappears from the layout quietly.

## Keys

| Key | Does |
| --- | --- |
| `←` `→` or `Shift+H` `Shift+L` | Move focus between columns |
| `1`–`9` | Focus that column |
| `j` `k` | Next or previous post in the focused column |
| `[` `]` | Move the focused column left or right |
| `n` | Add a column |
| `q` | Close the focused column (with undo) |
| `c` | Leave Columns |

The usual post keys (`Enter`/`o`, `r`, `l`, `s`, `u`/`m`, `e`, `w`, `i`, `v`) act on the selected
post in the focused column. Columns can also be dragged by their header to reorder, and the
expand button makes a column twice as wide.

## Where it is stored

The layout lives in the server settings table under `ui.columns`, so the desktop app and the
browser share it. Saving is debounced. At most 8 columns are kept.

## Phones and narrow windows

On phone widths Columns is not shown; the normal single feed is. On narrow desktop windows the
row of columns scrolls horizontally and snaps to each column.

## Performance

Each column filters its own scoped library with the same `applyFilters` path as the main feed,
incrementally once it has a previous result. First filters are staggered by 30 ms per column so
four to six columns on a 100k library do not all land in one frame. Columns render 40 posts at a
time and load more as you scroll, so the DOM stays small however big the library is.

## Limits

- No Alerts-hits column yet.
- Posts from a profile other than the active one use the active profile's source list for labels,
  so a source name can fall back to the platform name.
- A post that appears in two columns shows as selected only in the focused one.
