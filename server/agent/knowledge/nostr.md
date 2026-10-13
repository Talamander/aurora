# Nostr
Status 2026-10-12: works — a WebSocket REQ to `wss://relay.damus.io` returned kind-1 notes and the kind-0 profile for fiatjaf. NIP-05 lookup returned 200. `api.nostr.band` timed out (looks dead). Best tier: api (WebSocket).
Legend: [LIVE] verified today from this machine · [DOCS] docs/GitHub issues/blog found today · [MEM] memory, unverified.

## Identify & resolve
- Inputs:
  - `npub1...` (bech32 pubkey);
  - `nprofile1...` (pubkey plus relay hints);
  - hex pubkey (64 chars);
  - NIP-05 `name@domain`;
  - web URLs: `njump.me/<npub|nip05>`, `primal.net/p/<npub>`, `snort.social/p/...`, `iris.to/...`, `coracle.social/...`.
- NIP-05 to hex [LIVE]: `GET https://<domain>/.well-known/nostr.json?name=<name>` gives `{"names":{"<name>":"<hex>"},"relays":{"<hex>":["wss://..."]}}`. Use `_` for the root name (e.g. `fiatjaf.com`).
- npub to hex: bech32 decode (pure Python, about 30 lines, or `pip install bech32`).

## Primary technique
- Open a WebSocket to 2 or 3 relays (`wss://relay.damus.io` [LIVE], `wss://nos.lol`, `wss://relay.primal.net`, plus the user's relays from NIP-05 or kind 10002).
- Send `["REQ","sub1",{"authors":["<hex>"],"kinds":[1,6],"limit":30,"since":<unix>}]`. Read `["EVENT","sub1",{...}]` messages until `["EOSE","sub1"]`, then send `["CLOSE","sub1"]`.
- Profile: `{"authors":[hex],"kinds":[0],"limit":1}`. Its content is a JSON string with `name`, `display_name`, `picture`, `about`, `nip05`.
- Relay list: kind 10002 (NIP-65), where `r` tags list write relays. Fetch from those for completeness.
- Long-form posts: kind 30023 (markdown, with `title`, `image` and `published_at` tags).
- IMPORTANT for the sandbox: `sr.fetch` is HTTP only. A WebSocket needs the `websockets` package (`"python":{"requires":["websockets>=13"]}`), and the egress proxy must allow `wss://` CONNECT to the relay hosts. If the proxy cannot do that, use the HTTP fallback.

## Response shape (event)
- id: `id` (hex). Permalink: `https://njump.me/<nevent or note bech32>`. `https://njump.me/<hex id>` also works [MEM].
- text: `content` (plain text with `nostr:npub...` mentions; image and video URLs appear inline as plain links).
- time: `created_at` (unix seconds).
- author: `pubkey`, joined with the kind-0 profile.
- media: extract URLs matching `\.(jpg|jpeg|png|gif|webp|mp4|mov)` from `content`, and `imeta` tags (NIP-92) `["imeta","url https://...","m image/jpeg",...]`.
- Kind 6 is a repost; its `content` holds the original event JSON.
- Replies have `e` tags with the "reply" or "root" marker. Skip them for a posts-only feed.
- Dedupe by `id` across relays.

## Hosts to declare
- Relay hosts (e.g. `relay.damus.io`, `nos.lol`, `relay.primal.net`) and the NIP-05 domain.
- Media hosts are arbitrary (`image.nostr.build`, `blossom.primal.net`, `i.imgur.com`, ...). Media URLs are just links, so only declare a host if the actor downloads from it.

## Limits & politeness
- Relays cap `limit` (often 500) and may rate-limit per IP.
- Keep one connection per relay and close subscriptions after EOSE.

## Failure signatures
- `["NOTICE","..."]` or `["CLOSED","sub1","rate-limited: ..."]` or `"auth-required:"` (NIP-42). Skip that relay.
- A relay that sends no EOSE within 10 s: time out and move on.
- `api.nostr.band`: connection timeout today [LIVE]. Do not depend on it.

## Fallbacks (in order)
1. WebSocket to the relays.
2. HTTP: `https://njump.me/<npub>` [LIVE 200 HTML]. It renders recent notes server-side; parse the HTML, or use `sr.browser`.
3. `primal.net/p/<npub>` in `sr.browser`, capturing its cache API JSON [LIVE 200 page].

## Signed-in tier
- Not needed. The follow list is public: kind 3 (`{"authors":[hex],"kinds":[3],"limit":1}`); `p` tags hold the followed pubkeys.
- The "home feed" is just a REQ with `authors` set to that list.

## Sketch
```python
import asyncio, json, sr, websockets  # manifest: "python": {"requires": ["websockets>=13"]}
hexpk = sr.input["pubkey_hex"]; since = sr.state.get("since", 0)
async def pull(url, out):
    try:
        async with websockets.connect(url, open_timeout=10) as ws:
            await ws.send(json.dumps(["REQ", "p", {"authors": [hexpk], "kinds": [1], "limit": 30, "since": since}]))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if m[0] == "EVENT": out[m[2]["id"]] = m[2]
                elif m[0] in ("EOSE", "CLOSED"): break
    except Exception as e: sr.log(f"{url}: {e}")
evs = {}
asyncio.run(asyncio.wait_for(asyncio.gather(*(pull(u, evs) for u in ["wss://relay.damus.io", "wss://nos.lol"])), 30))
for e in sorted(evs.values(), key=lambda e: e["created_at"]):
    if any(t[0] == "e" for t in e["tags"]): continue  # reply
    sr.emit({"id": e["id"], "url": f"https://njump.me/{e['id']}", "author": {"name": hexpk[:8], "handle": hexpk},
             "text": e["content"], "publishedAt": __import__("datetime").datetime.utcfromtimestamp(e["created_at"]).isoformat() + "Z", "kind": "post"})
if evs: sr.save_state({"since": max(e["created_at"] for e in evs.values()) + 1})
```
