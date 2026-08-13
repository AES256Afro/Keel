#!/usr/bin/env bash
# Keel installer - macOS, Debian/Ubuntu, Arch, Fedora/RHEL, and any Linux with Node 20+.
#
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/install.sh | bash
#   ./install.sh --dir ~/keel --port 3000 --service
#
# What it does:
#   1. Checks for Node 20+ and offers to install it with the system package manager.
#   2. Clones (or updates) the repository into the target directory.
#   3. Writes a .env with a generated backup passphrase and claim guidance.
#   4. Installs dependencies and creates the database.
#   5. Optionally installs a service so Keel starts on boot.
#
# It never runs anything as root except the package-manager step, and it tells
# you before it does. Re-running it is safe: an existing install is updated and
# its .env is preserved, except for the narrowly detected Keel 1.2.1 bootstrap
# bug.
set -euo pipefail

REPO="${KEEL_REPO:-https://github.com/AES256Afro/Keel}"
BRANCH="${KEEL_BRANCH:-main}"
DIR="${KEEL_DIR:-$HOME/keel}"
PORT="${KEEL_PORT:-3000}"
INSTALL_SERVICE=0
OWNER_EMAIL=""
ASSUME_YES=0
CREATED_ENV=0
RECOVERED_LEGACY_ACCESS=0

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
  --owner EMAIL     accepted for older scripts; grants no authority
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

# Kept only so older unattended install commands continue to run. The signed-in
# one-use claim flow selects the account; this value is never written to .env.
OWNER_EMAIL="$(node -e 'process.stdout.write(process.argv[1].trim().toLowerCase())' "$OWNER_EMAIL")"
if [ -n "$OWNER_EMAIL" ] && ! node -e 'const e=process.argv[1]; process.exit(e.length <= 254 && /^[^\s@"\\]+@[^\s@"\\]+$/.test(e) ? 0 : 1)' "$OWNER_EMAIL"; then
  die "'$OWNER_EMAIL' is not a valid email address."
fi
if [ -n "$OWNER_EMAIL" ]; then
  warn "--owner is accepted for older scripts but no longer selects the server owner"
fi

# Updating code, dependencies, or a SQLite schema underneath a running service
# is unsafe and can leave Prisma blocked on the service's open database. Stop
# only a manager entry whose configured working directory resolves to this
# exact install. A manual process or an unrelated Keel service is never killed.
STOPPED_MANAGED_SERVICE=""
STOPPED_MANAGED_PLIST=""

canonical_existing_dir() {
  [ -d "$1" ] || return 1
  (cd -- "$1" && pwd -P)
}

restart_stopped_managed_service() {
  case "$STOPPED_MANAGED_SERVICE" in
    launchd)
      if ! launchctl load -w "$STOPPED_MANAGED_PLIST" >/dev/null; then
        return 1
      fi
      ok "restarted the existing launchd service"
      ;;
    systemd)
      if ! systemctl --user start keel.service; then
        return 1
      fi
      ok "restarted the existing systemd user service"
      ;;
    "") return 0 ;;
    *) return 1 ;;
  esac
  STOPPED_MANAGED_SERVICE=""
  STOPPED_MANAGED_PLIST=""
}

on_installer_exit() {
  local status
  status="$1"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ -n "$STOPPED_MANAGED_SERVICE" ]; then
    warn "the update failed; attempting to restore the previously running service"
    restart_stopped_managed_service || warn "could not restore the managed service automatically"
  fi
  exit "$status"
}

stop_managed_service_for_update() {
  [ -d "$DIR/.git" ] || return 0
  local target_dir managed_dir uid plist
  target_dir="$(canonical_existing_dir "$DIR")" || return 0

  if [ "$PLATFORM" = "macos" ]; then
    uid="$(id -u)"
    plist="$HOME/Library/LaunchAgents/com.keel.server.plist"
    if launchctl print "gui/$uid/com.keel.server" >/dev/null 2>&1 &&
       [ -f "$plist" ] && [ ! -L "$plist" ]; then
      managed_dir="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist" 2>/dev/null || true)"
      managed_dir="$(canonical_existing_dir "$managed_dir" 2>/dev/null || true)"
      if [ "$managed_dir" = "$target_dir" ]; then
        launchctl bootout "gui/$uid" "$plist" >/dev/null ||
          die "could not stop the verified launchd service before updating"
        STOPPED_MANAGED_SERVICE="launchd"
        STOPPED_MANAGED_PLIST="$plist"
        ok "temporarily stopped the verified launchd service"
      fi
    fi
  elif command -v systemctl >/dev/null 2>&1 &&
       systemctl --user is-active --quiet keel.service; then
    managed_dir="$(systemctl --user show keel.service --property=WorkingDirectory --value 2>/dev/null || true)"
    managed_dir="$(canonical_existing_dir "$managed_dir" 2>/dev/null || true)"
    if [ "$managed_dir" = "$target_dir" ]; then
      systemctl --user stop keel.service ||
        die "could not stop the verified systemd user service before updating"
      STOPPED_MANAGED_SERVICE="systemd"
      ok "temporarily stopped the verified systemd user service"
    fi
  fi
}

trap 'on_installer_exit $?' EXIT
stop_managed_service_for_update

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
chmod 700 "$DATA_DIR" "$DIR/backups"

if [ -f .env ]; then
  ok ".env already exists - preserving existing settings"
else
  # A generated passphrase means encrypted backups work out of the box instead
  # of failing the first time the scheduler runs.
  PASSPHRASE="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
cat > .env <<EOF
# Generated by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ')

DATABASE_URL="file:$DATA_DIR/keel.db"
PORT=$PORT

# Claiming starts in the signed-in app and separately confirms control of this machine.
KEEL_CLAIM_REQUIRED=1

# Registration stays open on this local install. After claiming the server, its
# owner can change registration policy in Settings -> Registration and sign-in.

# Passphrase for encrypted backups. Keep a copy somewhere safe - without it an
# encrypted backup cannot be restored.
KEEL_BACKUP_PASSPHRASE="$PASSPHRASE"

KEEL_BACKUP_DIR="$DIR/backups"
EOF
  chmod 600 .env
  # Prisma's SQLite schema engine does not create a missing database file on
  # every supported macOS/Node combination. An empty file is enough for the
  # migration runner to initialize it, and never touches an existing database.
  if [ ! -e "$DATA_DIR/keel.db" ]; then
    : > "$DATA_DIR/keel.db"
    chmod 600 "$DATA_DIR/keel.db"
  fi
  CREATED_ENV=1
  ok "wrote .env (mode 600)"
  warn "back up KEEL_BACKUP_PASSPHRASE from .env - encrypted backups need it"
fi

# ----------------------------------------------------------------- install ---
say "Installing dependencies"
if ! npm ci --no-audit --no-fund 2>&1 | tail -3; then
  warn "npm ci failed; retrying once with npm install"
  npm install --no-audit --no-fund 2>&1 | tail -3
fi
npx prisma generate >/dev/null
ok "dependencies installed"

# Run the shared repair only after @prisma/client exists and matches the local
# SQLite schema. It recognizes the complete 1.2.1 installer template and
# reports unchanged for every user-managed or uncertain configuration.
if [ "$CREATED_ENV" != "1" ]; then
  LEGACY_RECOVERY_STATUS="$(node scripts/recover-v121-installer-env.mjs "$DIR/.env")"
  if [ "$LEGACY_RECOVERY_STATUS" = "repaired" ]; then
    RECOVERED_LEGACY_ACCESS=1
    warn "repaired the blocked Keel 1.2.1 first-account setting"
  fi
fi

say "Creating the database"
if ! npm run db:deploy 2>&1 | tail -20; then
  die "database migration failed. Stop any manually started Keel process and re-run the installer."
fi
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
UMask=0077
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
  systemctl --user enable keel.service
  systemctl --user restart keel.service
  # Without lingering, a user unit stops when you log out.
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "run: sudo loginctl enable-linger $USER (so Keel survives logout)"
  ok "systemd user service installed - systemctl --user status keel"
}

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/com.keel.server.plist"
  mkdir -p "$(dirname "$plist")"
  touch "$DIR/keel.log"
  chmod 600 "$DIR/keel.log"
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
  <key>Umask</key><integer>63</integer>
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
  # The newly installed manager has already started the service.
  STOPPED_MANAGED_SERVICE=""
  STOPPED_MANAGED_PLIST=""
fi

# A process that loaded the broken 1.2.1 environment must be restarted before
# the repair can take effect. Restart a known managed service even when this
# rerun omitted --service; otherwise provide an explicit manual handoff.
RECOVERY_RESTARTED=0
if [ -n "$STOPPED_MANAGED_SERVICE" ]; then
  restart_stopped_managed_service || die "the update succeeded but the managed service could not be restarted"
  RECOVERY_RESTARTED=1
fi
if [ "$RECOVERED_LEGACY_ACCESS" = "1" ] && [ "$INSTALL_SERVICE" != "1" ]; then
  if [ "$PLATFORM" = "macos" ] && launchctl print "gui/$(id -u)/com.keel.server" >/dev/null 2>&1; then
    if launchctl kickstart -k "gui/$(id -u)/com.keel.server"; then
      RECOVERY_RESTARTED=1
      ok "restarted the existing launchd service"
    else
      warn "could not restart the existing launchd service automatically"
    fi
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet keel.service; then
    if systemctl --user restart keel.service; then
      RECOVERY_RESTARTED=1
      ok "restarted the existing systemd user service"
    else
      warn "could not restart the existing systemd user service automatically"
    fi
  fi
fi

echo
say "${GREEN}Done.${OFF}"
if [ "$INSTALL_SERVICE" = "1" ]; then
  printf '%s\n' "  Keel is running at ${BOLD}http://localhost:$PORT${OFF}"
else
  printf -v SHELL_DIR '%q' "$DIR"
  printf '%s\n' "  Start it with:  ${BOLD}cd -- $SHELL_DIR && npm start${OFF}"
  printf '%s\n' "  Then open:      ${BOLD}http://localhost:$PORT${OFF}"
  printf '%s\n' "  ${DIM}Re-run with --service to start it automatically on boot.${OFF}"
fi
if [ "$CREATED_ENV" = "1" ]; then
  printf '%s\n' "  1. Register an account in Keel."
  printf '%s\n' "  2. In Welcome or Settings, open ${BOLD}Claim this server${OFF}."
  printf '%s\n' "  3. Generate and copy the exact one-use claim command shown there."
  printf '%s\n' "  4. Run it in a terminal and complete fresh OS administrator authorization."
  printf '%s\n' "  ${DIM}The browser never asks for or receives your operating-system password.${OFF}"
  printf '%s\n' "  ${DIM}Registration remains open until the server owner changes it in Settings -> Registration and sign-in.${OFF}"
else
  if [ "$RECOVERED_LEGACY_ACCESS" = "1" ]; then
    printf '%s\n' "  Existing access settings were repaired."
    printf '%s\n' "  ${DIM}The old hard signup stop was removed; the existing owner allowlist remains.${OFF}"
    if [ "$RECOVERY_RESTARTED" != "1" ] && [ "$INSTALL_SERVICE" != "1" ]; then
      printf '%s\n' "  ${YELLOW}Stop any running Keel process, then start it again so the repair takes effect.${OFF}"
    fi
    printf '%s\n' "  ${DIM}Register with the KEEL_ALLOWED_EMAILS address retained in .env.${OFF}"
  else
    printf '%s\n' "  Existing access settings were unchanged."
    printf '%s\n' "  ${DIM}Registration follows the access settings already present in .env.${OFF}"
  fi
fi
