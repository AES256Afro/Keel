#!/usr/bin/env bash
# Keel installer - macOS, Debian/Ubuntu, Arch, Fedora/RHEL, and any Linux with Node 20+.
#
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/install.sh | bash
#   ./install.sh --dir ~/keel --port 3000 --service
#
# What it does:
#   1. Checks for Node 20+ and offers to install it with the system package manager.
#   2. Clones (or updates) the repository into the target directory.
#   3. Writes a .env with a generated backup passphrase and the instance owner.
#   4. Installs dependencies and creates the database.
#   5. Optionally installs a service so Keel starts on boot.
#
# It never runs anything as root except the package-manager step, and it tells
# you before it does. Re-running it is safe - an existing install is updated,
# and an existing .env is never overwritten.
set -euo pipefail

REPO="${KEEL_REPO:-https://github.com/AES256Afro/Keel}"
BRANCH="${KEEL_BRANCH:-main}"
DIR="${KEEL_DIR:-$HOME/keel}"
PORT="${KEEL_PORT:-3000}"
INSTALL_SERVICE=0
OWNER_EMAIL="${KEEL_OWNER_EMAIL:-}"
ASSUME_YES=0

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "${BOLD}==>${OFF} $*"; }
ok()   { printf '%s\n' "  ${GREEN}✓${OFF} $*"; }
warn() { printf '%s\n' "  ${YELLOW}!${OFF} $*"; }
die()  { printf '%s\n' "  ${RED}✗${OFF} $*" >&2; exit 1; }

usage() {
  cat <<EOF
${BOLD}Keel installer${OFF}

  --dir PATH        where to install            (default: $HOME/keel)
  --port N          port to serve on            (default: 3000)
  --owner EMAIL     instance owner's email      (asked for if omitted)
  --branch NAME     git branch                  (default: main)
  --service         install a boot service (systemd user unit / launchd)
  --yes             don't prompt
  --help            this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    --owner)   OWNER_EMAIL="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --service) INSTALL_SERVICE=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s [y/N] ' "  $1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- platform ---
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) die "unsupported platform: $OS. Windows users: run install.ps1 in PowerShell." ;;
esac

PKG=""
if [ "$PLATFORM" = "macos" ]; then
  command -v brew >/dev/null 2>&1 && PKG="brew"
else
  for candidate in apt-get dnf pacman zypper apk; do
    if command -v "$candidate" >/dev/null 2>&1; then PKG="$candidate"; break; fi
  done
fi

say "Keel installer"
printf '%s\n' "  ${DIM}platform: $PLATFORM${PKG:+ · package manager: $PKG}${OFF}"
printf '%s\n' "  ${DIM}target:   $DIR (port $PORT)${OFF}"
echo

# -------------------------------------------------------------------- node ---
node_major() { node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

install_node() {
  local sudo_cmd=""
  [ "$(id -u)" != "0" ] && sudo_cmd="sudo"
  case "$PKG" in
    brew)    brew install node ;;
    apt-get)
      # Debian/Ubuntu ship old Node; use NodeSource for a current LTS.
      curl -fsSL https://deb.nodesource.com/setup_22.x | $sudo_cmd -E bash -
      $sudo_cmd apt-get install -y nodejs
      ;;
    dnf)     $sudo_cmd dnf install -y nodejs npm ;;
    pacman)  $sudo_cmd pacman -S --noconfirm nodejs npm ;;
    zypper)  $sudo_cmd zypper install -y nodejs npm ;;
    apk)     $sudo_cmd apk add --no-cache nodejs npm ;;
    *) die "no supported package manager found - install Node.js 20+ from https://nodejs.org and re-run" ;;
  esac
}

say "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  if confirm "Install Node.js 22 with $PKG (needs sudo)?"; then
    install_node
  else
    die "Node.js 20 or newer is required."
  fi
elif [ "$(node_major)" -lt 20 ]; then
  warn "Node.js $(node --version) is too old - Keel needs 20 or newer."
  if confirm "Upgrade Node.js with $PKG (needs sudo)?"; then
    install_node
  else
    die "Node.js 20 or newer is required."
  fi
fi
ok "Node.js $(node --version)"

command -v git >/dev/null 2>&1 || die "git is required - install it and re-run."
ok "git $(git --version | awk '{print $3}')"

# ------------------------------------------------------------------- fetch ---
say "Fetching Keel"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH" 2>/dev/null || git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
  ok "updated $DIR"
else
  [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && die "$DIR exists and is not empty."
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
  ok "cloned into $DIR"
fi
cd "$DIR"

# --------------------------------------------------------------------- env ---
say "Configuring"
DATA_DIR="${KEEL_DATA_DIR:-$DIR/data}"
mkdir -p "$DATA_DIR" "$DIR/backups"

if [ -f .env ]; then
  ok ".env already exists - leaving it alone"
else
  if [ -z "$OWNER_EMAIL" ] && [ "$ASSUME_YES" != "1" ]; then
    printf '%s' "  Your email (becomes the instance owner): "
    read -r OWNER_EMAIL </dev/tty || true
  fi
  # A generated passphrase means encrypted backups work out of the box instead
  # of failing the first time the scheduler runs.
  PASSPHRASE="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  cat > .env <<EOF
# Generated by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ')

DATABASE_URL="file:$DATA_DIR/keel.db"
PORT=$PORT

# Who runs this instance. Gates the admin portal, the sign-in allowlist and the
# tunnel - this is NOT the same as owning a workspace (every account owns one).
KEEL_OWNER_EMAIL="$OWNER_EMAIL"

# Only these accounts may sign in, and no new sign-ups. Remove both lines to
# open the instance up.
KEEL_ALLOWED_EMAILS="$OWNER_EMAIL"
KEEL_DISABLE_SIGNUP=1

# Passphrase for encrypted backups. Keep a copy somewhere safe - without it an
# encrypted backup cannot be restored.
KEEL_BACKUP_PASSPHRASE="$PASSPHRASE"

KEEL_BACKUP_DIR="$DIR/backups"
EOF
  chmod 600 .env
  ok "wrote .env (mode 600)"
  warn "back up KEEL_BACKUP_PASSPHRASE from .env - encrypted backups need it"
fi

# ----------------------------------------------------------------- install ---
say "Installing dependencies"
npm ci --no-audit --no-fund 2>&1 | tail -3 || npm install --no-audit --no-fund 2>&1 | tail -3
npx prisma generate >/dev/null
ok "dependencies installed"

say "Creating the database"
npm run db:deploy 2>&1 | tail -3
ok "database ready at $DATA_DIR/keel.db"

say "Building"
npm run build 2>&1 | tail -3
ok "built"

# ----------------------------------------------------------------- service ---
install_systemd_user() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/keel.service" <<EOF
[Unit]
Description=Keel
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$(command -v npm) start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$DIR/.env

# Hardening: Keel only needs to read its own directory and write its data.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DIR $DATA_DIR
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now keel.service
  # Without lingering, a user unit stops when you log out.
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "run: sudo loginctl enable-linger $USER (so Keel survives logout)"
  ok "systemd user service installed - systemctl --user status keel"
}

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/com.keel.server.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.keel.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v npm)</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/keel.log</string>
  <key>StandardErrorPath</key><string>$DIR/keel.log</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load -w "$plist"
  ok "launchd agent installed - logs at $DIR/keel.log"
}

if [ "$INSTALL_SERVICE" = "1" ]; then
  say "Installing the service"
  if [ "$PLATFORM" = "macos" ]; then
    install_launchd
  elif command -v systemctl >/dev/null 2>&1; then
    install_systemd_user
  else
    warn "no systemd found - start Keel yourself with: cd $DIR && npm start"
  fi
fi

echo
say "${GREEN}Done.${OFF}"
if [ "$INSTALL_SERVICE" = "1" ]; then
  printf '%s\n' "  Keel is running at ${BOLD}http://localhost:$PORT${OFF}"
else
  printf '%s\n' "  Start it with:  ${BOLD}cd $DIR && npm start${OFF}"
  printf '%s\n' "  Then open:      ${BOLD}http://localhost:$PORT${OFF}"
  printf '%s\n' "  ${DIM}Re-run with --service to start it automatically on boot.${OFF}"
fi
printf '%s\n' "  Register the first account - it becomes the instance owner."
