# Self-hosting Aurora

Aurora runs on your own computer or server. Your library, the connectors the AI builds
for you, and any signed-in browser sessions stay on that machine. There are two ways to run it:
a Docker container, or straight on Linux with an install script. Both serve the app on
`127.0.0.1` only, so nothing is reachable from your network until you decide otherwise.

## Option 1: Docker (or Podman)

You need Docker with the compose plugin, or Podman with `podman compose`.

```bash
git clone <this repository> social-reader
cd social-reader
cp .env.example .env        # optional; every setting has a default
docker compose up -d --build
```

Open <http://127.0.0.1:4317>.

On a Mac this is the way to get AI-built connectors: Docker Desktop (or OrbStack, or Colima) runs
the image in a small Linux VM, and bubblewrap works inside it. Running Aurora straight on macOS is
fine for everything else; see [macos.md](macos.md).

With Podman, `podman compose up -d --build` works the same way (if it hands off to
docker-compose, enable the Podman socket first: `systemctl --user enable --now podman.socket`) (see the note on Podman under
the sandbox section). Build with `--format docker` if you want the image's health check, which
Podman's default OCI format drops.

The image contains Node 26, Python 3 with uv, Chromium (for sources that need a real browser),
bubblewrap (the sandbox for AI-built connectors) and yt-dlp. The first build takes a few minutes
and the image is about 1.5 GB, mostly Chromium.

Useful commands:

```bash
docker compose logs -f              # watch the server log
docker compose restart              # restart
docker compose down                 # stop (your data stays in the volume)
```

### Settings

Put these in `.env` next to `docker-compose.yml`:

| Setting | Default | What it does |
|---|---|---|
| `SR_PORT` | `4317` | Port on the host. It is always bound to `127.0.0.1`. |
| `SR_EXTRA_HOSTS` | empty | Extra host names the app answers to, comma separated. See "Remote access". |
| `AUTO_SYNC_MINUTES` | `30` | How often free feeds sync in the background. `0` turns it off. |
| `ANTHROPIC_API_KEY` | empty | Claude API key, if you prefer the environment over the in-app setting. |
| `OPENAI_API_KEY` | empty | Key for an OpenAI-compatible endpoint, if it needs one. |
| `SR_ACTOR_ISOLATION` | `auto` | `auto` uses the bubblewrap sandbox when it works, `none` skips it. On macOS and Windows, where there is no sandbox, AI-built connectors refuse to run unless this is `none`. |

The server refuses requests whose `Host` header it does not recognise. This protects against
DNS-rebinding attacks from web pages you visit. Compose already allows `127.0.0.1:<SR_PORT>` and
`localhost:<SR_PORT>`; anything else goes in `SR_EXTRA_HOSTS`. Outside Docker the same setting is
called `SR_ALLOWED_HOSTS`.

### How the connector sandbox works in Docker

Connectors (the server calls them actors) are small scripts that the AI writes. They run in a
bubblewrap sandbox: no network except through the app's egress proxy, which only lets through
the hosts the connector declared, and no access to your data folder.

Bubblewrap needs to create user namespaces and mount its own `/proc`. Docker's default seccomp
profile and its masked `/proc` paths forbid both, so `docker-compose.yml` sets
`seccomp=unconfined` and `systempaths=unconfined` for this container. The container still runs as
an ordinary user (uid 1000) with every Linux capability dropped and `no-new-privileges` set.

This is a tradeoff, and the compose file makes the choice that protects your data best:

- **With those two options (the default):** connectors run in the real sandbox. A connector that
  misbehaves cannot read your library, your AI key or your browser sessions, and cannot reach
  any host it did not declare. The cost is that the container itself has a wider set of kernel
  system calls available than a default Docker container.
- **Without them:** the container keeps Docker's defaults, and bubblewrap cannot start. Social
  Reader then runs connectors as plain child processes and labels each run `isolation: none` in
  the Workshop. Those processes run as the same user as the server, so they could read
  `/data` (including stored keys) and open network connections directly. The proxy allowlist
  only applies to well-behaved HTTP clients in that mode. (We tested this: an unsandboxed test
  connector could list `/data` and open a raw socket; the sandboxed one could do neither.)

On hosts with AppArmor (Ubuntu, Debian with AppArmor enabled), also add `apparmor=unconfined` to
`security_opt`. Podman does not understand `systempaths=unconfined`; replace that line with
`unmask=ALL`.

To keep the container defaults instead, delete the `seccomp` and `systempaths` lines and also set
`SR_ACTOR_ISOLATION=none`. The second step matters: in some setups (Podman's defaults, for one)
the quick sandbox check passes but real connector runs then fail, so tell the app up front not
to use the sandbox. Check the Workshop after the first connector run: each run shows which
isolation it used.

Chromium inside the container runs headless and without its own sandbox (Playwright's default),
as is usual in containers. The pages it loads are limited to the connector's declared hosts by
the same egress rules.

## Option 2: Straight on Linux

On Arch Linux or Omarchy, `packaging/arch/PKGBUILD` builds a native package with a systemd user
unit and data in `~/.local/share/aurora`; see [omarchy.md](omarchy.md#install-on-arch--omarchy).
On other distributions:

```bash
git clone <this repository> social-reader
cd social-reader
./scripts/install.sh
```

The script checks for Node 26 or newer, uv, Chromium, bubblewrap, Python 3 and yt-dlp. It does
not run anything as root on its own: for system packages it prints the exact command (for
example `sudo pacman -S --needed chromium bubblewrap`) and runs it only if you answer `y`. uv
installs into your home directory, again only if you agree. Then it runs `npm ci` and
`npm run build`, and offers to install a systemd user service.

The service listens on `127.0.0.1:4317` and starts when you log in. Commands:

```bash
systemctl --user status social-reader
journalctl --user -u social-reader -f
systemctl --user restart social-reader
loginctl enable-linger $USER     # keep it running after you log out (servers)
```

Options: `--port 4400`, `--data /path/to/data`, `--service` or `--no-service`.

If you would rather not use the script, the manual steps are in the README: `npm ci`,
`npm run build`, `npm start`.

On Ubuntu 24.04 and newer, AppArmor blocks unprivileged user namespaces by default, so
bubblewrap cannot start and connectors run with `isolation: none`. The script tells you if this
happens. One fix is an AppArmor profile that allows `userns` for `/usr/bin/bwrap`; Ubuntu's
documentation on "unprivileged user namespace restrictions" describes it.

## Choosing an AI provider

The AI adds sources, builds connectors and answers questions about your feed. You set it up in
the app under AI settings. Keys are stored on the server, in the library database, and are never
sent to the browser.

- **Claude with an API key.** Paste an Anthropic API key in AI settings, or set
  `ANTHROPIC_API_KEY`. This works the same in Docker and on bare metal.
- **Claude with your Claude Code login.** On bare metal, if you are signed in to Claude Code on
  that machine, Aurora uses that login and you do not need a key. Inside Docker there is
  no Claude Code login, so use an API key or a local model there.
- **A local model, or any OpenAI-compatible service.** Choose "Local or any OpenAI-compatible" in
  AI settings and enter the endpoint URL:
  - Ollama on the same machine, bare metal: `http://127.0.0.1:11434/v1`
  - Ollama on the host, app in Docker: `http://host.docker.internal:11434/v1`. Ollama listens
    only on `127.0.0.1` by default, which the container cannot reach; start it with
    `OLLAMA_HOST=0.0.0.0` and make sure your firewall keeps port 11434 off the network, or use
    the optional Ollama service instead.
  - The optional Ollama service in `docker-compose.yml` (uncomment it): `http://ollama:11434/v1`
  - LM Studio, OpenRouter, OpenAI and others: their OpenAI-compatible base URL, plus a key.

  Pick a model that supports tool calling. Building connectors is the hardest job the AI does;
  small local models can chat about your feed but often struggle to write and repair connectors.

## Where your data lives

Everything is in one folder:

- Docker: the `social-reader-data` volume, mounted at `/data`. To use a plain folder instead,
  switch the volume line in `docker-compose.yml` to `./data:/data` and make that folder writable
  by uid 1000.
- Bare metal: `./data` in the checkout, or whatever you passed with `--data` (the
  `SOCIAL_READER_DATA` setting).

Inside it:

| Path | Contents |
|---|---|
| `social-reader.db` (plus `-wal` and `-shm`) | The library: posts, sources, views, pages, settings, stored keys and tokens |
| `actors/` | Connectors the AI built, with their earlier versions |
| `browser-profiles/` | The app's own browser profiles for signed-in sources (never your normal browser's) |
| `agent/` | Working files for AI conversations |
| `cache/` | Package caches for connectors; safe to delete |

Treat the folder as private. It holds your API keys and any sessions you signed in to.

## Backups

The simplest safe backup is to stop the app and copy the folder:

```bash
# Docker
docker compose stop
docker run --rm -v social-reader_social-reader-data:/data -v "$PWD":/backup \
  docker.io/library/debian:trixie-slim tar czf /backup/social-reader-backup.tgz -C /data .
docker compose start

# Bare metal
systemctl --user stop social-reader
tar czf social-reader-backup.tgz -C data .
systemctl --user start social-reader
```

The volume name is prefixed with the compose project name, which is the folder name by
default; `docker volume ls` shows it. If you want a backup without stopping the app, use
SQLite's online backup, which is consistent even while the app writes:

```bash
sqlite3 data/social-reader.db ".backup 'social-reader-snapshot.db'"
```

and copy `actors/` and `browser-profiles/` alongside it. The app can also export your library as
JSON and your feed list as OPML from the Sources screen, which is handy for moving to another
reader, but those exports do not include connectors, settings or keys.

Backups contain your keys and sessions, so store them somewhere private.

## Updating

```bash
# Docker
git pull
docker compose up -d --build

# Bare metal
git pull
./scripts/install.sh --no-service     # reinstalls dependencies and rebuilds the web app
systemctl --user restart social-reader
```

The database upgrades itself on start. Take a backup before a big update.

## Reaching it from your phone or another computer

The app has no login of its own. It assumes that whoever can reach it is you. So never publish
the port on your network or the internet directly, and never change the compose port line to
`0.0.0.0`, unless something in front of it checks who you are.

Two safe ways:

- **Tailscale (easiest).** Install Tailscale on the server and your phone, then run
  `tailscale serve --bg 4317` on the server. Your devices reach it at
  `https://<machine>.<tailnet>.ts.net`, and only devices signed in to your tailnet can connect.
  Add that name to `SR_EXTRA_HOSTS` (Docker) or `SR_ALLOWED_HOSTS` (bare metal), for example
  `SR_EXTRA_HOSTS=reader.tail1234.ts.net`, and restart. Do not use Tailscale Funnel, which makes
  it public.
- **A reverse proxy with authentication.** Caddy, Traefik or nginx in front of the app with real
  authentication (an identity provider such as Authelia, Authentik or Pomerium, or at minimum
  HTTP basic auth over HTTPS). Proxy to `127.0.0.1:4317`, keep the `Host` header, and add your
  public host name to the allowed hosts setting.

Adding a host name only tells the app to answer to that name; it does not add any protection.
The authentication has to come from Tailscale or your proxy.

## Cloud hosting (planned)

A hosted version is planned for people who do not want to run a server. It does not exist yet.
The intended design keeps the same rules as the self-hosted app, with one firm difference: the
cloud never holds your Meta (Instagram, Facebook, Threads) or X sessions. Sources that need you
to be signed in would run only on a device you control, such as your own computer or a small
self-hosted helper, and send posts up from there. Public sources and feeds could sync in the
cloud. Until that exists, self-hosting is the only way to run Aurora.
