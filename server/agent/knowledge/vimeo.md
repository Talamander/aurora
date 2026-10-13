# Vimeo
Status 2026-10-12: works (feed) — `https://vimeo.com/staff/videos/rss` returned 200 `application/rss+xml` with 10 items. Best tier: api (RSS).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
Hosts `vimeo.com`, `player.vimeo.com`. User: `vimeo.com/{user}` (vanity) or `vimeo.com/user12345`; channel `vimeo.com/channels/{name}`; group `vimeo.com/groups/{name}`; showcase `vimeo.com/showcase/{id}`. Numeric path = single video.

## Primary technique
- User uploads: `https://vimeo.com/{user}/videos/rss` [LIVE].
- Channel: `https://vimeo.com/channels/{name}/videos/rss`; group: `https://vimeo.com/groups/{name}/videos/rss`; user likes: `https://vimeo.com/{user}/likes/rss` [MEM].
- Single video meta: oEmbed `https://vimeo.com/api/oembed.json?url=https://vimeo.com/{id}` [MEM].
Plain desktop UA, no headers needed.

## Response shape (RSS 2.0 + Media RSS)
channel `title` ("Vimeo / Vimeo’s videos"); item: `title`, `pubDate` (RFC 822 with offset), `link` (`https://vimeo.com/{id}`), `description` (truncated HTML), `guid` (`tag:vimeo,2026-06-17:clip{id}`), `media:content[@duration]`, `media:player[@url]` (`player.vimeo.com/video/{id}?h=…` embed), `media:credit` (author name), `media:thumbnail[@url]` (`i.vimeocdn.com/video/…-d_960`). Author avatar not in feed (use oEmbed `author_url`, or skip). Id = digits from `link`.

## Hosts to declare
`vimeo.com`, `player.vimeo.com`, `i.vimeocdn.com`.

## Limits & politeness
Feed shows ~10–20 newest. Hourly is fine. Vimeo's site behind Cloudflare can 403 bots on HTML pages [MEM]; RSS has been fine.

## Failure signatures
404 for unknown user; feed with zero `<item>` for private/unlisted-only accounts.

## Fallbacks
1. RSS → 2. `yt-dlp --flat-playlist -J https://vimeo.com/{user}/videos` (`vimeo:user`) [MEM] → 3. official API v3 needs a free app token (user-supplied only).

## Signed-in tier
Not worth it; Vimeo has no meaningful home feed. Use per-user RSS.

## Sketch
```python
import re, sr, xml.etree.ElementTree as ET
user = sr.input["user"].rstrip("/").split("/")[-1]
M = "{http://search.yahoo.com/mrss/}"
root = ET.fromstring(sr.fetch(f"https://vimeo.com/{user}/videos/rss").text)
from email.utils import parsedate_to_datetime
for it in root.iter("item"):
    link = it.findtext("link"); vid = re.search(r"(\d+)$", link).group(1)
    th = it.find(f".//{M}thumbnail"); cr = it.find(f".//{M}credit")
    sr.emit({"id": vid, "url": link, "title": it.findtext("title"), "text": sr.html_to_text(it.findtext("description") or ""),
             "publishedAt": parsedate_to_datetime(it.findtext("pubDate")).isoformat(),
             "author": {"name": cr.text if cr is not None else user, "handle": user, "url": f"https://vimeo.com/{user}"},
             "media": [{"type": "video", "url": link, "thumb": th.get("url") if th is not None else None}], "kind": "video"})
```
