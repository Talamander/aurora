"""Aurora actor helper library (Python). Stdlib only.

    import sr
    r = sr.fetch("https://example.com/feed.json")
    for post in r.json()["posts"]:
        sr.emit({"id": post["id"], "url": post["url"], "text": post["body"]})
    sr.save_state({"last_id": newest})

All network goes through the host egress proxy (HTTP(S)_PROXY are set for you).
"""

import gzip
import html as _html
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zlib

__all__ = ["input", "state", "emit", "save_state", "log", "fetch", "browser", "html_to_text", "Response", "FetchError"]

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}


def _load(name):
    raw = os.environ.get(name) or ""
    try:
        v = json.loads(raw) if raw else None
    except ValueError:
        v = None
    return v if v is not None else {}


input = _load("SR_INPUT")  # noqa: A001 - part of the documented API
state = _load("SR_STATE")

_out = sys.stdout


def _write(obj):
    _out.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    _out.flush()


def emit(item):
    """Emit one RawPost. Needs at least a string "id" and an http(s) "url"."""
    if not isinstance(item, dict):
        raise TypeError("emit() takes a dict")
    if item.get("id") is None or str(item.get("id")).strip() == "":
        raise ValueError("emit(): item needs an 'id'")
    url = item.get("url")
    if not isinstance(url, str) or not re.match(r"^https?://", url):
        raise ValueError("emit(): item needs an http(s) 'url'")
    item = dict(item)
    item["id"] = str(item["id"])
    _write({"type": "item", "item": item})


def save_state(obj):
    """Persist state for the next run (arrives as sr.state). Last call wins."""
    _write({"type": "state", "state": obj})


def log(msg):
    _write({"type": "log", "msg": str(msg)})


class FetchError(Exception):
    pass


class Response:
    def __init__(self, status, url, headers, body):
        self.status = status
        self.url = url
        self.headers = headers
        self.content = body
        self._text = None

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def text(self):
        if self._text is None:
            ct = self.headers.get("content-type", "")
            m = re.search(r"charset=([\w.:-]+)", ct, re.I)
            try:
                self._text = self.content.decode(m.group(1) if m else "utf-8", errors="replace")
            except LookupError:
                self._text = self.content.decode("utf-8", errors="replace")
        return self._text

    def json(self):
        t = self.text.lstrip()
        if t.startswith(")]}'"):
            t = t.split("\n", 1)[1] if "\n" in t else ""
        return json.loads(t)

    def __repr__(self):
        return f"<Response {self.status} {self.url}>"


class _NoRaise(urllib.request.HTTPErrorProcessor):
    def http_response(self, request, response):
        return response

    https_response = http_response


_opener = urllib.request.build_opener(urllib.request.ProxyHandler(), _NoRaise)


def _decode(body, encoding):
    encoding = (encoding or "").lower()
    if encoding in ("gzip", "x-gzip"):
        return gzip.decompress(body)
    if encoding == "deflate":
        try:
            return zlib.decompress(body)
        except zlib.error:
            return zlib.decompress(body, -zlib.MAX_WBITS)
    return body


def fetch(url, headers=None, method="GET", body=None, timeout=30):
    """HTTP request through the egress proxy. Never raises on HTTP status; check .status.

    body may be bytes, str, or a dict/list (sent as JSON).
    """
    h = dict(DEFAULT_HEADERS)
    for k, v in (headers or {}).items():
        for existing in list(h):
            if existing.lower() == k.lower():
                del h[existing]
        h[k] = v
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            if not any(k.lower() == "content-type" for k in h):
                h["Content-Type"] = "application/json"
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = body
    req = urllib.request.Request(url, data=data, headers=h, method=method.upper())
    try:
        with _opener.open(req, timeout=timeout) as r:
            raw = r.read()
            hdrs = {k.lower(): v for k, v in r.headers.items()}
            return Response(r.status, r.geturl(), hdrs, _decode(raw, hdrs.get("content-encoding")))
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if "403" in str(reason) or "Tunnel connection failed" in str(reason):
            raise FetchError(f"{url}: blocked by egress proxy or upstream refused tunnel ({reason}). Is the host in the manifest's hosts?") from None
        raise FetchError(f"{url}: {reason}") from None


def browser(url, wait_ms=1500, scroll=0, capture=None, timeout=90):
    """Render url in the host's Chromium. Returns dict with url, status, title, html, text,
    links [{href,text}], json [{url,status,contentType,body}] and blocked [str].

    capture: regex of response URLs to keep (default: every JSON XHR/fetch response).
    """
    payload = {"url": url, "wait_ms": wait_ms, "scroll": scroll}
    if capture:
        payload["capture"] = capture
    r = fetch("http://sr.internal/browser", method="POST", body=payload, timeout=timeout,
              headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        data = r.json()
    except ValueError:
        raise FetchError(f"browser({url}): bad response {r.status}") from None
    if r.status != 200:
        raise FetchError(f"browser({url}): {data.get('error', r.status)}")
    return data


_BLOCK = re.compile(r"</?(p|div|h[1-6]|blockquote|pre|ul|ol|li|table|tr|figure|section|article)\b[^>]*>", re.I)


def html_to_text(html):
    """Plain text from an HTML fragment (scripts and styles dropped)."""
    if not html:
        return ""
    s = re.sub(r"<(script|style|noscript|template)[\s\S]*?</\1>", " ", html, flags=re.I)
    s = re.sub(r"<!--[\s\S]*?-->", " ", s)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = _BLOCK.sub("\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s)
    lines = [re.sub(r"[ \t\f\v\xa0]+", " ", ln).strip() for ln in s.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
