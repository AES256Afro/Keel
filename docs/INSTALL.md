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
boot. Re-running it updates in place and never overwrites your `.env`. Local
registration stays open by default. The installer does not require an owner
email because server ownership is claimed separately after registration.

Options:

```bash
./install.sh --dir ~/notes --port 8080 --service --yes
```

`--owner you@example.com` remains accepted and validated for older scripts, but
it no longer selects an owner or affects registration. Open
`http://localhost:3000` and register the account you want to operate the server.
Registration remains open. In Welcome or Settings, open **Claim this server**,
generate the one-use claim command, copy it exactly, and run it in Terminal.
Complete the fresh operating-system administrator authorization requested by
the command. The browser never asks for the operating-system password, and Keel
never receives or stores it.
Claiming unlocks the admin portal, registration controls, and tunnel controls.
It does not close registration. Use Settings -> Registration and sign-in when
you decide to restrict or close this server.

If a Keel 1.2.1 CLI install says sign-ups are disabled before any account
exists, re-run the current installer. Keel 1.2.2 recognizes the exact affected
empty local configuration and removes the accidental hard signup stop. The
installer restarts a known managed service automatically; if you started Keel
manually, stop that process and start it again. Register normally, then generate
the one-use claim command from Welcome or Settings.

### Windows

```powershell
irm https://raw.githubusercontent.com/AES256Afro/Keel/main/install.ps1 | iex
```

Or with options:

```powershell
.\install.ps1 -Dir C:\Keel -Port 3000 -Service
```

`-Service` registers a Scheduled Task that starts Keel at logon and restarts it
if it crashes. Registration stays open until the owner changes it in Settings.
After registering the intended account, open **Claim this server** in Welcome
or Settings, generate the one-use command, copy it exactly, and run it in
PowerShell. Complete the fresh Windows administrator authorization it requests.

### Desktop app (no terminal)

```bash
npm run desktop:build
```

Builds the desktop package for the current operating system in `dist-desktop/`:
a macOS `.dmg`, a Windows `.exe`, or a Linux `AppImage` and `.deb`. GitHub's
Desktop builds workflow produces the published Windows and Linux downloads.
The desktop app runs its own server on localhost, stores data
in your user profile, and keeps running in the background so scheduled backups
still happen after you close the window. Because this packaged server is
loopback-only, the first local workspace owner receives instance controls
automatically. The desktop app does not ask for a terminal claim command.

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

**Cloudflare Tunnel.** Reachable from anywhere, so claim the server and lock it
down first: Settings -> Registration and sign-in -> add only your own email and
turn off **Allow new registrations**. The tunnel controls are in Settings once
you are the claimed instance owner.

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
      KEEL_ADMIN_EMAIL=you@example.com
runcmd:
  - curl -fsSL https://raw.githubusercontent.com/AES256Afro/Keel/main/deploy/cloud-init.sh | bash
```

That installs Docker, fetches Keel, generates secrets, gets a Let's Encrypt
certificate through Caddy, and starts everything with `restart: unless-stopped`
so it survives reboots. Point an A record at the machine first - certificate
issuance needs DNS to resolve.

The generated public deployment starts with registration hard-disabled. To
create the administrator, stop Caddy first so the registration endpoint cannot
be reached from the internet. Then use SSH port forwarding to reach Keel
privately, temporarily remove `KEEL_DISABLE_SIGNUP` from
`/opt/keel/.env.prod`, and recreate only the `keel` service:

```bash
cd /opt/keel
sudo docker compose -f docker-compose.prod.yml stop caddy
sudo sed -i '/^KEEL_DISABLE_SIGNUP=/d' .env.prod
sudo docker compose -f docker-compose.prod.yml -f docker-compose.bootstrap.yml \
  up -d --force-recreate keel
```

From your laptop, open a private tunnel with
`ssh -L 3000:127.0.0.1:3000 <ssh-user>@<server-ip>`, visit
`http://localhost:3000`, and register the intended account. In **Claim this
server**, open **Hosted or managed PostgreSQL server**. Read the generated
write-only bootstrap value on the Linux host:

```bash
sudo sed -n 's/^KEEL_OWNER_BOOTSTRAP_TOKEN=//p' /opt/keel/.env.prod
```

Paste it into the hosted claim field. The value is compared in memory and is
never stored in Keel. After the claim succeeds, remove the host value with
`sudo sed -i '/^KEEL_OWNER_BOOTSTRAP_TOKEN=/d' /opt/keel/.env.prod`, then
recreate Keel while restoring the hard signup stop below.

Then restore the hard stop and reopen the public proxy:

```bash
printf '\nKEEL_DISABLE_SIGNUP=1\n' | sudo tee -a /opt/keel/.env.prod >/dev/null
sudo docker compose -f /opt/keel/docker-compose.prod.yml up -d --force-recreate keel
sudo docker compose -f /opt/keel/docker-compose.prod.yml start caddy
```

Do not restart Caddy until the hard signup stop is restored.
Recreating Keel from `docker-compose.prod.yml` alone also removes the temporary
host port. If port 3000 is already used on the server, prefix the bootstrap
command with `KEEL_BOOTSTRAP_PORT=3100` and forward that server port instead.

### Manually

```bash
git clone https://github.com/AES256Afro/Keel && cd Keel
cp .env.prod.example .env.prod   # application, access, and backup settings
cp .env.caddy.example .env.caddy # public hostname only, never app secrets
docker compose -f docker-compose.prod.yml up -d --build
```

The production stack adds Caddy for automatic HTTPS and runs the app under
[Litestream](https://litestream.io), which streams every SQLite write to
Cloudflare R2 as it happens. A destroyed VPS costs you nothing: the entrypoint
restores from the replica on a fresh host.

Use Docker Compose 2.30 or newer. The stack reads env files in raw mode, so a
literal `$` in a password or token is preserved. Caddy receives only
`KEEL_DOMAINS` from `.env.caddy`; the app secrets in `.env.prod` are never
injected into the reverse-proxy container.

Updating:

```bash
./scripts/deploy/vps-update.sh main
```

---

## Containers

The image at the repository root builds for any container host.

```bash
docker build -t keel .
docker run -d -p 127.0.0.1:3000:3000 -v keel-data:/data \
  -e KEEL_CLAIM_REQUIRED=1 keel
```

It runs as a non-root user, carries no build tooling, and has a `HEALTHCHECK`
that orchestrators can use. The supported Compose path includes the documented
container claim command; with bare `docker run`, use an operator-managed owner
override or an orchestrator-specific one-off root exec only after reviewing the
same container claim boundary.

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

# One stable 32-byte master key encrypts credentials saved from Settings,
# including OAuth, workspace cloud connections, and scheduled-backup secrets.
# Keep it in the Container Apps secret store and retain a private recovery copy.
KEEL_MANAGED_SECRET_KEY="$(openssl rand -hex 32)"
KEEL_OWNER_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"

az containerapp create -g $RG -n keel --environment keel-env \
  --source . --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --secrets db-url="postgresql://USER:PASS@keel-db.postgres.database.azure.com/keel?sslmode=require" \
            server-secret-key="$KEEL_MANAGED_SECRET_KEY" \
            owner-bootstrap-token="$KEEL_OWNER_BOOTSTRAP_TOKEN" \
  --env-vars DATABASE_URL=secretref:db-url \
             KEEL_DB_PROVIDER=postgresql \
             KEEL_SERVER_SECRET_KEY=secretref:server-secret-key \
             KEEL_OWNER_BOOTSTRAP_TOKEN=secretref:owner-bootstrap-token \
             KEEL_ALLOWED_EMAILS=you@example.com \
             KEEL_DISABLE_SIGNUP=1
unset KEEL_MANAGED_SECRET_KEY
unset KEEL_OWNER_BOOTSTRAP_TOKEN
```

This starts closed. Create the administrator through a private connection,
paste the Container Apps bootstrap secret into Keel's write-only hosted claim
field, then remove the `KEEL_OWNER_BOOTSTRAP_TOKEN` environment reference and
the `owner-bootstrap-token` platform secret. Restore `KEEL_DISABLE_SIGNUP=1`
before making the endpoint public.
Keep `server-secret-key` unchanged across revisions. Changing or losing it makes
GUI-managed credentials unreadable until the owner enters the affected values
again; it does not encrypt note content.

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

## After a server, source, or container install

1. **Register an account.** Registration starts open on local installs.
2. **Generate a one-use claim command.** In Welcome or Settings, open **Claim
   this server**, then copy the exact command into a terminal on the machine
   running Keel. Complete the fresh OS administrator authorization it requests.
   The browser never handles the OS password. Claiming and registration policy
   are separate.
3. **Lock the instance down when you want to** - Settings -> Registration and
   sign-in: add the accounts that should remain able to sign in and turn off
   **Allow new registrations**.
   On a public host, create the administrator privately before exposure, then
   set `KEEL_ALLOWED_EMAILS` and `KEEL_DISABLE_SIGNUP=1` in the environment so
   a compromised session cannot widen access.
4. **Turn on backups** - Settings -> Backups. If you enable automatic
   encryption, the instance owner can save a write-only passphrase under
   **Scheduled backup secret**. A host operator can instead use
   `KEEL_BACKUP_PASSPHRASE` as a locked override. Keep a separate copy in a
   password manager; without it a backup cannot be restored.
5. **Add a security key** - Settings -> Security keys. Needs HTTPS or localhost.

The packaged desktop app skips step 2 because its loopback-only server assigns
instance controls to the first local workspace owner automatically. Registration
and backup choices remain explicit in Settings.

## Environment reference

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | `file:/path/keel.db` or `postgresql://…`. Decides the dialect. |
| `PORT` / `HOSTNAME` | Listen address. `HOSTNAME=0.0.0.0` in containers. |
| `KEEL_CLAIM_REQUIRED` | Installer and diagnostic marker recording the expected explicit claim flow. Unclaimed server, source, and container installs already fail closed; this marker does not grant or revoke ownership. |
| `KEEL_OWNER_USER_ID` | Highest-priority operator override pinned to one stable database User.id. Use for automation, not an email address. |
| `KEEL_OWNER_BOOTSTRAP_TOKEN` | Hosted/PostgreSQL claim secret. Generate at least 32 random bytes, paste it once into the write-only claim field, then remove it from the host and restart. Keel never stores or returns it. |
| `KEEL_OWNER_EMAIL` | Deprecated compatibility selector. It can bind only a matching Google-verified account and persists that stable User.id; a password-created account never gains owner authority from email alone. |
| `KEEL_ALLOWED_EMAILS` | Only these accounts may sign in. Wins over the in-app setting. |
| `KEEL_DISABLE_SIGNUP` | `1` unconditionally refuses new accounts. Enable it after bootstrap. Wins over the in-app setting. |
| `KEEL_BACKUP_PASSPHRASE` | Host override for scheduled encrypted backups. A nonempty value locks the write-only Settings field. |
| `KEEL_BACKUP_DIR` | Where backups are written. Workspace owners who are not the instance owner cannot choose a path outside this root. |
| `KEEL_WEBAUTHN_RP_ID` / `_ORIGIN` | Must match the HTTPS host users reach. |
| `KEEL_PUBLIC_URL` | Canonical external origin used for OAuth callbacks and absolute redirects. |
| `KEEL_SITE_HOSTS` | Hosts that serve the public site instead of the notebook. |
| `KEEL_SITE_NAME` / `_TAGLINE` / `KEEL_NOTES_URL` | Per-field host overrides for the optional built-in public site's name, tagline, and notebook link. Nonempty values lock only their matching Settings fields. |
| `KEEL_COOKIE_DOMAIN` | Shares the session across subdomains. Read the security note first. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google sign-in and Drive backups. Operator override for Settings -> Integrations; locks the Google panel. |
| `MS_CLIENT_ID` / `_SECRET` | OneDrive backups and OneNote. Operator override for Settings -> Integrations; locks the Microsoft panel. |
| `KEEL_SERVER_SECRET_KEY` | PostgreSQL master key for credentials saved from Settings, including OAuth, workspace cloud, and scheduled-backup secrets. Supply 32 bytes as hex or base64 from a host secret store; never put it in Git or database backups. SQLite creates a protected sidecar key instead. |
| `LITESTREAM_R2_*` | Continuous SQLite replication to R2. |
| `KEEL_TRUST_PROXY` | `1` when behind a reverse proxy, so rate limits key on the real client IP. |
| `KEEL_TRUSTED_PROXY_HOPS` | Number of trusted proxy hops used to select the client address. |
| `KEEL_SYNC_SECRET` | Secret header value for an external OneNote scheduler. |
| `KEEL_SUPERVISED` | `1` tells Keel that a service manager will bring it back after a GUI restart. |

After claiming the server, its owner can manage reasonable application-level
values in Settings: public-site branding, registration, OAuth credentials, and
the scheduled-backup passphrase. The **Effective server configuration** panel
shows the active database dialect, network posture, public origin, proxy state,
and storage limits without exposing secret values, database URLs, or absolute
host paths. Host routing, trust boundaries, process supervision, database
selection, and storage roots remain deployment controls.
