# Listen queue

Aurora can read your Read later list aloud, one article after another, like a podcast. It uses
your browser's own speech engine, so nothing is sent to an AI and nothing leaves the computer
except Aurora's usual local calls.

## Starting it

- **Listen to Read later**: from the command palette (Ctrl K), the What's new tour, or the
  **Listen** button at the top of the Read later sheet. It queues every unread article in the list,
  in the order shown.
- **Add one article**: press **Shift P** on a selected post (articles and posts that link to an
  article), or use the headphones button in the reader's top bar.
- **A page**: the morning edition and other pages with digests have a **Queue** button next to
  their own Listen button.

Adding to an empty queue starts playing at once. Adding to a running queue puts the article at the
end and says how many are ahead of it.

## The player

A small bar floats just above the lens dock (or the phone tab bar). It shows the title, the author
or source, which paragraph is being read ("3 of 12") and a progress line.

| Control | What it does |
| --- | --- |
| Play / pause | Pause stops at the current paragraph; play starts that paragraph again. |
| Previous / next paragraph | Jump back or forward one paragraph. Previous is hidden on narrow phones. |
| Next article | Skip to the next article. On the last one it stops and clears the queue. |
| Speed | Cycles 0.8×, 1×, 1.2×, 1.5×, 1.75× and 2×. Remembered in this browser. |
| Queue | Opens the list: jump to any article, move it up or down, or remove it. The voice picker lives here and is remembered in this browser. |
| × | Stop and clear the queue. |

Keys: **p** plays or pauses from anywhere outside a text field and outside full-screen views (Your
week, Ambient and the reader keep their own p). **Space** does the same while focus is inside the
player.

## Media keys and playerctl

The queue publishes a Media Session: title, artist (author or source), album "Aurora", and artwork
(the post's image through Aurora's local image proxy, or Aurora's icon). It answers play, pause,
stop, next track, previous track, seek forward (next paragraph) and seek backward (previous
paragraph).

Chromium and the Electron desktop app pass the Media Session to the desktop as an MPRIS player, so
the keyboard's media keys, Waybar's media module and `playerctl` work:

```sh
playerctl -l              # look for chromium.instance… or the desktop app
playerctl play-pause
playerctl next            # next article
playerctl position 10+    # next paragraph (seek forward)
```

Chromium only treats a page as a media player while a media element is actually playing, and
speech synthesis does not count. So while Aurora speaks it also plays a tiny silent WAV (one second
of silence, built in the page as a `data:` URI, looping). It never touches the network and makes no
sound. It stops whenever the queue pauses or stops.

## Reading position and marking read

- The queue saves your place as it goes (at most every few seconds), using the same reading
  position as the reader. Opening the article in the reader later picks up there, and listening to
  an article you half read in the reader starts where you stopped.
- When an article is read to the end it is marked read and its reading progress is set to done.
  Skipping an article does neither.

## Fetching articles

An article that has never been opened has no text yet. The queue asks the local server to fetch
and extract it, exactly as opening it in the reader would: the same URL checks apply, and no AI is
involved. If the page cannot be fetched, the queue reads the post's own text (a feed summary, say)
instead, and if there is none it skips the article with a message.

## Privacy and safety

- Article text is only spoken or shown as plain text. Nothing from an article is rendered as HTML
  or followed as an instruction.
- Media artwork is only ever a local `/api/img` URL or Aurora's own icon, so the desktop's media
  widget never contacts the post's site.
- Voices, speed and the queue stay in this browser. The voice list comes from your system; some
  browsers offer network voices (for example Chrome's "Google" voices), which send the text to the
  browser vendor. Pick a local voice if that matters to you.

## Limits

- The queue lives in the open tab. Reloading the page clears it (your reading positions are kept).
- Pause and resume restart the current paragraph, because browsers do not resume speech reliably.
- Chrome cuts long utterances short, so paragraphs are spoken in sentence-sized pieces. A single
  very long sentence is still spoken in one piece and may be cut short.
- Headless test browsers have no voices; the automated checks use a stand-in speech engine.
