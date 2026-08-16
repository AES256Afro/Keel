<p align="center">
  <img src="src/app/icon.svg" width="96" height="96" alt="Keel">
</p>

<h1 align="center">Keel</h1>

<p align="center">
  <b>A self-hosted notebook that carries its own toolbox.</b><br>
  Pages, databases, kanban, mind maps, wikilinks, and a graph in one workspace
  you control.<br>
  <i>No AI. No telemetry. No required cloud account.</i>
</p>

<p align="center">
  <a href="https://keelnotes.com">Website</a> ·
  <a href="https://keelnotes.com/install/">Install guide</a> ·
  <a href="https://github.com/AES256Afro/Keel/releases/latest">Latest release</a> ·
  <a href="SECURITY.md">Security</a>
</p>

## Choose an install

Every route runs the same Keel app. The desktop downloads are the easiest way
to try it. The server and Docker routes are better when you want access from
several devices.

| Method | Best for | Start here |
| --- | --- | --- |
| **Windows app** | A personal Windows computer | Download the `.exe` from [Releases](https://github.com/AES256Afro/Keel/releases/latest) |
| **Linux desktop** | A Linux workstation | Download the `.AppImage` or `.deb` from [Releases](https://github.com/AES256Afro/Keel/releases/latest) |
| **iPhone / iPad source client** | A self-hosted server plus native Apple Pencil drawing | Generate the Xcode project from [docs/IOS.md](docs/IOS.md) |
| **macOS / Linux server** | A laptop, home server, or VPS | `curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/install.sh \| bash -s -- --service` |
| **Windows service** | Keel always running after sign-in | `irm https://raw.githubusercontent.com/AES256Afro/Keel/main/install.ps1 \| iex` |
| **Docker** | A home server, NAS, or VPS | `docker compose up -d --build` |
| **From source** | Development and review | `npm ci && npm run dev` |

Open `http://localhost:3000`. Registration is open by default and stays open
until the server owner changes it. On server, source, and Docker installs,
register an account, open **Claim this server** in Welcome or Settings, and
generate a one-use command bound to that account. Run it on the Keel machine
within five minutes. macOS and Linux require fresh sudo authorization; Windows
requires Administrator PowerShell. The browser never asks for an
operating-system password. The loopback-only desktop package assigns these
controls to its first local workspace owner automatically, so it does not show
a terminal claim step. On a public host, bootstrap privately and enable the
hard signup stop before exposure. The welcome tour explains where data lives
and how to choose a backup.

For prerequisites, expected results, updates, and troubleshooting, use the
[guided install page](https://keelnotes.com/install/) or [docs/INSTALL.md](docs/INSTALL.md).

The supported Compose files require Docker Compose 2.30 or newer so env files
can be read in raw mode. This keeps dollar signs in passwords and tokens
literal. The local stack publishes only `127.0.0.1:3000`; use
`KEEL_HOST_PORT` to change the host-side port. After registering in Docker,
generate a one-use token and run the exact command shown in Keel, for example:

```bash
docker compose exec --user root -e KEEL_CONTAINER_CLAIM=1 keel npm run claim -- 'one-use-token'
```

On Docker Desktop, use that command from a terminal with daemon access. On a
Linux Docker host, first run `sudo -k`, then prefix the Docker command with
`sudo`. Docker daemon control is the machine-authorization boundary; the normal
Keel process continues to run as the unprivileged `node` user.

After claiming a server, its owner can add Google sign-in, Google Drive,
OneDrive, and OneNote from **Settings -> Integrations**. The page supplies the
exact callback URLs. Client secrets are write-only, changes apply immediately,
and Keel encrypts saved values with a host key kept outside the database. Saved
credentials remain labeled unverified until a real provider flow succeeds.
Environment credentials remain available as locked deployment overrides.

The instance owner can also edit the optional public site's name, tagline, and
Notes link, and save the scheduled-backup passphrase as a write-only managed
secret. Environment values remain per-field locked overrides. A read-only
effective-configuration summary reports the database dialect and network,
proxy, WebAuthn, access, and storage posture while omitting secret values,
database URLs, and absolute host paths.

## What Keel includes

**Writing:** a block editor, Markdown shortcuts, task lists, code blocks,
`[[wikilinks]]`, backlinks, tags, daily notes, focus mode, split view, sequence
reading, pasted-image attachments, a global command palette, trash undo and
retention, revocable read-only public links for individual documents, and an
iOS PencilKit bridge that stores portable PNGs plus editable Apple Pencil ink.

**Structure:** table, list, board, mind-map, and timeline database views;
records that open as pages; WIP limits; properties; templates; and a stable
workspace graph.

**Ownership:** SQLite by default or PostgreSQL when you choose it, full
workspace import/export, encrypted snapshot backups when a passphrase is set,
optional Google Drive, OneDrive, Azure Blob, or Cloudflare R2 backup copies,
and an optional read-only OneNote mirror.

**Operations:** update checks, WebAuthn security keys, allowlists, sign-up
lockdown, audit events, health checks, rate limiting, a strict content security
policy, and documented Tailscale, reverse-proxy, and Cloudflare Tunnel paths.

## The `keel` CLI

The platform-specific release tarball provides:

```text
keel start | stop | status | logs     run the server (data in ~/.keel)
keel export notebook.db               copy SQLite data and its managed-secret companion
keel import notebook.db               restore that bundle on another machine
keel to-docker                        create a Docker deployment from this install
keel update                           update the app without replacing data
keel paths                            show application and data locations
keel claim <one-use-token>             claim instance-owner controls from the server terminal
```

Generate the one-use token from **Claim this server** while signed in. From a
source checkout, run the exact `npm run claim -- <one-use-token>` command shown
there. The token expires after five minutes and can be used once. Claiming does
not close registration; the owner controls registration separately in Settings.

## Moving an install

SQLite deployments keep notebook data in one database file. If Settings has
created any managed OAuth credential, scheduled-backup secret, or cloud
connection, `keel export notebook.db` also writes the mode-`0600` sibling
`notebook.db.keel-server-secrets.key`. Keep those two files together. The key is
never printed.

- Laptop to laptop: `keel export`, copy the database and any key companion, then
  `keel import`. Import preserves the outgoing key beside its pre-import database
  backup and refuses to overwrite an unrelated environment-managed key.
- Laptop to Docker: `keel to-docker`, then `docker compose up -d`. The generated
  stack keeps `./data` as a private one-time import seed and runs Keel from a
  Docker-owned named volume. Re-running `keel to-docker` never replaces an
  initialized volume.
- Docker to another host: stop Keel, copy `keel.db` and
  `.keel-server-secrets.key` from the volume, and import them from the same
  directory.
- Any method: download and restore a snapshot from Settings. Set a passphrase
  before export when the backup needs application-level encryption.

Always stop writes or use Keel's export/backup command instead of copying a live
SQLite file directly.

## Development

```bash
npm ci
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # typecheck, lint, and 40 application suites
npm run site:check   # validate the static keelnotes.com site
```

Twelve suites inside `npm test` launch the production server against isolated test
databases, so build before running the complete command.

Operational documentation:

- [Install options](docs/INSTALL.md)
- [Always-on hosting](docs/HOSTING.md)
- [Cloud backup and transfer](docs/CLOUD.md)
- [Deployment modes](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)
- [iOS, iPadOS, and Apple Pencil](docs/IOS.md)

## License

Keel 1.2.6 is source-available under the [Business Source License 1.1](LICENSE).
Personal self-hosting and internal organizational use are allowed. Offering a
third-party hosted or managed Keel service requires a commercial license. This
version changes to Apache 2.0 on August 13, 2030. See [LICENSING.md](LICENSING.md)
for the plain-language summary.
