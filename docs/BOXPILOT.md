# Deploying Keel from BoxPilot

BoxPilot is a point-and-click manager for a home Ubuntu server. It installs an
application from a catalog entry: a YAML manifest naming a **published, version-
pinned container image**, plus the ports, folders, and settings the owner is
allowed to choose. It pulls that image and runs it. It does not build from
source, and it does not clone repositories.

That single sentence is the whole gap, and it is already being closed on the
`keel-container-image` branch, which adds `.github/workflows/image.yml` to build
and push `ghcr.io/<owner>/keel` on the `v*` tags already being cut.

> **Correcting an earlier draft of this file.** It recommended publishing
> `Dockerfile.prod`, suggested BoxPilot generate `KEEL_SERVER_SECRET_KEY`, asked
> for three WebAuthn settings, and asked the health check to stay unhealthy
> during migrations. All four were wrong against the source; the sections below
> are the corrected versions. The advice about generating the secret key would
> have produced a key Keel rejects.

## Which image to publish

**`Dockerfile`, not `Dockerfile.prod`.**

`Dockerfile` says what it is in its own header: *"One image for every container
host: Docker Compose on a VPS, Azure Container Apps, AWS App Runner / ECS,
DigitalOcean App Platform, Fly, Railway, Render."* It is three-stage, ships no
compilers, dev dependencies, or source, runs as `node`, exposes 3000, and picks
its migration set from `DATABASE_URL`. That is exactly the shape a managed
platform wants.

`Dockerfile.prod` is the single-stage image built for `docker-compose.prod.yml`:
it bundles Litestream and is meant to sit behind that stack's Caddy. Publishing
it for BoxPilot would ship the two things BoxPilot explicitly does not use.

It is also the easier build of the two. `Dockerfile.prod` pins a Litestream
`.deb` per `TARGETARCH` with per-arch checksums; `Dockerfile` has no
architecture-specific step at all, so a two-platform build needs nothing beyond
naming the platforms.

## What the workflow needs to guarantee

1. **Immutable version tags.** BoxPilot pins the exact tag in the manifest and
   compares the installed reference against the catalog's to decide whether an
   update exists. A moving `latest` breaks that comparison and makes rollback
   meaningless. Publish `latest` as well if it is useful elsewhere; the manifest
   will not reference it.
2. **Publicly pullable, unauthenticated.** BoxPilot's deployer runs
   `docker compose pull` on the owner's server with no registry credentials. A
   GHCR package defaults to private on first publish and has to be made public
   once, by hand, after the first successful run.
3. **`linux/amd64` at minimum**, `linux/arm64` as well if Keel should install on
   a Raspberry Pi or similar.
4. **Tags stay put.** Once `1.2.6` is published it must never be rebuilt to mean
   something else, or a rollback silently restores different code than it says.

## How BoxPilot will run it

Two deliberate differences from `docker-compose.prod.yml`. Both are about the
platform rather than about Keel.

**No Caddy.** BoxPilot terminates TLS itself: it publishes an app on the owner's
tailnet through Tailscale Serve, which supplies a real certificate for a
`*.ts.net` name, or exposes a port on the LAN. A second reverse proxy competing
for 80 and 443 with everything else on the box is a problem, not a feature. The
manifest runs the `keel` service alone.

**No Litestream by default.** BoxPilot takes its own consistent backups: it
stops the container, archives the data directory, restarts it, records a
checksum, and can rehearse a restore on a schedule to prove the archive still
opens. The entrypoint already gates replication on `LITESTREAM_R2_BUCKET` and
`LITESTREAM_R2_ACCESS_KEY_ID` being set, so leaving them unset is a supported
path and nothing needs changing. An owner who wants R2 as well can fill them in.

State lives in one place, which is what makes the backup work:

| Path | Holds |
| --- | --- |
| `/data/keel.db` | the SQLite database |
| `/data/uploads` | uploaded files (`NOPIN_UPLOAD_DIR`) |
| `/data/backups` | Keel's own scheduled snapshots (`KEEL_BACKUP_DIR`) |

One volume at `/data` therefore captures everything.

## Settings

BoxPilot renders a form from the manifest and writes the answers to a `0600` env
file. Fields marked secret are never shown again after saving and never appear
in a job record or in a backup of the settings database.

**`KEEL_PUBLIC_URL` is the one address setting.** Keel already designed away the
failure an earlier draft of this document worried about: the WebAuthn routes
pass `publicOrigin(req)`, which returns `KEEL_PUBLIC_URL` when set, and the RP
ID is derived from it. Setting that single variable covers the origin and the RP
ID together; there is no way for them to disagree. BoxPilot knows the address
because it assigned it, so the manifest sets it from the chosen exposure.

**`KEEL_TRUST_PROXY` should be on when published through Tailscale Serve.**
Without it Keel treats every caller as unidentified and falls back to per-account
rate limits rather than per-address ones. That is safe by design rather than
broken, but a proxied install should have it set.

**Do not generate `KEEL_SERVER_SECRET_KEY`.** `src/lib/server-secrets.ts` sets
`KEY_BYTES = 32` and refuses anything that does not decode to exactly 32 bytes.
BoxPilot's `generateSecret` produces **24** bytes, so wiring it to `generate:
true` yields a key Keel rejects at boot. It is also unnecessary here: on SQLite
the managed-secret key lives in a `0600` sidecar beside the database, and the
environment variable is only required for managed credentials on PostgreSQL. If
an owner ever needs one, they generate it themselves with `openssl rand -hex 32`
and paste it into a secret field.

**Left off unless asked for:** `GOOGLE_*` and `MS_CLIENT_*` (OAuth),
`KEEL_SYNC_SECRET`, `KEEL_SITE_*`, `KEEL_COOKIE_DOMAIN`, and
`KEEL_OWNER_BOOTSTRAP_TOKEN`, which is a hosted-claim mechanism a single-owner
home install does not need.

## Health

`src/app/api/health` is what the manifest polls, and it is already correct for a
managed install. The entrypoint runs migrations and only then reaches
`exec node scripts/start.mjs`, so nothing is listening to answer early - an
earlier draft asked for a guarantee the ordering already provides.

The one property worth preserving: health has to answer on the container's own
loopback as well as its bridge address. The `HOSTNAME` note in the Dockerfiles
describes exactly the failure otherwise - Docker's default `HOSTNAME` is the
container ID, the server binds only `eth0`, loopback refuses, and the health
check hangs forever.

## The open question

BoxPilot publishes at a Tailscale name such as `keel.tailnet-name.ts.net`, so
that is what `KEEL_PUBLIC_URL` becomes. WebAuthn is strict about the RP ID
matching the origin, and `.ts.net` is on the public suffix list. If passkeys
register and verify under such a hostname, this is settled. If they do not, it
is worth knowing before an owner registers a passkey they cannot use. Password
sign-in is unaffected either way.

## When the image publishes

The BoxPilot side is one manifest file and no code: catalog entry, port 3000,
one volume at `/data`, the settings above, and the health check. Version updates
then arrive by bumping the pinned tag, and BoxPilot's update flow takes a data
checkpoint first and can put the previous version back afterwards.
