# Aurora security

Aurora is a personal reader that runs on your own machine (or your own server). It pulls posts
from many places, lets an AI read and rearrange them, and lets that AI write code (connectors)
and HTML (widgets). Almost everything it handles is written by strangers. This document says
what we defend against, how, and what we do not.

## Threat model

**What we protect:** your library and reading history, your AI API key, OAuth tokens and the
browser sessions of sites you signed into through Aurora, your local network, and the accounts
you connected (Aurora never writes to them).

**Who we assume is hostile:**

1. **Content.** Every post, feed, web page and image URL. It may contain prompt injection aimed
   at the AI, markup aimed at the renderer, and URLs aimed at your local network.
2. **Other websites in your browser.** Any page you visit can send requests to
   `127.0.0.1:4317`, and can point a DNS name at 127.0.0.1 (DNS rebinding).
3. **AI-written code.** Connectors (actors) and widgets are written by a model that may have
   read injected content. We treat them as untrusted programs, even when they come from your
   own AI.
4. **Imported connector files** from other people.
5. **The network** between Aurora and the sites it fetches.

**Who we trust:** you, and other programs running as your user on the same machine. Aurora is
a local app; a process that can read your files can read your data folder, and we do not try
to stop it (see "Not defended").

## What is defended, and how

### The local server

- Binds to `127.0.0.1` by default. Listening anywhere else requires `ALLOW_NON_LOCAL=1`.
- **DNS rebinding:** every request must carry a known `Host` (`127.0.0.1:PORT`,
  `localhost:PORT`, `[::1]:PORT`, plus `SR_ALLOWED_HOSTS`); anything else gets 421.
- **Cross-site requests:** every non-GET API call must have an allowed `Origin` (or none, for
  curl) and the media type `application/json` exactly. A substring match was not enough: a
  page can send `text/plain; x=application/json` without a CORS preflight. Responses carry no
  CORS headers, so other origins cannot read API data, the event stream or the image proxy
  token.
- Request bodies are capped (1 MB; 80 MB for imports).
- The app is served with a strict CSP (`script-src 'self'`, no inline script, so a
  `javascript:` link cannot run even if one slipped through), `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.

### The owner lock (sign-in)

- **When it is on.** Always on a hosted instance (`SR_CLOUD=1`) and when the server is bound to
  a non-loopback address without `SR_TRUST_NETWORK=1`. On localhost it is optional and off until
  you turn it on in Settings > Lock. There are no passwords and no email.
- **Passkeys first.** WebAuthn is verified with `node:crypto` only (`server/lock.ts`):
  attestation `none`, ES256 (P-256) and RS256 (2048-bit or more) keys. Each ceremony checks the
  single-use challenge (5 minutes), the exact origin (taken from the allowlisted `Origin`
  header), the rpId hash (the host name; IP addresses cannot use passkeys), the user-presence
  flag, the signature over `authenticatorData || SHA-256(clientDataJSON)`, and a signature
  counter that must go up unless it is always zero (synced passkeys).
- **Recovery code.** 160 random bits shown once, stored only as a scrypt hash (N=2^15, r=8,
  p=1). Making a new one stops the old one. It also covers addresses where passkeys cannot work
  (an IP address, plain HTTP off localhost).
- **First claim.** When the lock is required and there is no owner yet, the server prints a
  one-time setup token to its log. Nobody can claim the server without it; it is gone once the
  first passkey or recovery code is made. Lost everything? Start the server once with
  `SR_RESET_LOCK=1` (it clears the owner, passkeys and sessions and prints a new token).
- **Sessions.** A random 256-bit id in an `HttpOnly; SameSite=Strict; Path=/` cookie, `Secure`
  (and `__Host-` prefixed) over HTTPS. Only a SHA-256 of the id is stored. Sessions end after 7
  days idle or 30 days in total, on sign-out, and from "Sign out other sessions" in Settings.
- **CSRF stays as it was.** Writes still need the exact JSON media type and an allowed
  `Origin`; `SameSite=Strict` keeps the cookie off cross-site requests on top of that, so the
  cookie opens no new path. Sign-in, setup and passkey attempts are limited to 10 a minute per
  client address.
- **What skips the session.** Paired phones (their Bearer token keeps its route allowlist), the
  image proxy (its own token), RSS/JSON feeds requested with `?token=`, and the app shell files.
  Everything else under `/api/`, the event stream and widgets need a session. Widgets run in an
  opaque-origin sandbox with `connect-src 'none'`, and the cookie is `HttpOnly`, so they never
  see or use it. The relay port and the MCP server (stdio) are not affected.
- **Terminal client.** While the lock is on, the server keeps `local.key` (mode 0600) in the
  data folder. The terminal client sends it in `X-Aurora-Key`, and the server accepts it only
  from loopback. Anyone who can read that file can already read the whole data folder.
- **Behind a proxy.** `SR_CLOUD=1` or `SR_TRUST_PROXY=1` makes the lock trust
  `X-Forwarded-Proto` (for the `Secure` cookie) and `X-Forwarded-For` (for rate limits). Do not
  set them unless a proxy you control sets those headers.

### Rendering posts

- Post text is rendered as text by React. There is no `innerHTML` of content anywhere.
- URLs are normalised on ingest to http(s) only, without embedded credentials. Rich text
  links only to `https:` URLs.
- Feeds served by Aurora (RSS/JSON) escape all content and are sent with
  `Content-Security-Policy: default-src 'none'; sandbox`.

### Images (the image proxy)

On by default (Settings, "Private pictures"). Post images, thumbnails and avatars load through
`/api/img`, so image hosts never see when you look at a post or your IP address per view.

- Only URLs that are already in your library are fetched. The proxy cannot be used as a
  general fetcher by a widget or a crafted link.
- Each request needs a per-install token that only same-origin pages can read
  (`/api/img/config`). Other websites cannot use the proxy or probe which images you have.
- Fetches use the SSRF-safe fetcher (below), 8 MB cap, 15 s timeout.
- Only JPEG, PNG, GIF, WebP and AVIF are served, typed from their first bytes. SVG is refused.
- Cached in `<data>/cache/img` (0600 files, 512 MB cap). Videos are not proxied.

Measured on a feed of 10 images: first load through the proxy about 1.6 s (direct: 0.9 s),
cached loads 27 ms.

### Fetching URLs (SSRF)

All server-side fetches of content URLs go through `server/safeFetch.ts`:

- http(s) only, no credentials in URLs, `localhost`/`.local`/`.internal` and single-label
  names refused.
- Every resolved address is checked, inside the socket's DNS lookup, so a name cannot resolve
  to a public address for the check and a private one for the connection. Private, loopback,
  link-local, CGNAT, multicast and reserved ranges are refused, including IPv4-mapped,
  IPv4-compatible, NAT64 and 6to4 IPv6 forms. Decimal, octal, hex and short IPv4 spellings are
  normalised by the URL parser before the check.
- Redirects are followed manually (4 at most) and each hop is checked again.
- Size and time caps on every response.

### The AI agent and prompt injection

- Posts reach the model wrapped as untrusted data (`<untrusted>` blocks the content cannot
  close), with instructions not to follow them. The MCP server does the same with a random
  boundary.
- The agent's tools act on local state only: views, pages, topics, rules, the theme, sources.
  No tool posts, likes, follows or messages on any platform.
- Theme tokens the AI sets go through an allowlist (colours, numbers, gradients). Values that
  could load a resource (`url(`, `image-set(`, escapes) are refused, so the theme cannot
  become a tracking beacon.
- Destructive agent actions are undoable from the chat.

### Widgets (AI-written HTML)

- Served from `/widget/:page/:n` with a CSP that includes `sandbox allow-scripts`. The
  document always gets an opaque origin, even when opened directly in a tab, so it cannot read
  the app, its cookies or its API.
- `connect-src 'none'`, `form-action 'none'`, `frame-src 'none'`. Images and media load only
  from Aurora itself (the image proxy), so a widget cannot leak what it was shown through image
  URLs. The page's own `frame-src` stops the widget from navigating its frame elsewhere.
- The widget receives post data by `postMessage`. The page checks `event.source` on every
  message, and `sr.open(url)` only opens URLs that were in the data given to that widget.

### Connectors (actors)

AI-written or imported connector code runs as a separate process:

- **bubblewrap sandbox** (when available): new user, PID, IPC, UTS and network namespaces,
  all capabilities dropped, `--new-session`, read-only system and actor code, a private tmpfs,
  and no access to your home or data folder. The only way out is the run's egress proxy socket.
- **Resource limits:** memory 1.5 GB and 512 tasks (systemd scope), open files, file size and
  core dumps (prlimit), plus a run timeout and output caps.
- **Environment:** built from scratch; no API keys, tokens or session bus addresses.
- **Egress proxy:** every request must match the connector's declared host allowlist, ports
  80/443 only. IP literals are refused outright (decimal, hex and IPv6 forms included), every
  resolved address must be public, and the upstream connection goes to the address that was
  checked (no rebinding). Requests are counted and logged per run.
- **Signed-in sources** use browser profiles owned by Aurora (`<data>/browser-profiles`,
  0700). The connector asks the proxy to render pages; it never receives cookies. The browser
  is driven over a pipe (no remote debugging port) and its requests are filtered by the same
  allowlist and private-address checks.
- **Imports:** a connector file is validated (id, hosts, tier, code size), never overwrites an
  existing connector, and is saved untested. Installing it as a source still needs a passing
  test run, in the sandbox.

### Signing in to sites

- Sign-in happens in a browser window or stream that Aurora controls, with explicit user
  action. Aurora never reads your own browser's profile or cookies, and never returns cookie
  values.
- Profile names are validated; profile folders are 0700.
- In cloud mode (`SR_CLOUD=1`) Meta and X profiles and hosts are refused.

### Secrets at rest

- The AI key, OAuth tokens and the feed and image tokens are stored encrypted (AES-256-GCM)
  in the database. The key is `<data>/secret.key` (32 random bytes, 0600). Older plaintext rows
  are encrypted at startup.
- The data folder is created 0700 and the database file 0600. Aurora warns at startup if the
  data folder is readable by other users.
- Keys set in AI settings are never sent back to the browser. Exports contain no secrets.
  Secrets are never logged.

### Feeds and MCP

- Feeds are open to this machine by default. A request that arrives through a reverse proxy is
  refused until you set a feed token; tokens are compared in constant time.
- With the owner lock on, a feed URL works without a session only once a feed token is set,
  and only with that token. Until then feeds need a signed-in browser like everything else.
- The MCP server runs over stdio, opens the library read-only by default, and can at most
  change local saved/read state with `--allow-local-writes`.

### Archive downloads

- Images go through the SSRF-safe fetcher and are sniffed (raster only). Videos are downloaded
  by yt-dlp through a loopback proxy that only reaches public addresses.
- Size caps per file and per item. Files are served only by names listed in the item's
  manifest, from inside its folder, with fixed content types, `nosniff` and a sandbox CSP.

### Docker

- Runs as uid 1000 with all capabilities dropped and `no-new-privileges`, published on the
  host's loopback only. To give connectors the real sandbox, the compose file relaxes seccomp
  and `/proc` masking for the container; the comments there explain the trade-off.

## Not defended (known limits)

- **Other programs running as you.** They can read the data folder, including `secret.key`.
  Encryption at rest protects copies of the database, not a compromised account.
- **Connectors without bubblewrap.** If bubblewrap cannot run (some containers, some
  distributions), connectors run as plain processes, labelled `isolation: none`. They still get
  a clean environment and proxy settings, but a malicious connector could read your files and
  open sockets directly. Install bubblewrap, or in Docker keep the compose security options.
  This fallback exists only on Linux. On macOS and Windows there is no bubblewrap at all, so
  AI-built connectors refuse to run ("Connectors written by the AI need a sandbox") unless you
  set `SR_ACTOR_ISOLATION=none` yourself; run Aurora in Docker there instead (docs/macos.md).
- **Prompt injection is reduced, not solved.** A post can still steer the AI within what its
  tools allow: change views, pages and the theme (all local and undoable), or choose URLs for
  tools that fetch (`add_feed`, the connector builder's `http_get`), which could carry data in a
  query string to a public host. Review what the AI proposes before installing sources.
- **Signed-in browser DNS rebinding window.** The sign-in and render browser checks that a host
  resolves to public addresses, but Chromium resolves names again itself. A host that rebinds to
  a private address between the two lookups could be reached by that browser.
- **Image proxy timing.** A widget can choose which library images to show, and a host can see
  the first proxied fetch of its own images. This leaks at most which of its already-known
  images were fetched, not your browsing.
- **The lock is off on localhost by default.** Anyone at your unlocked computer (or any program
  running as you) can open Aurora unless you turn the lock on in Settings. On the network or
  hosted it is always on, but use HTTPS there: over plain HTTP the cookie can be read on the
  wire, and passkeys only work on `localhost` or HTTPS.
- **Open event streams survive a sign-out** until the browser reconnects.
- **Dependencies.** `npm audit` reported no known vulnerabilities on 2026-10-13. Chromium,
  yt-dlp and Python packages that connectors request are outside our control.

## Night two review (2026-10-13)

An adversarial pass over everything added on the second night: the owner lock, device tokens,
alerts, Your week, AI routing, the follows importer, search, theme import and the desktop
shell. Each fixed issue has an exploit test in `tests/security-night-two.test.ts` that failed
before its fix.

**Fixed**

- **High: feeds bypassed the owner lock.** With the lock on and no feed token set, any
  `/api/feeds/...?token=anything` URL returned the library without a session, because the feed
  check treats "no token configured" as open. Feeds now skip the session only when a feed token
  exists, and then still need the right one.
- **Medium: login rate limits could be dodged behind a proxy.** With `trustProxy` (the hosted
  default) the limiter keyed on the leftmost `X-Forwarded-For` entry, which the client writes.
  Rotating it gave unlimited recovery-code guesses and unlimited scrypt work, and grew the
  attempts map without bound. The limiter now uses the entry the proxy appended (the last one)
  and refuses new attempts when it is tracking more than 20,000 addresses.
- **Low: the X sign-in callback was blocked by the lock.** It arrives as a cross-site redirect
  without the SameSite=Strict cookie. It is now exempt; its one-time state check still applies.
- **Low: sign-out left library chunks in the browser cache.** Sign-out now sends
  `Clear-Site-Data: "cache"`.
- **Low: prompt fences that a post could close.** The long-form article wrapper only defused
  lower-case `</untrusted>`; Your week embedded post text inside `<posts>` raw and returned
  other people's names and titles unfenced from `open_your_week`. All three are fixed: JSON in
  prompts escapes `<`, and fences defuse closing tags in any case or spacing.
- **Low: the follows importer passed export-file display names to the connector builder.**
  The builder prompt now names only the platform and the validated handle.
- **Low: stored theme tokens could load a URL through CSS escapes or `image-set()`.** The
  browser-side filter now rejects backslashes and every CSS image function, matching the
  server's allowlist for AI-set tokens.
- **Low: desktop notifications on Linux.** Notification daemons read the body as Pango markup,
  so a post title could restyle or spoof a notification. Bodies are escaped on Linux.

**Checked and found sound**

WebAuthn registration and sign-in (single-use challenges, origin, RP ID, user presence,
counter), no session fixation, cookie flags, recovery-code comparison, `lockExempt` against
`..` and percent-encoded paths, that every new route sits behind the lock gate, device-token
route matching and what each allowed route returns, alerts' untrusted wrapping, AI output
rendered as text, the local-model probe (fixed loopback ports only), route API keys sent only
to their own base URL, `spend.db`, `search.db` and `local.key` created 0600, follows
re-validation on the server, the fixed Bluesky AppView host and `safeFetch` everywhere it
fetches, the client ZIP inflate cap, FTS5 query quoting, theme file import (reduced to seed
numbers), desktop IPC sender checks and scheme-checked `openExternal`, Waybar output escaping,
`child_process` calls (argument arrays, no shell), and no `innerHTML` or `eval` sinks.

**Remains**

- An OpenAI-compatible endpoint the owner configures (main or per-task route) may point at a
  private address. That is the owner's choice locally; on a hosted server it lets the owner
  reach the host's private network.
- The setup token printed at first start does not expire until the lock is claimed.
- Many addresses together can still queue scrypt work on the recovery route; the libuv thread
  pool bounds how much runs at once.
- The phone app opens post links with `Linking.openURL`; it relies on the server only storing
  http(s) URLs.
- A prompt-injected agent can create alerts. Alerts cost AI spend but are capped per hour.
- Social and friends sync was not reviewed in depth this round (see the Friends review below).

## Friends review (2026-10-13)

An adversarial pass over Friends: the relay, invites and pairing, the envelope crypto, what a
malicious friend or relay can do, metadata, unfriending, circle-to-profile routing, and the agent
paths that friend content can reach. Exploit tests are in `tests/security-friends.test.ts`; each
one failed before its fix.

**Fixed**

- Medium. Relay rate limit bypass behind a proxy. With `SR_RELAY_TRUST_PROXY=1` the relay keyed
  its limiter on the first `X-Forwarded-For` entry, which the client writes. A fresh fake address
  per request skipped the limit. It now uses the last entry (the one the proxy appends), and the
  limiter map is capped.
- Medium. One sender could fill the relay. The per-mailbox caps did not stop one address from
  writing to many random mailboxes until the 256 MB total was reached, after which every friend's
  delivery failed until the envelopes expired 14 days later. Each address now has a daily storage
  quota (`SR_RELAY_IP_MB_PER_DAY`, default 32 MB).
- Medium. The weekly list could send other people's private posts. It holds every saved post,
  and after one hand-sent list it goes out on its own, so a saved post from a signed-in session
  source (a friends-only Facebook post, say) could reach a friend unseen. Posts from sources
  backed by a `session`-tier connector are now never in a weekly list, by hand or automatically.
  They can still be shared one at a time.
- Medium. Prompt injection through suggested connectors. A friend's connector bundle, once
  imported, kept its description, notes and code comments, and `get_actor` and `list_actors`
  gave them to the builder agent as plain text. Imported connectors (`createdBy: 'import'`) are
  now wrapped as untrusted data in both tools.
- Low. A leaked invite could make several friend requests. When two hellos for the same invite
  arrived in one poll, both became requests. The invite is now claimed atomically and only the
  first hello counts.
- Low. Impersonation by rename. A friend could change their handle to another friend's handle or
  to the nickname you gave someone else, and show up under that name. A rename that collides is
  now ignored (the old handle stays).
- Low. Unfriending did not cancel queued messages. A share, list or collection still in the
  outbox was delivered after the friend was removed. Removing a friend now drops everything
  queued for them before the goodbye.
- Low. Weekly-list scope ignored circles. A friend in a circle mapped to one profile still
  defaulted to the whole library, so a work contact could get saved posts from a personal
  profile. The default is now that profile when the friend's circles map to exactly one.
- Low. The connector suggestion card now warns when the suggested connector uses a signed-in
  browser profile.

**Checked, no change needed**

Envelope sealing (ephemeral X25519, HKDF, AES-256-GCM with the mailbox and ephemeral key in the
associated data), the signature binding sender, recipient and body (no forwarding between
friends), replay ids with a timestamp window, sender checked against the mailbox's friend, invite
proofs, relay ids that a relay cannot use to cross-deliver, padding buckets, size caps on every
incoming field, plain-text cleaning (control, zero-width and bidi characters), http(s)-only links
and relay addresses, React text rendering and text-only phone screens, friend posts never
re-shareable and wrapped as untrusted when the agent reads them, connector suggestions imported
only by hand and untested until run in the sandbox, relay fetches through `safeFetch`, and no code
path that writes to a source platform.

**Remains**

- The relay sees client IP addresses, envelope sizes and timing, and which mailboxes one client
  fetches together, so it can tell how many friends a client has and when they talk. Mailbox ids
  rotate weekly but are fetched as a set.
- Behind a proxy without `SR_RELAY_TRUST_PROXY=1`, every client shares one address, and so one
  rate limit and one storage quota. Many addresses together can still fill the relay.
- The identity key is a stored secret: encrypted in the database, but readable by anyone who can
  read the whole data folder.
- The per-friend daily message cap is kept in memory and resets on restart.
- Revocation (unfriend, list off, unshare) relies on the friend running unmodified Aurora. A
  modified client can keep copies.
- `SR_SOCIAL_ALLOW_PRIVATE_RELAY=1` lets friends name relay addresses on your private network.
- A friend request whose handle matches an existing friend is still shown; the fingerprint is
  what tells them apart.
- Shared collections are not filtered by source tier: a post you add to a shared collection
  goes to its recipients, whatever its source.

## Reporting a vulnerability

Please report privately: use the repository's private vulnerability reporting ("Report a
vulnerability" on the Security tab), or contact the maintainer directly. Do not open a public
issue with exploit details. Include the version (commit), what an attacker controls, and the
steps to reproduce. We aim to acknowledge reports within a few days.

When testing, use your own data and accounts. Do not test against other people's Aurora
servers or against the platforms Aurora connects to.
