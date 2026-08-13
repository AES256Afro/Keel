# Installing Keel

Keel runs the same way everywhere: one Node process, one database, one port.
What changes between targets is where that process lives and what stores the
data. Pick the row that matches you.

| I want to… | Go to |
| --- | --- |
| Use it on my own Mac / Windows / Linux machine | [Local](#local) |
| Run it on a home server and reach it from my phone | [Home server](#home-server) |
| Run it on a VPS (DigitalOcean, Linode, Hetzner, AWS EC2, Azure VM) | [VPS](#vps) |
| Run it on a managed container platform | [Containers](#containers) |
| Run it on Azure | [Azure](#azure) |
| Run it on Cloudflare | [Cloudflare](#cloudflare) |

Everything below assumes **Node.js 20 or newer**. The installers will offer to
install it for you.

---

## Local

### macOS, Debian/Ubuntu, Arch, Fedora, openSUSE, Alpine

```bash
curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/install.sh | bash -s -- --service
```

The installer checks Node, clones the repository, writes a `.env` with a
generated backup passphrase, builds, and (with `--service`) registers a
launchd agent on macOS or a systemd **user** unit on Linux so Keel starts on
boot. Re-running it updates in place and never overwrites your `.env`.

Options:

```bash
./install.sh --dir ~/notes --port 8080 --owner you@example.com --service --yes
```

Then open `http://localhost:3000` and register. **The first account to register
becomes the instance owner** - the only one who can reach the admin portal, the
sign-in allowlist and the tunnel controls. Pin it explicitly with
`KEEL_OWNER_EMAIL` in `.env` if you want that decided up front.

### Windows

```powershell
irm https://raw.githubusercontent.com/AES256Afro/Keel/main/install.ps1 | iex
```

Or with options:

```powershell
.\install.ps1 -Dir C:\Keel -Port 3000 -Owner you@example.com -Service
```

`-Service` registers a Scheduled Task that starts Keel at logon and restarts it
if it crashes.

### Desktop app (no terminal)

```bash
npm run desktop:build
```

Produces a Windows installer (`.exe`), a Linux `AppImage` and a `.deb` in
`dist-desktop/`. The desktop app runs its own server on localhost, stores data
in your user profile, and keeps running in the background so scheduled backups
still happen after you close the window.

Managing a service afterwards:

| | Start | Stop | Logs |
| --- | --- | --- | --- |
| macOS | `launchctl load -w ~/Library/LaunchAgents/com.keel.server.plist` | `launchctl unload …` | `~/keel/keel.log` |
| Linux | `systemctl --user start keel` | `systemctl --user stop keel` | `journalctl --user -u keel -f` |
| Windows | `Start-ScheduledTask Keel` | `Stop-ScheduledTask Keel` | Event Viewer |

---

## Home server

Run the local install on the server, then expose it **without opening a port**:

**Tailscale (recommended).** Private by default - only your devices can reach it.

```bash
tailscale serve --bg 3000
```

Your instance is then at `https://<machine>.<tailnet>.ts.net`. It's real HTTPS,
which matters: security keys (WebAuthn) refuse to work without a secure context.
Set the relying-party identity to match:

```bash
KEEL_WEBAUTHN_RP_ID=<machine>.<tailnet>.ts.net
KEEL_WEBAUTHN_ORIGIN=https://<machine>.<tailnet>.ts.net
```

**Cloudflare Tunnel.** Reachable from anywhere, so lock it down first:
Settings → Access control → add only your own email, disable sign-ups. The
tunnel controls are in Settings once you're signed in as the instance owner.

---

## VPS

Works on DigitalOcean, Linode, Hetzner, Vultr, AWS EC2, Azure VM - anything that
gives you a Debian or Ubuntu box.

### One command, from your laptop

Paste this as the **user data / cloud-init** field when creating the droplet or
instance, replacing the two values at the top:

```yaml
#cloud-config
package_update: true
packages: [git, curl, ca-certificates]
write_files:
  - path: /etc/keel.conf
    content: |
      KEEL_DOMAIN=notes.example.com
      KEEL_OWNER_EMAIL=you@example.com
runcmd:
  - curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/deploy/cloud-init.sh | bash
```

That installs Docker, fetches Keel, generates secrets, gets a Let's Encrypt
certificate through Caddy, and starts everything with `restart: unless-stopped`
so it survives reboots. Point an A record at the machine first - certificate
issuance needs DNS to resolve.

### Manually

```bash
git clone https://github.com/AES256Afro/Keel && cd Keel
cp .env.prod.example .env.prod   # fill in your domain, owner email, secrets
docker compose -f docker-compose.prod.yml up -d --build
```

The production stack adds Caddy for automatic HTTPS and runs the app under
[Litestream](https://litestream.io), which streams every SQLite write to
Cloudflare R2 as it happens. A destroyed VPS costs you nothing: the entrypoint
restores from the replica on a fresh host.

Updating:

```bash
./scripts/deploy/vps-update.sh main
```

---

## Containers

The image at the repository root builds for any container host.

```bash
docker build -t keel .
docker run -d -p 3000:3000 -v keel-data:/data \
  -e KEEL_OWNER_EMAIL=you@example.com keel
```

It runs as a non-root user, carries no build tooling, and has a `HEALTHCHECK`
that orchestrators can use.

**Choose your database at build time.** The Prisma client is generated for one
dialect, so the image is built for one:

```bash
docker build -t keel .                                     # SQLite on /data
docker build -t keel --build-arg DB_PROVIDER=postgresql .  # managed Postgres
```

The entrypoint refuses to start on a mismatch rather than failing at the first
query.

| Platform | Notes |
| --- | --- |
| **DigitalOcean App Platform** | Build from the Dockerfile. Attach a managed Postgres and build with `DB_PROVIDER=postgresql` - App Platform containers have no persistent disk. |
| **AWS App Runner / ECS Fargate** | Same: no durable local disk, so use Postgres (RDS) and the Postgres build arg. |
| **Fly.io** | SQLite works well - attach a volume at `/data` and keep one machine. |
| **Railway / Render** | Postgres build. Both provide the database. |
| **Kubernetes** | Either. For SQLite use a StatefulSet with one replica and a PVC at `/data`. |

**One process, one database.** Keel keeps some state in memory - pending
two-factor sign-ins, desktop handoffs, rate-limit counters. Running two replicas
against one database will produce confusing sign-in failures. Scale up, not out;
this is a personal workspace, not a multi-tenant service.

---

## Azure

**Azure Container Apps** is the best fit: it runs the image directly, scales to
zero, and gives you a TLS hostname without managing certificates.

```bash
RG=keel
az group create -n $RG -l westeurope

# Postgres, because Container Apps have no durable local disk.
az postgres flexible-server create -g $RG -n keel-db \
  --tier Burstable --sku-name Standard_B1ms --version 16 \
  --database-name keel --public-access 0.0.0.0

az containerapp env create -g $RG -n keel-env -l westeurope

az containerapp create -g $RG -n keel --environment keel-env \
  --source . --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --secrets db-url="postgresql://USER:PASS@keel-db.postgres.database.azure.com/keel?sslmode=require" \
  --env-vars DATABASE_URL=secretref:db-url \
             KEEL_DB_PROVIDER=postgresql \
             KEEL_OWNER_EMAIL=you@example.com \
             KEEL_ALLOWED_EMAILS=you@example.com \
             KEEL_DISABLE_SIGNUP=1
```

`--min-replicas 1 --max-replicas 1` is deliberate - see the one-process note
above. Build the image with `--build-arg DB_PROVIDER=postgresql`; if you use
`--source .` let Azure build it and set `KEEL_DB_PROVIDER=postgresql` so the
entrypoint's guard agrees.

**Azure App Service** also works (Web App for Containers, same image and
environment). **Azure VM** is just the [VPS](#vps) path.

Set `KEEL_WEBAUTHN_RP_ID` and `KEEL_WEBAUTHN_ORIGIN` to the hostname Azure
gives you, or security keys won't register.

---

## Cloudflare

Being straight about this one: **Keel does not run on Cloudflare Workers
today**, and getting it there is a project, not a configuration change.

Why:

- The app is a Node server. It uses `fs` for backups, `child_process` for the
  tunnel manager, and `crypto.scryptSync` for backup encryption - none of which
  exist on Workers.
- Prisma against a network Postgres from Workers needs Hyperdrive plus the
  driver adapters; the local SQLite path can't work at all.
- Some state is in-process (pending 2FA, rate limits). Workers isolates are not.

What *does* work on Cloudflare today, and is what the production instance
already uses:

- **Cloudflare Tunnel** - expose a home server or VPS with no open ports, with
  Cloudflare's edge in front. Managed from Settings.
- **Cloudflare R2** - off-site backup storage, both for Litestream's continuous
  replication and for the app's own encrypted snapshots.
- **Cloudflare DNS + proxy** in front of a VPS.

If full Cloudflare hosting matters, the honest route is:

1. Move the Node-only pieces behind an interface (backup storage → R2 API
   instead of `fs`; drop the in-app tunnel manager, which is meaningless there).
2. Move in-memory state into the database.
3. Switch to Postgres via Hyperdrive, or to D1 with the Prisma D1 adapter.
4. Adopt [OpenNext](https://opennext.js.org/cloudflare) for the Next.js runtime.

That's a milestone, not a checkbox - it's in [ROADMAP.md](ROADMAP.md) under M6.

---

## After any install

1. **Register the first account.** It becomes the instance owner.
2. **Lock the instance down** - Settings → Access control: add your email to the
   allowlist and disable sign-ups. On a public host, set `KEEL_ALLOWED_EMAILS`
   and `KEEL_DISABLE_SIGNUP=1` in the environment instead, so a compromised
   session can't widen access.
3. **Turn on backups** - Settings → Backups. If you enable encryption, save the
   passphrase somewhere else; without it a backup cannot be restored.
4. **Add a security key** - Settings → Security keys. Needs HTTPS or localhost.

## Environment reference

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | `file:/path/keel.db` or `postgresql://…`. Decides the dialect. |
| `PORT` / `HOSTNAME` | Listen address. `HOSTNAME=0.0.0.0` in containers. |
| `KEEL_OWNER_EMAIL` | Instance owner(s). **Set this in production.** |
| `KEEL_ALLOWED_EMAILS` | Only these accounts may sign in. Wins over the in-app setting. |
| `KEEL_DISABLE_SIGNUP` | `1` refuses new accounts. Wins over the in-app setting. |
| `KEEL_BACKUP_PASSPHRASE` | Passphrase for scheduled encrypted backups. |
| `KEEL_BACKUP_DIR` | Where backups are written. Also the root non-owners are confined to. |
| `KEEL_WEBAUTHN_RP_ID` / `_ORIGIN` | Must match the HTTPS host users reach. |
| `KEEL_SITE_HOSTS` | Hosts that serve the public site instead of the notebook. |
| `KEEL_COOKIE_DOMAIN` | Shares the session across subdomains. Read the security note first. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google sign-in and Drive backups. |
| `MS_CLIENT_ID` / `_SECRET` | OneDrive backups. |
| `LITESTREAM_R2_*` | Continuous SQLite replication to R2. |
| `KEEL_TRUST_PROXY` | `1` when behind a reverse proxy, so rate limits key on the real client IP. |
