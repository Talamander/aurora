# Telegram (public channels)
Status 2026-10-12: works — `https://t.me/s/durov` returned 200 (148 KB HTML) with 20 messages, text, photos, video URLs and view counts. No auth. Best tier: http.
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Hosts: `t.me`, `telegram.me`, `telegram.dog`. Patterns:
  - `t.me/<channel>`, `t.me/s/<channel>`, `t.me/<channel>/<msgId>`;
  - `@channel`, `tg://resolve?domain=<channel>`.
- The username is the id; there is nothing to resolve.
- Only PUBLIC broadcast channels (and some public supergroups) have the `/s/` web preview. Private invite links (`t.me/+abc`, `t.me/joinchat/`) cannot be read.
- Unknown or private channel [LIVE]: `t.me/s/<x>` gives a 302 to `https://t.me/<x>` (preview not available).
- Some channels disable the preview, and some are restricted by country or content. Both redirect the same way.

## Primary technique
- [LIVE] `GET https://t.me/s/<channel>` with a desktop UA. It returns the latest about 20 posts in chronological order, oldest first on the page; the newest is last.
- Older posts: `GET https://t.me/s/<channel>?before=<msgId>`. The page has `<link rel="prev" href="/s/durov?before=531">` and `data-before="531"` [LIVE].
- Newer posts: `?after=<msgId>`.
- Single post: `https://t.me/<channel>/<id>?embed=1&mode=tme` (widget HTML).

## Response shape (HTML; parse with regex or a light parser; selectors verified [LIVE])
- Each post is `div.tgme_widget_message_wrap > div.tgme_widget_message[data-post="durov/552"]`. The `data-post` value is the id. Permalink: `https://t.me/<data-post>`.
- Text: `div.tgme_widget_message_text` (HTML with `<br>`, links and `<tg-emoji>` custom emoji wrappers). Run `sr.html_to_text`.
- Time: `a.tgme_widget_message_date > time[datetime="2026-10-11T14:52:40+00:00"]`.
- Author: `a.tgme_widget_message_owner_name > span` (channel title). Channel header: `.tgme_channel_info_header_title span`. Avatar: `<meta property="og:image">` on the `/s/` page (a cdn*.telesco.pe URL).
- Photos: `a.tgme_widget_message_photo_wrap[style*="background-image:url('https://cdn4.telesco.pe/file/...')"]`.
- Video: `<video src="https://cdn4.telesco.pe/file/<hash>.mp4?token=...">`, with a thumb in `i.tgme_widget_message_video_thumb` style. Large videos show "Media is too big", meaning view it in Telegram (no src).
- Views: `span.tgme_widget_message_views` (e.g. "5.8M"). Forwarded-from: `.tgme_widget_message_forwarded_from_name`. Link preview: `a.tgme_widget_message_link_preview`.
- Albums: several `photo_wrap` elements under `.tgme_widget_message_grouped_wrap`.
- Media URLs are signed and expire, so treat them as short-lived. Store them, but expect them to rot.

## Hosts to declare
`t.me`, `cdn1.telesco.pe` through `cdn5.telesco.pe` (wildcard `*.telesco.pe`), `telegram.org` (emoji images).

## Limits & politeness
- No published limit. One page per channel per hour is fine.
- Heavy scraping gets `429`, or a "Too Many Requests" page [MEM].

## Failure signatures
- A 302 to `https://t.me/<x>` (no `/s/`) means not public, no preview, or no such channel.
- 200 with zero `tgme_widget_message_wrap` means an empty channel, or a group that has no preview.
- Class `text_not_supported_wrap` appears on every message. It is a decoy fallback block and does NOT mean failure. Read `.tgme_widget_message_text` instead.

## Fallbacks (in order)
1. `t.me/s/<channel>` HTML.
2. `sr.browser("https://t.me/s/<channel>")`, only if the HTML layout changes.
3. RSSHub-style third-party mirrors, if the user configures them (not by default).

## Signed-in tier
The user's channel list needs MTProto (Telethon or Pyrogram) with their own api_id and a phone login, or web.telegram.org in the app's browser. That is heavy. Usually you do not need it: the user can paste the channel names, and each public channel works logged-out.

## Apify hints
Apify Telegram channel scrapers parse the same `t.me/s/` preview and paginate with `?before=`.

## Sketch
```python
import re, html, sr
ch = sr.input["channel"].lstrip("@").split("/")[-1]
r = sr.fetch(f"https://t.me/s/{ch}", headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"})
if "/s/" not in r.url or r.status != 200: raise SystemExit(f"no public preview for {ch} (redirected to {r.url})")
title = (re.search(r'tgme_channel_info_header_title"><span dir="auto">([^<]*)', r.text) or [None, ch])[1]
avatar = (re.search(r'<meta property="og:image" content="([^"]+)"', r.text) or [None, None])[1]
last = sr.state.get("last", 0)
for block in r.text.split('class="tgme_widget_message_wrap')[1:]:
    post = re.search(r'data-post="([^"]+)"', block).group(1); n = int(post.split("/")[1])
    if n <= last: continue
    t = re.search(r'class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', block, re.S)
    when = re.search(r'<time datetime="([^"]+)"', block)
    photos = re.findall(r"message_photo_wrap[^>]*background-image:url\('([^']+)'\)", block)
    vids = re.findall(r'<video[^>]*src="([^"]+)"', block)
    views = re.search(r'tgme_widget_message_views">([^<]+)', block)
    sr.emit({"id": post, "url": f"https://t.me/{post}", "author": {"name": html.unescape(title), "handle": ch, "url": f"https://t.me/{ch}", "avatar": avatar},
             "text": sr.html_to_text(t.group(1)) if t else "", "publishedAt": when.group(1) if when else None,
             "media": [{"type": "image", "url": u} for u in photos] + [{"type": "video", "url": html.unescape(u)} for u in vids],
             "kind": "post", "metrics": {"views": views.group(1) if views else None}})
    last = max(last, n)
sr.save_state({"last": last})
```
