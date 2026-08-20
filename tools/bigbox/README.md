# bigbox - the BigBox management & troubleshooting CLI

One command to look after the box that runs **Keel** and **Pi-hole**: restart
services, take and verify backups, find out *which layer* of the internet is
broken, and let a watchdog fix the boring failures before you notice them.

- **One file, zero dependencies.** `bigbox.mjs` runs on any Node 20+ - which
  every Keel install already has. Nothing to `npm install`.
- **Cross-platform.** Windows (Scheduled Task), Linux (systemd user/system
  unit or Docker), macOS (launchd). Pi-hole is managed natively or as a
  Docker container, whichever it finds.
- **Local or remote.** Run it on the box, or from your laptop with
  `--host user@bigbox` - it streams itself over SSH, so the box needs nothing
  installed beyond Node.

## Install

Clone this repo anywhere (it's private - clone with a token or SSH key that
can read it) and optionally put the launcher on your PATH:

```bash
# Linux / macOS
git clone https://github.com/AES256Afro/BigBoxTool ~/bigboxtool
ln -s ~/bigboxtool/bigbox ~/.local/bin/bigbox
bigbox status

# updating later is just:
git -C ~/bigboxtool pull
```

```powershell
# Windows - clone, add the folder to PATH, then:
bigbox status        # bigbox.cmd / bigbox.ps1 both work
```

From another machine, no install at all:

```bash
node bigbox.mjs --host admin@bigbox status
```

> The tool also ships inside the Keel repository under `tools/bigbox/`; this
> repo is the standalone home so a box doesn't need the whole Keel source
> tree just to be managed.

## The GUI

```bash
bigbox gui                        # dashboard for this machine
bigbox gui --host chris@bigbox    # …on your Mac, managing the box over SSH
```

It starts a small local web server and opens your browser. There is no build
step, no Electron download, and no agent to install on the box - the page is
served by the same single file, and every panel is produced by running the CLI
itself, so **the GUI can never disagree with the terminal**.

Five tabs: **Overview** (live status cards plus one-click restart, doctor,
update), **Network** (the layered ladder with its verdict), **Backups**
(snapshot / verify / prune, with the list), **Logs** (Keel or Pi-hole, with a
follow mode), **Paths**. It auto-refreshes every 15 s and follows your system
light/dark theme.

### Managing a headless box from your desktop

`--host` is the interesting one: the **server runs on your laptop** and reaches
the box over SSH per request. So the box needs nothing beyond Node and your SSH
key - no open ports, no daemon, nothing new to secure. Everything the buttons do
is exactly what you'd have typed.

### macOS app

```bash
bigbox gui --install-app --host chris@bigbox
```

Writes `~/Applications/BigBox.app` - double-click it (or Spotlight "BigBox") and
the dashboard opens with no terminal. The app icon is generated on the spot by a
tiny PNG encoder in the script, so nothing binary has to ship.

Linux and Windows equivalents are next; until then a launcher is a one-liner:

```ini
# Linux - ~/.local/share/applications/bigbox.desktop
[Desktop Entry]
Type=Application
Name=BigBox
Exec=node /home/you/bigboxtool/bigbox.mjs gui --host chris@bigbox
Icon=utilities-terminal
```

```powershell
# Windows - a shortcut whose target is:
node C:\bigboxtool\bigbox.mjs gui --host chris@bigbox
```

### Security

The dashboard can restart services, so it is locked down by default:

- **Loopback only.** It binds `127.0.0.1`; nothing on your network can reach it.
- **Token required.** A fresh random token per run, passed once in the opened
  URL and then moved into a `HttpOnly`/`SameSite=Strict` cookie. Every endpoint
  checks it.
- **Fixed action list.** Buttons map to a hard-coded allowlist of argument
  arrays - a request body can never become a command line.
- **DNS-rebinding guard.** While bound to loopback, requests carrying any other
  `Host` header are refused, so a malicious page can't drive your dashboard.
- A strict CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

`--bind` exists for reaching the GUI over a private network (a Tailscale
address, say), and warns when you use it. Prefer an SSH tunnel if you can -
`ssh -L 7717:127.0.0.1:7717 chris@bigbox`, then open `127.0.0.1:7717` - or just
run the GUI locally with `--host`, which needs no listener on the box at all.

## Commands

### Everyday

| Command | What it does |
| --- | --- |
| `bigbox gui` | The dashboard (see above). `--host` drives a remote box; `--install-app` makes a macOS app. |
| `bigbox status` | One-screen dashboard: Keel service + HTTP health, Pi-hole + DNS answer time, database and WAL size, backups freshness, disk, memory, load, CPU temperature, gateway/internet/DNS/HTTPS, Tailscale. Exit code 0/1/2 for scripting. |
| `bigbox doctor` | Everything in `status` plus database `quick_check`, `.env` sanity, systemd linger, and a list of what can be auto-fixed. |
| `bigbox doctor --fix` | Applies the safe fixes and re-checks. `--dry-run` previews. |
| `bigbox restart keel` | Restart Keel via whatever runs it (systemd / launchd / Scheduled Task / Docker), then wait until `/api/health` answers. Also `start`, `stop`, and targets `pihole`, `dns`, `all`. |
| `bigbox logs keel -f` | The right log source per platform: journald, `keel.log`, or `docker logs`. `bigbox logs pihole -f` tails Pi-hole. |
| `bigbox stacks` | Every compose project on the box - discovered from the labels compose stamps on its containers, so nothing registers anything. Per-container verdicts: restart loops, unhealthy, exited-despite-restart-policy, healthcheck lies, no-volume data risk. |
| `bigbox stack <name> restart` | Per-stack verbs for any project, not just Keel: `status`, `restart`, `logs [-f]`, `update` (pull + up -d). |
| `bigbox ports` | Every published port with who can reach it (loopback / lan / tailnet / world) - and a reminder that Docker publishes bypass ufw, so the firewall does not cover them. |
| `bigbox net` | Walks the stack in order - default route → router → raw internet (`1.1.1.1`) → DNS via Pi-hole → DNS via upstream → system resolver → HTTPS → Keel - and tells you in plain words whose fault it is (ISP, router, Pi-hole, resolver config, or Keel). `--fix` restarts Pi-hole's resolver when it's the culprit. |

### Data - backups & storage

| Command | What it does |
| --- | --- |
| `bigbox env` | Keel's environment - what bigbox manages, and what's actually live inside the container. Secrets shown as `<set, hidden>`. |
| `bigbox env set KEY=VALUE …` | Writes to a `bigbox.env` beside your compose file (mode 600), adds `env_file:` to the service if it isn't there, **recreates** the container, then verifies the value is live. See below. |
| `bigbox env unset KEY …` | Removes and re-applies. |
| `bigbox paths` | The data map: install dir, `.env`, database file + size, backup folder, service definitions, log locations, Pi-hole's `/etc/pihole` or Docker volume mounts. |
| `bigbox backup now` | **Docker installs included** - see below. Consistent SQLite snapshot (`sqlite3 .backup` when available - safe while Keel is running) plus a copy of `.env` (your backup passphrase!) and a manifest, into the Keel backup folder. |
| `bigbox backup list` | Everything in the backup folder - Keel's own in-app backups and bigbox snapshots - with size and age. |
| `bigbox backup verify` | `PRAGMA integrity_check` on the newest snapshot, because a backup you never tested is a hope, not a backup. |
| `bigbox backup prune --keep 10` | Deletes old bigbox snapshots beyond the newest N. |

### Care & feeding

| Command | What it does |
| --- | --- |
| `bigbox update` | Snapshot first, then `git fetch/reset`, `npm ci`, migrations, build, restart, and wait for health. Refuses to clobber local changes unless `--yes` (stashes them). |
| `bigbox pihole <args…>` | Pass-through to the `pihole` CLI, native or inside Docker: `bigbox pihole -g` (update gravity), `bigbox pihole disable 5m`, `bigbox pihole status`. |
| `bigbox notify add <url>` | Add an alert channel - ntfy, Gotify, an Uptime Kuma push monitor, or any JSON webhook. The URL is tested **before** it is saved, because a channel that never worked feels like coverage and isn't. Tokens are masked in all output. |
| `bigbox notify test` / `send <msg>` | Prove alerts actually reach your phone. |
| `bigbox digest` | Send the once-a-day summary now. The watchdog sends it automatically - one message a day when all is well, so silence itself becomes meaningful. |
| `bigbox report` | A redacted markdown support bundle - versions, service states, all checks, `.env` with secrets masked, last 60 log lines - written next to your backups, safe to share. |
| `bigbox watch --fix` | Self-remediation loop: every 5 minutes it probes Keel's health endpoint and Pi-hole's DNS; restarts whichever is down, prunes snapshots if the disk passes 95%, and logs every action to `bigbox-watch.log`. |
| `bigbox watch --install` | Registers the watchdog as a boot service (systemd user unit / launchd agent / Scheduled Task). `--uninstall` removes it. |

## Backing up a containerised Keel

If Keel runs in Docker, its `DATABASE_URL` and backup folder live *inside* the
container, so there is no host `.env` to read. bigbox resolves the real paths
from the container's bind mounts instead: it reads `DATABASE_URL` out of the
container environment, maps that container path through the mount table
(deepest mount wins), and lands on the database's actual location on the host.

That matters for more than tidiness. Backing up through the container -
`docker exec … sqlite3 …` - breaks the moment an image rebuild drops `sqlite3`,
and the failure is silent until you look. Reading the bind mount from the host
depends on nothing inside the image.

So on a Docker box you get the same commands and the same guarantees:

```bash
bigbox backup now      # snapshots the database from the host mount
bigbox backup verify   # PRAGMA integrity_check on it
bigbox status          # real size, WAL and integrity - not "inside the container"
```

The snapshot keeps the database's own filename (`nopin.db` stays `nopin.db`, so
restoring is an obvious copy back) and captures the container's Keel-relevant
environment to `keel.env` (mode 600) - above all `KEEL_BACKUP_PASSPHRASE`,
without which an encrypted backup cannot be restored at all.

**When the database is not on a mount, that is the headline.** If the container
has no volumes, or the database sits outside the ones it has, bigbox warns that
the data lives in the container's writable layer and dies when the container is
recreated - rather than quietly reporting "inside the container" as if that were
fine.

## Setting configuration (`bigbox env`)

Configuring a containerised Keel has three traps, so the tool handles all of
them:

1. **Finding the compose file.** It reads the labels Compose stamps on every
   container it creates (`com.docker.compose.project.working_dir`,
   `…config_files`, `…service`) - no guessing, no `find`.
2. **A `.env` beside the compose file does nothing.** Compose reads it for
   `${VAR}` substitution *inside the YAML*; it does not pass anything to the
   container. You need `env_file:` (or `environment:`), so bigbox adds
   `env_file: bigbox.env` to the service if it's missing.
3. **`docker restart` silently keeps the old values.** Environment is fixed
   when a container is *created*, so bigbox runs `docker compose up -d` to
   recreate, then reads the variable back out of the running container to
   prove it took.

```bash
bigbox env set KEEL_WEBAUTHN_RP_ID=box.tailnet.ts.net \
               KEEL_WEBAUTHN_ORIGIN=https://box.tailnet.ts.net:8445
bigbox env            # what's set, and what's live (secrets hidden)
```

Values are written unquoted on purpose - Compose's `env_file` parser treats
quotes literally, so `KEY="abc"` would arrive as `"abc"` including them. The
file is `chmod 600` because OAuth secrets live in it. Your compose file is
backed up to `*.bigbox-bak` before the one-time two-line edit, comments and
formatting preserved (it's a line-based insertion, not a YAML round-trip that
would reformat your file). An existing `env_file:` is appended to rather than
replaced, whether it's list or scalar form.

For a non-Docker install there's no compose step: it edits Keel's own `.env`
and restarts the service.

## The whole box, not just Keel

`bigbox stacks` treats the box as what it is - a fleet of compose projects.
Discovery is free: compose labels every container with its project, service and
config file. On top of that the tool layers the failure modes that actually
happen:

- **Restart loops** - a container flapping under its restart policy is named,
  with its restart count, instead of silently churning forever.
- **Healthcheck lies** - a container reporting *unhealthy* while its published
  port answers is a misconfigured healthcheck, not an outage. bigbox probes the
  host port and says which it is, so nobody restarts a working service.
- **Died despite its restart policy** - exited with `restart: always` means
  something is wrong enough that Docker gave up.
- **No volumes** - a running container with zero mounts loses everything it
  writes on recreate.

The watchdog pages on real failures across the whole fleet (with the last log
lines in the alert), stays quiet on lying healthchecks, and `status` and the
GUI's **Stacks** tab show every project with the same verdicts.

## Alerts - the watchdog can finally reach you

```bash
bigbox notify add https://ntfy.sh/<hard-to-guess-topic>   # easiest: install the ntfy app, pick a topic
bigbox notify test                                        # message arrives on your phone
bigbox watch --install                                    # the watchdog now pages you
```

What gets sent, and when:

- **A failure alerts once** - Keel down, DNS dead, disk ≥ 95%. While it persists you
  get a reminder every six hours, not a page every five minutes. When it clears, a
  recovery message says how long it was down. State survives restarts
  (`~/.bigbox/state.json`).
- **Failed backups alert immediately**, with the failing reason - the exact failure
  that once went unnoticed for ten days.
- **A daily digest** - one message a day: "all clear" or the list of problems. If the
  digest stops arriving, that silence is itself the alarm.
- **Alerting works without `--fix`** - an observe-only watchdog still pages you.

Channels: **ntfy** (POST with priority + tags), **Gotify** (JSON message), **Uptime
Kuma push monitors (bigbox reports `up`/`down`, so Kuma's own alerting and status
pages take over from there), and a **generic JSON webhook** for anything else.
Channel URLs carry tokens, so the file is mode 600 and every printed URL is masked.

## Self-remediation - what `--fix` will and won't do

The philosophy: **fix what is safe and reversible, report everything else.**

Will do automatically: start/restart a dead Keel service, restart Pi-hole's
DNS resolver when it stops answering, checkpoint a bloated WAL journal,
create a missing backup folder, take a snapshot when backups are stale
(> 7 days), prune old snapshots when the disk is nearly full, enable
systemd lingering so Keel survives logout.

Will never do: delete anything that isn't a bigbox snapshot, touch your
`.env`, change Pi-hole blocklists, restart the router, or update software
without being asked (`bigbox update` is always explicit).

## Wish-list - implemented ✅ and still on the wish-list 💭

Ideas that came up designing this; the checked ones are in this version:

- ✅ **"Whose fault is it?" network ladder** - separates ISP vs router vs
  Pi-hole vs resolver config instead of a useless "internet down".
- ✅ **Remote mode over SSH** - manage the box from any laptop with zero
  install on either side beyond Node + `ssh`.
- ✅ **Watchdog with self-healing** and an installer for all three OSes.
- ✅ **Backup verification** - integrity-check snapshots, not just write them.
- ✅ **Support bundle** with secrets redacted.
- ✅ **`--json` output** for `status`/`doctor`/`net`, so you can wire it into
  Home Assistant, Uptime Kuma, cron mail, or a dashboard.
- ✅ **A GUI** - cross-platform, zero-dependency, and able to manage a headless
  box from your desktop over SSH. macOS gets a real `.app`.
- ✅ **CPU temperature** on Linux (Raspberry Pi throttling shows up here).
- ✅ **Notifications** - ntfy / Gotify / Uptime Kuma / webhook alerts with
  once-per-failure semantics, recovery messages, and a daily digest.
- ✅ **Container-aware backups** - snapshot a Dockerised Keel straight from its
  bind mount, with no dependency on tools inside the image.
- 💭 **Pi-hole Teleporter backup** - bundle Pi-hole's settings export into
  `bigbox backup now` so blocklists and local DNS records are covered too.
- 💭 **Speed-test history** - periodic `speedtest`/iperf3 results logged over
  time, so "the internet feels slow" becomes a graph.
- ✅ **Fleet management** - every compose stack discovered, per-stack verbs,
  restart-loop and healthcheck-lie detection, and the published-port exposure map.
- 💭 **Linux/Windows app launchers** - generate a `.desktop` entry and a Start
  Menu shortcut the way macOS gets its `.app`.
- 💭 **Menu-bar / tray applet** - health colour at a glance without opening
  anything.
- 💭 **Smart-plug power cycle** - when the modem is the diagnosis, toggle a
  Tasmota/Kasa plug to power-cycle it automatically.
- 💭 **UPS awareness** - read NUT/apcupsd state and shut Keel down cleanly on
  low battery.
- 💭 **Restore rehearsal** - spin the newest snapshot up on a scratch port and
  hit `/api/health`, proving the backup actually boots.
- 💭 **Metrics endpoint** - Prometheus-style export of check results.

## Requirements & notes

- Node 20+ (Node 22+ enables the built-in SQLite fallback when the `sqlite3`
  CLI isn't installed; with neither, integrity checks are skipped and backups
  fall back to a checkpointed file copy).
- Keel is auto-detected in `~/keel`, `%LOCALAPPDATA%\Keel`, `$KEEL_DIR`, or
  wherever `--dir` points. Configuration (port, database, backup folder) is
  read from Keel's `.env`.
- Restarting a *system* (root) Keel service or native Pi-hole's `pihole-FTL`
  may need passwordless `sudo` for those specific `systemctl` commands; the
  tool tells you the exact command when it can't.
- Postgres-backed installs: service/network/Pi-hole management all works;
  database snapshots are skipped (back up on the Postgres side).
