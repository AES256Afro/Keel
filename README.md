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
| **macOS / Linux server** | A laptop, home server, or VPS | `curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/install.sh \| bash -s -- --service` |
| **Windows service** | Keel always running after sign-in | `irm https://raw.githubusercontent.com/AES256Afro/Keel/main/install.ps1 \| iex` |
| **Docker** | A home server, NAS, or VPS | `docker compose up -d --build` |
| **From source** | Development and review | `npm ci && npm run dev` |

Open `http://localhost:3000`. The first account becomes the instance owner. The
welcome tour explains where data lives and how to choose a backup. The in-app
Setup page walks through optional services with exact provider links and steps.

For prerequisites, expected results, updates, and troubleshooting, use the
[guided install page](https://keelnotes.com/install/) or [docs/INSTALL.md](docs/INSTALL.md).

## What Keel includes

**Writing:** a block editor, Markdown shortcuts, task lists, code blocks,
`[[wikilinks]]`, backlinks, tags, daily notes, focus mode, split view, sequence
reading, and pasted-image attachments.

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

The release tarball and shell installer provide:

```text
keel start | stop | status | logs     run the server (data in ~/.keel)
keel export notebook.db               copy the complete SQLite workspace
keel import notebook.db               restore it on another machine
keel to-docker                        create a Docker deployment from this install
keel update                           update the app without replacing data
keel paths                            show application and data locations
```

## Moving an install

SQLite deployments keep the workspace in one database file, so moving between
install methods is deliberately uneventful:

- Laptop to laptop: `keel export`, copy the file, then `keel import`.
- Laptop to Docker: `keel to-docker`, then `docker compose up -d`.
- Docker to another host: stop Keel, copy `keel.db` from the volume, and import.
- Any method: download and restore a snapshot from Settings. Set a passphrase
  before export when the backup needs application-level encryption.

Always stop writes or use Keel's export/backup command instead of copying a live
SQLite file directly.

## Development

```bash
npm ci
npm run dev          # http://localhost:3000
npm test             # typecheck, lint, and application checks
npm run build        # production build
npm run site:check   # validate the static keelnotes.com site
```

Operational documentation:

- [Install options](docs/INSTALL.md)
- [Always-on hosting](docs/HOSTING.md)
- [Cloud backup and transfer](docs/CLOUD.md)
- [Deployment modes](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)

## License

Keel 1.2.0 is source-available under the [Business Source License 1.1](LICENSE).
Personal self-hosting and internal organizational use are allowed. Offering a
third-party hosted or managed Keel service requires a commercial license. This
version changes to Apache 2.0 on August 13, 2030. See [LICENSING.md](LICENSING.md)
for the plain-language summary.
