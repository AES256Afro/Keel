# Keel as a desktop app or an always-on service

## Desktop app (Windows .exe / Linux AppImage)

The Electron shell in `desktop/` opens a native window on your local Keel
server:

- **Attach if running**: if a Keel server already answers on port 3000 (the
  Windows service, `npm run dev`, or a server left behind by a previous app
  session), the app connects to it - the window shows exactly what
  `localhost:3000` shows, same data, same sign-in session.
- **Start if not**: otherwise the app launches the bundled server on port
  3000 itself, with the database and backups in your OS user-data folder
  (`%APPDATA%\Keel\` on Windows, `~/.config/Keel/` on Linux), creating the
  schema automatically on first run.
- **Closing the window does not stop the server** - scheduled backups keep
  running and a browser tab at `localhost:3000` keeps working; relaunching
  the app reattaches instantly.
- You stay signed in across launches (cookies persist for 30 days).
  "Continue with Google" opens your system browser for the Google step (Google
  blocks OAuth in embedded windows) and hands the session back to the app, so
  you land signed in.

**Build locally** (build on the OS you're targeting):

```bash
npm ci
npm run desktop:build
# Windows → dist-desktop/Keel Setup <version>.exe   (one-click installer)
# Linux   → dist-desktop/Keel-<version>.AppImage and .deb
```

The installer is unsigned, so Windows SmartScreen shows "unrecognized app"
once - More info → Run anyway.

**Build via GitHub Actions** (easiest - no local toolchain): the
`Desktop builds` workflow builds Windows and Linux in parallel. Trigger it
from the repo's Actions tab (workflow_dispatch) and download the artifacts,
or push a version tag (`git tag v1.0.0 && git push --tags`) to get a GitHub
release with the `.exe`, `.AppImage`, and `.deb` attached.

How it works: `scripts/desktop-build.mjs` regenerates `prisma/schema.sql`
(applied automatically to brand-new databases, since the packaged app has no
Prisma CLI), builds Next.js in `standalone` mode, assembles the server bundle
(static assets, Prisma engines, schema - with local databases scrubbed), and
hands it to electron-builder as an extra resource.

# Running Keel as an always-on service

Three ways to keep Keel running permanently - surviving crashes and reboots -
without ever typing `npm run dev` again. All of them run the fast production
build (`next start`), not the dev server.

## Windows (recommended for a personal PC)

From the project folder, in a normal PowerShell:

```powershell
npm run service:install
```

That registers a Windows scheduled task named **Keel** which:

- starts automatically **every time you sign in** (so it's back after reboots),
- installs dependencies and builds the app if needed (first start takes a
  minute; after that it's instant),
- syncs the database schema before starting (safe after `git pull`),
- **restarts itself** if the server ever crashes,
- runs hidden in the background, logging to `logs\service.log`.

Then just open <http://localhost:3000> whenever you want - it's always there.

Options:

```powershell
# different port
powershell -ExecutionPolicy Bypass -File scripts\service\install-service.ps1 -Port 4000

# start at BOOT (before anyone signs in) - run from an ADMIN PowerShell
powershell -ExecutionPolicy Bypass -File scripts\service\install-service.ps1 -AtStartup
```

Manage it: Task Scheduler → task "Keel" (right-click to run/stop/disable), or:

```powershell
npm run service:uninstall     # remove the service (your data is untouched)
```

After pulling an update, restart the task (or just reboot); the wrapper
rebuilds automatically when needed. To force a rebuild:
`Remove-Item -Recurse -Force .next` then restart the task.

## Docker (any OS, good for a home server / NAS)

```bash
docker compose up -d --build
```

`restart: unless-stopped` brings the container back after crashes and host
reboots (make sure Docker Desktop / the Docker daemon starts on boot). Your
database lives in the `keel-db` volume; backups land in `./backups` on the
host. Set `KEEL_BACKUP_PASSPHRASE` in your shell or a `.env` file next to
`docker-compose.yml` for automatic encrypted backups.

Update: `git pull && docker compose up -d --build`.

## Linux (systemd)

`/etc/systemd/system/keel.service`:

```ini
[Unit]
Description=Keel workspace
After=network.target

[Service]
WorkingDirectory=/opt/keel
ExecStartPre=/usr/bin/npx prisma db push
ExecStart=/usr/bin/npx next start -p 3000
Restart=always
RestartSec=5
User=keel
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now keel    # starts now and on every boot
```

Build once first (`npm install && npm run build`) and rebuild after updates.

## Locking Keel down before you expose it

Keel is a **single-owner** app. Before putting it on the internet (Cloudflare
Tunnel, a VPS, or any public host), restrict who can sign in - otherwise anyone
who finds the URL could register.

- **Settings → Access control (private instance)** - add your own Google
  account(s) to the allowlist and turn on *Disable new sign-ups*. Only listed
  accounts can then authenticate (password or Google); everyone else is refused.
- **Environment lock** (can't be changed from the web UI, best for servers):

  ```env
  KEEL_ALLOWED_EMAILS="you@gmail.com, other@you.com"
  KEEL_DISABLE_SIGNUP=1
  ```

  When set, these win over the in-app settings and the UI shows them read-only -
  so a stolen session can never widen access.

## Notes

- **Data safety while always-on**: SQLite runs in WAL mode, so hard shutdowns
  don't corrupt the database, and scheduled backups (Settings → Backups) run
  as long as the server is up - which is now always.
- **LAN access**: the server listens on all interfaces; other devices on your
  network can use `http://<your-pc-ip>:3000`. If you expose Keel beyond your
  LAN, put it behind HTTPS (e.g. Caddy/nginx or a Cloudflare Tunnel) - the
  session cookie is marked Secure in production.
