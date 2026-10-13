#!/usr/bin/env bash
# Aurora installer for a Linux machine (no Docker).
#
#   ./scripts/install.sh            run from a checkout of the repository
#
# What it does, in order:
#   1. Checks for Node 26+, uv, Chromium and bubblewrap. For system packages it prints the
#      exact command and only runs it (with sudo) if you type "y". It never runs sudo silently.
#   2. npm ci and npm run build.
#   3. Optionally installs a systemd user service that serves the app on 127.0.0.1.
#
# Options:
#   --port N        port for the service (default 4317)
#   --data DIR      data directory (default: <repo>/data)
#   --service       install the systemd user service without asking
#   --no-service    skip the systemd user service
#   -h, --help      show this help
#
# Nothing here needs root except installing system packages, which you approve one by one.

set -euo pipefail

PORT=4317
DATA_DIR=""
SERVICE="ask"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --data) DATA_DIR="$2"; shift 2 ;;
    --service) SERVICE="yes"; shift ;;
    --no-service) SERVICE="no"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$REPO/data}"
cd "$REPO"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
miss() { printf '  \033[33mmissing\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask a yes/no question. Without a terminal the answer is always "no".
ask() {
  local reply
  if [ ! -t 0 ]; then return 1; fi
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

[ -f package.json ] && grep -q '"name": "social-reader"' package.json || {
  echo "Run this from a Aurora checkout (scripts/install.sh inside the repository)." >&2
  exit 1
}

# ---- Detect the package manager --------------------------------------------------------
PM=""
if have pacman; then PM=pacman
elif have apt-get; then PM=apt
elif have dnf; then PM=dnf
elif have zypper; then PM=zypper
fi

pkg_cmd() { # prints the install command for the given generic package names
  local pkgs=() p
  for p in "$@"; do
    case "$PM:$p" in
      pacman:chromium) pkgs+=(chromium) ;;
      apt:chromium)    pkgs+=(chromium) ;;  # Ubuntu ships it as a snap: "chromium-browser"
      dnf:chromium)    pkgs+=(chromium) ;;
      zypper:chromium) pkgs+=(chromium) ;;
      *:bwrap)         pkgs+=(bubblewrap) ;;
      pacman:python3)  pkgs+=(python) ;;
      *:python3)       pkgs+=(python3) ;;
      *:yt-dlp)        pkgs+=(yt-dlp) ;;
    esac
  done
  case "$PM" in
    pacman) echo "sudo pacman -S --needed ${pkgs[*]}" ;;
    apt)    echo "sudo apt-get install -y ${pkgs[*]}" ;;
    dnf)    echo "sudo dnf install -y ${pkgs[*]}" ;;
    zypper) echo "sudo zypper install -y ${pkgs[*]}" ;;
    *)      echo "" ;;
  esac
}

# ---- 1. Check dependencies -------------------------------------------------------------
bold "Checking what this machine has"

NODE_OK=0
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 26 ]; then ok "node $(node --version)"; NODE_OK=1
  else miss "node 26 or newer (found $(node --version))"; fi
else
  miss "node 26 or newer"
fi
have npm && ok "npm $(npm --version)" || miss "npm"

UV_OK=0
if have uv; then ok "$(uv --version)"; UV_OK=1; else miss "uv (runs Python actors)"; fi

CHROMIUM=""
for c in chromium chromium-browser google-chrome-stable google-chrome; do
  if have "$c"; then CHROMIUM="$(command -v "$c")"; break; fi
done
[ -n "$CHROMIUM" ] && ok "chromium ($CHROMIUM)" || miss "chromium (renders pages for browser-tier sources)"

have bwrap && ok "bubblewrap $(bwrap --version 2>/dev/null | awk '{print $2}')" || miss "bubblewrap (sandbox for AI-built actors)"
have python3 && ok "$(python3 --version)" || miss "python3 (Python actors)"
have yt-dlp && ok "yt-dlp $(yt-dlp --version 2>/dev/null)" || miss "yt-dlp (optional, for video sources)"
echo

if [ "$NODE_OK" -ne 1 ]; then
  bold "Node 26 or newer is required."
  cat <<'EOF'
  Install it with your usual tool, then run this script again. For example:
    Arch / Omarchy:  sudo pacman -S nodejs npm     (or: mise use -g node@26)
    Any distro:      mise use -g node@26           (https://mise.jdx.dev)
                     fnm install 26 && fnm use 26  (https://github.com/Schniz/fnm)
    Debian/Ubuntu:   NodeSource packages, https://github.com/nodesource/distributions
EOF
  exit 1
fi

if [ "$UV_OK" -ne 1 ]; then
  echo "uv installs into your home directory (no sudo) with:"
  echo "    curl -LsSf https://astral.sh/uv/install.sh | sh"
  if ask "Run that now?"; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    have uv && ok "$(uv --version)"
  else
    echo "  Skipped. Python actors will not run until uv is installed."
  fi
  echo
fi

NEED=()
[ -z "$CHROMIUM" ] && NEED+=(chromium)
have bwrap || NEED+=(bwrap)
have python3 || NEED+=(python3)
have yt-dlp || NEED+=(yt-dlp)
if [ "${#NEED[@]}" -gt 0 ]; then
  CMD="$(pkg_cmd "${NEED[@]}")"
  if [ -n "$CMD" ]; then
    bold "System packages to install (needs sudo):"
    echo "    $CMD"
    if ask "Run this command now? It will ask for your password."; then
      eval "$CMD" || echo "  The package install failed; you can run it yourself later."
    else
      echo "  Skipped. Run it yourself whenever you like; the app works without them, with fewer source types."
    fi
  else
    bold "Install these with your package manager: ${NEED[*]}"
  fi
  echo
fi

# Does unprivileged bubblewrap work here? (Ubuntu 24.04+ restricts user namespaces.)
if have bwrap; then
  if bwrap --unshare-all --die-with-parent --ro-bind / / -- /usr/bin/true 2>/dev/null; then
    ok "bubblewrap sandbox works for this user"
  else
    echo "  Note: bubblewrap is installed but cannot create a sandbox for this user."
    echo "  Actors will run unsandboxed (labelled 'isolation: none'). On Ubuntu 24.04+ this is"
    echo "  the AppArmor user-namespace restriction; see docs/self-hosting.md."
  fi
  echo
fi

# ---- 2. Install and build --------------------------------------------------------------
bold "Installing JavaScript dependencies (npm ci)"
npm ci --no-audit --no-fund
bold "Building the web app"
npm run build
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
echo

# ---- 3. Optional systemd user service --------------------------------------------------
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/social-reader.service"
if [ "$SERVICE" = "ask" ]; then
  if have systemctl && ask "Install a systemd user service so it starts with your login (bound to 127.0.0.1:$PORT)?"; then
    SERVICE=yes
  else
    SERVICE=no
  fi
fi

if [ "$SERVICE" = "yes" ]; then
  NODE_BIN="$(command -v node)"
  EXTRA_PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=Aurora (local)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/server/main.ts
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=SOCIAL_READER_DATA=$DATA_DIR
Environment=PATH=$EXTRA_PATH
${CHROMIUM:+Environment=CHROMIUM_PATH=$CHROMIUM}
# Optional: put ANTHROPIC_API_KEY=... or OPENAI_API_KEY=... in this file (mode 600).
EnvironmentFile=-%h/.config/social-reader/env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now social-reader.service
  ok "service installed: $UNIT"
  echo "  Logs:    journalctl --user -u social-reader -f"
  echo "  Restart: systemctl --user restart social-reader"
  echo "  To keep it running after you log out: loginctl enable-linger $USER"
  echo
fi

bold "Done."
if [ "$SERVICE" = "yes" ]; then
  echo "Open http://127.0.0.1:$PORT"
else
  echo "Start it with:  PORT=$PORT SOCIAL_READER_DATA=$DATA_DIR npm start"
  echo "Then open http://127.0.0.1:$PORT"
fi
echo "Data lives in $DATA_DIR. Self-hosting guide: docs/self-hosting.md"
