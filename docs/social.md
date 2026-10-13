# Friends: social between Aurora users

Aurora is a private reader. Friends adds the one social thing a private reader is missing: passing something good to a person you know, with a note, and talking about it. It does not add an audience.

## Principles

1. **Private by default.** Nothing leaves your Aurora unless you share it, item by item, with people you picked. Reading, saving, rules and AI labels never leave.
2. **Friends only, mutual.** A friendship exists only when both sides agree. There are no public profiles, no directory, no search for people, no follower or like counts and no resharing.
3. **End-to-end encrypted.** Relays carry sealed, signed envelopes. They never see handles, notes, posts or who your friends are by name.
4. **Never write to source platforms.** Sharing with a friend is between two Aurora instances. Nothing is posted, liked, followed or bookmarked on X, Bluesky or any other site.
5. **Everything received is untrusted data.** A friend's note and the post they shared are plain text. They are size-capped and rendered as text, never as HTML. The AI reads them wrapped as untrusted content, exactly like any other post, and never takes instructions from them.
6. **Calm, not viral.** Shares arrive in time order in a Friends source. Nothing is ranked by engagement and nothing counts publicly.

## What people do together

| | Built | Later |
|---|---|---|
| Share a post or article with a note to friends or a circle | yes | |
| Friends' shares arrive as a "Friends" source, note on top, original quoted below | yes | |
| React with one of six emoji, reply in a small thread | yes | |
| Circles (your own groups, invisible to members) | yes | |
| Block and remove | yes | |
| Weekly list of saved posts, per friend, opt-in, previewed before the first send | yes | |
| Share a collection as a read-only copy that follows its changes; unshare deletes it | yes | Shared pages (a page's feed blocks resolved to posts) can use the same message. |
| Suggest a connector; the friend adds it as an untested import, by hand | yes | |
| Circles mapped to profiles | yes | Sharing from inside a profile offers that profile's circle first. |

Replies are private between the sharer and each recipient. If Maya shares with Jonah and Ana, Jonah's reply goes to Maya only, and Ana never sees it. Nobody's words reach a person they did not choose. Group threads can come later, as an explicit choice when sharing.

A post that came from a friend cannot be shared on. Their note stays between the two of you.

## From friends: weekly lists, collections and connectors

These ride the same envelopes as shares: signed, sealed to one recipient, padded, replay-checked and counted against the per-friend daily cap. They are accepted only from someone who is a friend right now. Everything received lands in the **From friends** tab of the Friends sheet, and a small "From your friends" card appears in the side pane when something new arrives. Entries are plain text (title up to 300 characters, an excerpt up to 600 for lists and 400 for collections, an http(s) link, author and platform), rendered as React text with no remote images. **Keep** saves one as an ordinary saved post from the Friends source, which, like any friend share, cannot be passed on.

### The weekly list ("what friends saved")

The sender's side, per friend, under **Weekly list** on that friend's row:

1. It is off for every friend. Turning it on sends nothing.
2. The panel shows exactly what the next list holds: posts saved since the last list (or the last 7 days), newest 25, optionally only from one profile's sources. Posts that came from friends and demo posts never go. Untick any post to leave it out of this list, or mark it **Never share** to keep it out of every list.
3. The first list is sent by hand. The server recomputes the candidates and sends only those the user saw and kept ticked (`POST /api/social/digest/:fp/send` with the item ids). One list per friend per week.
4. Only after that can the user tick **Send it weekly without asking**. The server refuses automatic sending (409) until one list was confirmed by hand. An empty week sends nothing.
5. **Turn off** sends `digest_off` and the friend's Aurora deletes every list from them. Turning it on again asks for a hand-sent list again.

The receiver can hide a friend's lists (deletes them and drops new ones; the friend is not told) and show them again. The last 8 lists per friend are kept.

### Shared collections

**Shared → Share a collection** sends a read-only copy of a collection to chosen friends or circles: up to 100 posts (newest first), trimmed further if the sealed message would pass the largest padding bucket, with a "showing the newest" note. Each copy has a version. When the collection's posts change, the next sync (at most once a minute) sends the new version; the receiver ignores any version not newer than the one it has, so a replayed or reordered message cannot roll a copy back. **Unshare**, for one friend or all, sends `coll_off` and their copy is deleted. Deleting the collection locally does the same. A friend can hold at most 30 collections from one sender.

### Suggesting a connector

**Shared → Suggest a connector** sends the connector bundle (the same `social-reader-actor` format as Export) to chosen friends with an optional note. It carries code, manifest and description, never logins, cookies or sources. Code over 180 KB, or a bundle that would not fit the sealed message, is refused with "export it as a file instead".

On receipt, the bundle is checked (format, version, id pattern, size) and stored. The card shows "maya suggests a connector for Instagram", the note, the description, the runtime, the line count and every host it may reach. Nothing is installed or run. **Add to Workshop** passes the bundle to the same importer as a file import (`importBundle` in `server/actorBundles.ts`): manifest validation, a renamed id on a clash instead of an overwrite, `createdBy: 'import'` and a note naming who suggested it. Like any imported file, it then has to pass a test run in the sandbox (Workshop → Test and add) before it can be used. At most 20 pending suggestions per friend.

### Message types

| Type | Payload | Receiver does |
|---|---|---|
| `digest` | `{week, entries[≤25]}` | Stores the list for that week (replaces a same-week list); refuses weeks more than 3 away; dropped if the sender is hidden |
| `digest_off` | `{}` | Deletes every list from the sender |
| `coll` | `{collId, name, version, entries[≤100], truncated}` | Stores or replaces the copy when `version` is newer |
| `coll_off` | `{collId}` | Deletes the copy |
| `connector` | `{recId, note, bundle}` | Stores a card; never installs |

Removing or blocking a friend deletes everything they sent through these messages and stops sharing collections and lists with them.

## Identity

- Each instance has two keys made with `node:crypto`: Ed25519 to sign and X25519 to receive. They are stored in the database's secrets table (`social.identity`), which the settings API never returns and nothing logs. The table is not encrypted at rest. It is protected by the database file mode (0600) and full-disk encryption.
- A **handle** is a human label, not a username. It is not unique and not discoverable. Friends can give you a local nickname.
- A **safety code** is SHA-256 over both public keys, shown as eight groups of four hex digits. Two people can compare it in person or over a call to rule out a swapped invite.

## Making friends (mutual acceptance)

1. Maya taps **Make an invite**. Aurora creates a single-use invite valid for 7 days, shown as a QR code and an `aurora:invite/v1/…` link. The invite holds Maya's handle, public keys, her relay address and a random 128-bit invite secret.
2. Maya gives it to Jonah privately: in person, a QR scan or a message app they already trust.
3. Jonah pastes it. Aurora shows Maya's handle, safety code and relay **before** anything is sent. Jonah taps **Send request**.
4. Jonah's Aurora seals a `hello` to Maya's keys and posts it to the invite mailbox on Maya's relay. The mailbox is derived from the invite secret, so only someone holding the invite can find it. The `hello` carries an HMAC proof over Jonah's own key fingerprint, so it cannot be replayed under another identity.
5. Maya sees **Requests: @jonah opened your invite**, with his safety code. She accepts or declines. Declining is silent.
6. On accept, Maya sends `welcome` over their pairwise mailbox. Both sides now show each other as friends. The invite is spent.

## Transport

```
Maya's Aurora ──seal──▶ Jonah's relay ◀──fetch── Jonah's Aurora
```

- **Relay.** A small store-and-forward server (`server/social/relay.ts`). It is built into every Aurora as opt-in `SR_RELAY=1`. It listens on its own port (`SR_RELAY_PORT`, default 4334), separate from Aurora's private API, so it can sit behind a public reverse proxy without exposing anything else. It also runs standalone: `node server/social/relay.ts`. A hosted Aurora can run one for people who cannot.
- **Your relay is your mailbox.** Each person names one relay. Friends post to it, and you fetch from it. If you run the relay on your own instance and your friends can reach it, delivery is direct: there is no third party at all.
- **Envelope.** `seal()` signs the body, then encrypts to the recipient: ephemeral X25519 ECDH, HKDF-SHA256, AES-256-GCM. The authenticated data binds the version, mailbox and ephemeral key. The signature covers the recipient's fingerprint, so a friend cannot forward a message you signed for them to someone else as if it were addressed to that person.
- **Metadata minimisation.**
  - Mailbox ids are derived per friend pair and per direction from a static X25519 secret. They rotate every week, so the relay cannot link a week's mailbox to the next.
  - Posting needs only the mailbox id. Fetching and deleting need its preimage (the fetch token), which only the two friends can compute.
  - Plaintext is padded to 1, 4, 16, 64 or 256 KB buckets.
  - The relay stores no handles, no accounts and no plaintext.
  - Known limit: one instance fetches several mailboxes per request, so the relay can see that those mailboxes belong to the same fetcher, and it sees IP addresses. Use Tor or a VPN in front of the relay if that matters to you.
- **Delivery.** The outbox retries with backoff for up to 10 days. Instances poll every 15 seconds (`SOCIAL_POLL_SECONDS`) and also poll as soon as something is sent.
- **Relay addresses are untrusted.** They arrive inside invites. Public relays are reached through `safeFetch` (no private addresses, timeouts, size caps). A private or loopback relay is allowed only when it is this instance's own relay or when `SR_SOCIAL_ALLOW_PRIVATE_RELAY=1` is set (LAN or local testing).

## Threat model

| Threat | Answer |
|---|---|
| **Malicious friend** sends abuse, huge or many messages | Block is instant and silent: their shares and replies are deleted locally and their mailboxes are never fetched again. Per-friend cap of 500 accepted messages a day. Notes are capped at 2,000 characters, shared text at 6,000, links at 10. No remote images are loaded from friend shares, so a friend cannot plant tracking pixels. |
| **Friend content as prompt injection** | Received text becomes an ordinary post. The agent wraps every post as `<untrusted>` data and never follows instructions inside it. |
| **Friend content as HTML or script** | Stored as plain text with control and bidi-override characters stripped. React renders it as text. URLs must be http or https. |
| **Malicious relay** reads, changes or forges | It sees only ciphertext. Changes fail AES-GCM authentication. Forgery fails the Ed25519 signature and the sender check: a message must be signed by the friend whose mailbox it arrived in. A relay can drop or delay messages; it cannot read or fake them. |
| **Replay** | Every body has a random id and a timestamp. Timestamps outside [now − 14 days, now + 5 minutes] are refused, and every accepted id is remembered for 15 days. |
| **Spoofing** | Identity is a key, not a handle. Invites show the safety code before sending, and the request shows it again before accepting. |
| **Spam to the relay** | Mailbox ids are unguessable. Without a valid invite proof or a friend signature, a message is dropped unread. The relay caps envelope size (360 KB), messages and bytes per mailbox, total storage and per-IP request rates, and expires everything after 14 days. POSTs must be JSON, so web pages cannot post to a relay from a browser. |
| **Stolen invite link** | Single use and 7-day expiry. The inviter still has to accept, and sees the requester's safety code first. Revoke unused invites at any time. |
| **Device theft** | Same exposure as the rest of the Aurora data directory, which is mode 0700 with the database at 0600. Full-disk encryption is the real answer. |

## Key loss, recovery and more devices

- **Backup.** The identity lives in the Aurora database, so a copy of the database (for example `VACUUM INTO`) carries it. Restoring that copy restores your friends. Treat the copy like a password.
- **Lost keys.** There is no server to recover from, by design. Make a new identity and send friends new invites. Their Aurora shows a new safety code, so they can tell a real reset from an impostor by checking with you.
- **More devices.** In the MVP, one identity lives on one instance. Phones and laptops read through that instance (the Android, iOS and desktop apps are designed to connect to it), so every device shares one friend list. Later, linked devices can each get their own key, cross-signed by the main identity, with messages sealed to every device key.

## Profiles and circles

A circle is a named group of friends, for example Family or Book club. Members never see which circles they are in. Each circle can be mapped to a profile (Friends → Circles → "Shares from this circle show in"):

- A profile with at least one mapped circle shows friends' shares from those circles' members only, whether or not the Friends source is in the profile. Friends in no mapped circle stay out of it.
- A profile with no mapped circle treats the Friends source like any other source.
- The "All" profile shows everything.

The routing (`friendRouting` in the library, profile id to fingerprint prefixes) is applied by `makeLens` in `core/profiles.ts`, so the app, the feeds and the MCP server agree. Kept posts from weekly lists and collections follow the same routing.

## Deliberately not built

- Public timelines, profiles or directories
- Like counts, follower counts, view counts or streaks
- Discovery, suggestions or friend-of-friend
- Ranking by engagement, or anything ad-shaped
- Resharing a friend's share
- Read receipts and typing indicators

## Where it lives

- `server/social/crypto.ts`: keys, envelope seal and open, padding, mailboxes and the replay check
- `server/social/relay.ts`: the relay
- `server/social/index.ts`: friends, invites, circles, outbox, polling, the Friends source and the routes under `/api/social`
- `server/social/extras.ts`: weekly lists, shared collections, connector suggestions and the From friends inbox
- `web/src/Friends.tsx`: the Friends sheet (People, From friends, Shared, Circles), the Share popover on posts, reactions and replies under a friend's share, and the side-pane card
- `tests/social-crypto.test.ts`: tamper, replay, wrong key, forwarding, forged sender, timestamp window and mailbox derivation
- `tests/social-v2.test.ts`: the weekly list's consent rules, collection versions and revocation, connector import, hostile entries, size caps and circle routing, between two stores over real envelopes

## Try it locally

Run two Aurora instances, each with its own relay:

```sh
PORT=4332 SR_RELAY=1 SR_RELAY_PORT=4334 SR_SOCIAL_ALLOW_PRIVATE_RELAY=1 SOCIAL_READER_DATA=/tmp/aurora-a node server/main.ts
PORT=4333 SR_RELAY=1 SR_RELAY_PORT=4335 SR_SOCIAL_ALLOW_PRIVATE_RELAY=1 SOCIAL_READER_DATA=/tmp/aurora-b node server/main.ts
```

Open both instances. On each one, go to **Friends** and turn it on. Then make an invite on one instance and paste it on the other.
