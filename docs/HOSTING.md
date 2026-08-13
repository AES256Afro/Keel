# Always-on Keel hosting

Keel is one Node.js application with one database. SQLite is the default for a
single-machine deployment. Use PostgreSQL on managed platforms that do not
provide durable local disk.

## Pick the exposure model first

| Who needs access? | Recommended route |
| --- | --- |
| Only this computer | Desktop package or local service |
| Only your own devices | Home server plus Tailscale Serve |
| People on a trusted LAN | Home server behind the LAN firewall |
| Specific accounts from anywhere | VPS or Cloudflare Tunnel with an allowlist |

The private route has fewer failure modes. Do not make Keel public solely to
avoid installing Tailscale on your own devices.

## Private home server with Tailscale

Install Keel on an always-on machine, then run:

```bash
tailscale serve --bg 3000
```

Tailscale provides an HTTPS hostname that is reachable only from the same
tailnet. Set the WebAuthn identity to that hostname:

```env
KEEL_PUBLIC_URL=https://noteserver.your-tailnet.ts.net
KEEL_WEBAUTHN_RP_ID=noteserver.your-tailnet.ts.net
KEEL_WEBAUTHN_ORIGIN=https://noteserver.your-tailnet.ts.net
KEEL_COOKIE_DOMAIN=
KEEL_TRUST_PROXY=1
```

Restart Keel and verify the HTTPS URL from another tailnet device. No public DNS
or router port-forward is required.

## Public VPS with Docker and Caddy

Use a current Debian or Ubuntu server with ports 80 and 443 available.

1. Point `notes.example.com` at the server.
2. Clone Keel. Copy `.env.prod.example` to `.env.prod` and
   `.env.caddy.example` to `.env.caddy`.
3. Replace every example value. Set the Caddy hostname in `.env.caddy`. Set the
   allowed accounts, closed sign-ups, public URL, and WebAuthn values before
   starting. Claim ownership through the token flow below.
4. Start the production stack:

```bash
git clone https://github.com/AES256Afro/Keel.git
cd Keel
cp .env.prod.example .env.prod
cp .env.caddy.example .env.caddy
docker compose -f docker-compose.prod.yml up -d --build
```

5. Confirm the application health through the final hostname:

```bash
curl -fsS https://notes.example.com/api/health
```

6. Register only the intended owner and create an encrypted test backup.

The production stack uses Caddy for HTTPS. It can also run the SQLite process
under Litestream for continuous replication to Cloudflare R2. Use Docker
Compose 2.30 or newer. Raw env-file parsing preserves literal `$` characters
in credentials. Caddy receives only `KEEL_DOMAINS` from `.env.caddy`; never put
application or backup secrets in that file. Keel alone receives `.env.prod`.

## Cloudflare options

Cloudflare can be used around Keel without moving the Node application into a
Worker:

- **DNS and proxy:** point a hostname at the VPS and use Full (strict) TLS.
- **Cloudflare Tunnel:** connect a home server or private origin without opening
  an inbound port. Restrict Keel accounts before publishing the hostname.
- **Cloudflare R2:** store encrypted snapshots or a Litestream replica away
  from the Keel host.

Keel does not run directly on Cloudflare Workers today. It uses a Node server,
filesystem operations for local backups, a Prisma database client, and some
process-local state.

## Database choice

### SQLite

Use one application replica and one persistent volume. SQLite in WAL mode is a
good fit for a personal or small-team workspace. Do not place the database on a
network filesystem that does not preserve SQLite locking semantics.

### PostgreSQL

Use PostgreSQL when the platform has ephemeral containers or supplies a managed
database. Build the matching image:

```bash
docker build --build-arg DB_PROVIDER=postgresql -t keel:postgres .
```

Set `KEEL_DB_PROVIDER=postgresql` and a PostgreSQL `DATABASE_URL`. The startup
guard refuses a mismatch between the image and database URL.

## Public deployment lockdown

Create the administrator over private access or verified Google sign-in, then
set these values before the first public request. An email allowlist alone does
not prove that a password-registration visitor owns that mailbox, and
`KEEL_DISABLE_SIGNUP=1` blocks every new account without exception.

The optional `docker-compose.bootstrap.yml` override binds Keel temporarily to
`127.0.0.1:3000`. It is not reachable from the network. Use the override only
while the public proxy is stopped, and forward the port from your laptop with
`ssh -L 3000:127.0.0.1:3000 <ssh-user>@<server-ip>` when creating the
administrator before public exposure.

If the public reverse proxy is already running, stop it or firewall ports 80
and 443 before temporarily allowing registration. Restore the hard signup stop
and recreate Keel without the bootstrap override before reopening the proxy.
Keeping an address unshared is not an access-control boundary.

```env
KEEL_ALLOWED_EMAILS=you@example.com
KEEL_DISABLE_SIGNUP=1
KEEL_PUBLIC_URL=https://notes.example.com
KEEL_WEBAUTHN_RP_ID=notes.example.com
KEEL_WEBAUTHN_ORIGIN=https://notes.example.com
KEEL_TRUST_PROXY=1
```

Only enable proxy trust when the trusted reverse proxy actually sets the client
address headers. An internet-facing Node port must not trust client-supplied
forwarding headers.

After private registration, generate a one-use token from **Claim this server**
and run it on the Linux Docker host. This proves Docker-daemon control without
pinning identity to an unverified password-form email:

```bash
sudo -k
sudo docker compose exec --user root -e KEEL_CONTAINER_CLAIM=1 keel npm run claim -- 'one-use-token'
```

Local and private-network installs use a different default: registration is
open until the claimed server owner turns off **Allow new registrations** in
Settings. Generate a five-minute, one-use command from **Claim this server**.
Running it requires fresh sudo authorization in a macOS or Linux server
terminal, or an Administrator PowerShell on Windows. It grants instance-owner
controls but does not silently change the registration policy.

After claiming, the owner can configure Google and Microsoft OAuth applications
in **Settings -> Integrations**. Client secrets are write-only in the browser
and managed secrets are encrypted with a host key outside the database.
Environment credentials remain available for deployments that manage secrets
externally, and lock the matching provider in Settings. Database, network,
proxy trust, cookie and WebAuthn identity, filesystem, and supervisor settings
remain terminal-only because a browser mistake there could disconnect the
server or weaken a host trust boundary.

SQLite keeps the managed-credential master key in a mode-`0600`
`.keel-server-secrets.key` file beside the database. Retain it separately from
database backups and never commit it. PostgreSQL deployments must provide a
stable 32-byte `KEEL_SERVER_SECRET_KEY` through the host or container secret
store. See [CLOUD.md](CLOUD.md#managed-secret-key-and-recovery) for accepted
encodings and recovery behavior.

## Update and recover

Before an update, confirm a recent backup exists and read the release notes.

```bash
git pull --ff-only
docker compose -f docker-compose.prod.yml up -d --build
```

Keel applies database migrations before serving. Check the container logs and
the public health endpoint after every update.

For disaster recovery, provision a new host, attach the backup or Litestream
configuration, restore the database, start Keel, and verify note content plus a
new backup. A green health endpoint proves the process and database respond. It
does not prove every note or attachment was recovered.

## Security keys

Enroll at least two WebAuthn security keys in Settings so one can be lost
without locking out the owner. WebAuthn requires HTTPS or localhost, and the
relying-party ID plus origin must match the browser hostname.
