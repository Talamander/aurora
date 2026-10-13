# Aurora on your phone

`mobile/` is the Aurora phone app: Expo (React Native, TypeScript), Android first, iOS from the
same code. It has no server or account of its own. It talks to the Aurora server on your
computer over the same JSON API and event stream the web app uses, and it filters with the same
engine (`core/filter.ts`), so a view shows the same posts on both.

What it does: the feed with your views as chips (Worth reading, Saved, Everything and your saved
views), save and set aside with an Undo receipt, Ask about your feed (the agent, streamed live,
with cited posts), the morning edition with Listen (the phone's own speech engine), your pages,
a person's posts, sources with per-source sync, and phone settings (theme, haptics, reduced
motion, video sound). Video files and HLS streams play inline; YouTube opens in its app.
Search finds any post on your computer, a post shows More like this, the last library and your
Read later articles stay readable offline, and a link shared to Aurora from another app fills
in "Follow this: <link>" for the agent. Today opens with On this day when you saved or
highlighted something on this date before, Read later can be listened to back to back, the
Agent tab lists your routines with what they did last, Sources has report cards, and the profile
switcher shows each profile's hours.

Screenshots of the web build at phone size: `design/mobile/shots/app/`.

## 1. Let the phone reach your computer

Aurora is bound to `127.0.0.1` by default, so nothing on your network can reach it, phones
included. Phone access is something you turn on:

```bash
HOST=0.0.0.0 ALLOW_NON_LOCAL=1 npm start
```

With `HOST` set to a non-loopback address:

- Requests that carry a valid device token are accepted from other machines, and only for the
  routes a phone needs (listed below).
- Everything else, including the web app and the full API, still answers only to this computer.
  A request from another machine without a token gets HTTP 421 or 403, even if it forges the
  `Host` header.
- The pairing endpoints accept a claim from the network, but a claim does nothing until you
  approve it on the computer.

`SR_TRUST_NETWORK=1` lifts the "this computer only" rule for the web app. The Docker image sets
it because the container's port mapping is the boundary there; do not set it on a laptop.

### Away from home

The phone and the computer talk plain HTTP on your network. That is fine on a home network you
trust, but anyone on the same Wi-Fi can read the traffic. On any other network, use one of these:

- **Tailscale** (recommended): install it on both, then start Aurora with
  `SR_PUBLIC_URL=http://<computer>.<tailnet>.ts.net:4317`. Traffic is encrypted end to end and
  never touches the public internet.
- **An HTTPS reverse proxy** you run (Caddy, nginx) in front of Aurora: set
  `SR_PUBLIC_URL=https://reader.example.com` and `SR_ALLOWED_HOSTS=reader.example.com`.

`SR_PUBLIC_URL` takes several addresses, comma separated. They appear first in the pairing
dialog's address list; the computer's private network addresses follow.

### Android emulator

The emulator reaches the computer at `10.0.2.2`. Pair with `http://10.0.2.2:4317` (Aurora can
stay on `127.0.0.1` for this, because emulator traffic arrives from loopback).

## 2. Pair

1. On the computer, open Aurora, then Settings, AI, Phones, and choose **Pair a phone**.
2. On the phone, open Aurora and scan the QR code (or type the address and the code shown
   under it). Scanning with the system camera also works: the code is an `aurora://pair` link.
3. Both screens show the same four digits. If they match, choose **Approve** on the computer.

The pairing code lasts 5 minutes and works once. The token is handed to the phone exactly once
and stored in the Android Keystore or the iOS Keychain (expo-secure-store, this device only).
The server keeps only a SHA-256 hash of it, in the `secrets` table.

### What a phone may do

The token is sent as `Authorization: Bearer aur_…` and allows only:

- read the library (the whole of it, or the manifest and its chunks), the event stream, the AI
  status, pages and archived media;
- search the library and ask for related posts (More like this);
- save, set aside, mark read;
- talk to the agent (new conversation, send, stop), write the morning edition, catch up,
  person summaries, sync sources;
- accept or dismiss taste suggestions;
- see and revoke its own pairing;
- read the list of routines (`GET /api/routines`), with each one's schedule and last run.

Everything else (adding or removing sources, AI keys and settings, imports, exports, other
devices) answers `403 Phones cannot do this. Use Aurora on your computer.` The agent you talk
to from the phone is the same agent as on the computer, so it can still change things you ask
it to change, and every change shows up in its undo log.

### Unpair

From the phone: Settings, **Unpair this phone**. From the computer: Settings, AI, Phones,
**Unpair**. Either side revokes the token at once; the phone returns to the pairing screen on
its next request, and deletes everything it kept for offline reading.

## Fast sync and offline

The phone syncs the library the way the web app does (`mobile/src/librarySync.ts`, wire format
in `server/libraryWire.ts`): it asks for `/api/library?items=chunks`, a manifest with
everything but the posts plus a list of week-sized chunks named by a hash of their contents, and
then fetches only the chunks it does not already hold from `/api/library/chunks/<key>?h=<hash>`.
The manifest is revalidated with `If-None-Match`, so a change event that changed nothing the
phone can see costs one empty `304`. Marking one post read on the computer costs one chunk.

Each chunk and the manifest are written to the app's private documents folder
(`mobile/src/cache.ts`, expo-file-system), one folder per pairing. On the next start the feed
shows from there at once, before the network answers. Opened articles and the unread articles in
Read later (up to 25 at a time, 60 kept in all) are saved the same way, and so is the last Read
later list. Pictures come from expo-image's own disk cache. The image proxy settings are kept in
the keychain next to the device token, so an offline start keeps the same proxy rules. Unpairing
deletes the folder and those settings.

When the computer cannot be reached, a quiet line at the top says **Offline, showing what you
had**, with when the library was saved and how many changes are waiting; tap it to try again.
The phone also looks again every 30 seconds and whenever it comes back to the foreground.
Save, set aside, mark read and Read later still work offline. The changes wait in a queue on the
phone (in order, kept across restarts) and are sent as soon as the computer answers. A change
the computer refuses (the post was deleted meanwhile, say) is dropped with a receipt rather than
retried forever. Search falls back to the saved posts (every word must match, newest first).
Reading positions and highlights made offline are not queued.

## Search and More like this

The search button in the feed header opens Search. The computer ranks the results
(`/api/search`, BM25 over every post, scoped to the phone's profile) and sends plain-text
snippets with the matched ranges; the phone lights the matches by splitting the text, so nothing
in a post is ever parsed as markup. Quotes make a phrase, a minus sign leaves a word out, and
`from:name` keeps one person. A post ends with **More like this** (`/api/items/<id>/related`):
up to five posts that share rare words, the author or topics with it, each with the reason.

## On this day, routines, report cards, Listen and profile hours

These follow the desktop features of the same names and keep the phone read-mostly.

- **On this day.** A card at the top of Today lists up to three posts you saved or highlighted
  on today's date a month or more ago (`core/onThisDay.ts`, the desktop's code, run on the
  phone). Saves come from the library; highlights and alert hits come from
  `/api/highlights` and `/api/alerts/hits` and the last answer is kept for offline use
  (`mobile/src/marks.ts`). **Hide for today** is remembered on the phone until midnight. No AI.
- **Routines.** The clock button on the Agent tab opens a list of routines: name, schedule in
  words, the profile it works in, on, off, paused (with the reason) or running, the next run,
  and the last run's summary with its cited posts, which open as usual. The list is kept for
  offline use and refreshes when the computer says a routine changed. Writing, planning, turning
  on and running routines stay on the computer, where the AI key and the spending caps live; the
  device allowlist has `GET /api/routines` only, and `tests/device-routes.test.ts` checks that
  every write and lookalike path is refused.
- **Report cards.** The chart button on the Sources tab. The phone computes the cards itself
  with `core/sourceReport.ts` from the saved library, scoped to the phone's profile, plus the
  highlight and alert ids above, so they work offline and need no new route. Each card has the
  verdict (Let go, Quieter, Keep, New), its sentence, a 30-day sparkline and the numbers;
  **Worth a look** narrows to Let go and Quieter. Pausing, muting and moving sources happen on
  the computer.
- **Listen to Read later.** **Listen to all** on Read later reads the unread articles one after
  another with the phone's speech engine (`expo-speech`, already in the app), with Stop and Next
  read. Each article comes from the copy saved on the phone, else from the computer, else the
  post's own text; one that cannot be loaded is skipped. Playback keeps going when you leave the
  screen. There are no lock-screen or headset controls: expo-speech has no media session, and
  adding one needs a native module the app does not ship yet.
- **Profile hours.** The profile switcher shows each profile's hours under its name ("Weekdays
  09:00–17:00", with "now" while they apply). Hours switch the computer only; the phone keeps
  its own choice.

## Share a link to Aurora (Android)

Sharing a link from another app's share sheet to Aurora opens the agent with
`Follow this: <link>` filled in. Nothing is sent until you press Send, and only the first
`http(s)` link in the shared text is used (shared text is untrusted).

How it works without a new native module: `app.json` adds an `ACTION_SEND` intent filter for
`text/plain`, and the local config plugin `mobile/plugins/withShareTarget.js` adds a few lines
to the generated `MainActivity` that turn the shared text (an intent extra React Native cannot
see) into an ordinary deep link, `aurora://follow?text=…`. Expo Router opens `app/follow.tsx`,
which hands the link to the agent box. The plugin runs at prebuild, so it is in APKs built with
`npx expo prebuild` or EAS, not in Expo Go. `aurora://follow?url=<link>` works on any build,
for example from a home-screen shortcut. iOS needs a Share Extension, which is a separate
native target (for example the `expo-share-intent` module); that is not added yet.

## 3. Run it in development

```bash
cd mobile
npm install
npx expo start          # then press a for Android, or scan with Expo Go
npm run typecheck
```

The web preview (`npx expo start --web`) is for development and screenshots only; it keeps the
token in the browser's localStorage, not a keystore.

## 4. Build an APK (Android)

You need the Android SDK (Android Studio, or the command line tools with `ANDROID_HOME` set) and
JDK 17. No account is needed for a local debug build.

```bash
cd mobile
npx expo prebuild --platform android     # writes android/ (ignored by git)
npx expo run:android                     # builds, installs on a device or emulator, runs
# or just the APK:
cd android && ./gradlew assembleDebug    # android/app/build/outputs/apk/debug/app-debug.apk
```

A release APK needs your own signing key (`./gradlew assembleRelease` with a keystore set up as
in the React Native signing guide). Cleartext HTTP is enabled in the Android build so the phone
can reach `http://` addresses on your network; use Tailscale or HTTPS away from home.

To check that the JavaScript bundle compiles without an SDK:

```bash
npm run export:android     # dist/android, Hermes bytecode
npm run export:web         # dist/web
```

## 5. iOS

The same code runs on iOS (floating tab bar, Ionicons, Keychain storage, a local-network
permission prompt). Building it needs one of:

- **A Mac with Xcode:** `cd mobile && npx expo run:ios` builds and runs it in the simulator or
  on a connected iPhone (a free Apple ID can sign a build for your own phone for 7 days).
- **EAS Build** (Expo's hosted builder): `npx eas build --platform ios`. This needs an Expo
  account and, for an installable build, an Apple Developer Program membership. Both are your
  decision; nothing in this repository signs up for either.

iOS is on the roadmap in PLAN.md (phase 9).
