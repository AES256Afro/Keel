# Google sign-in & cloud backups (Google Drive / OneDrive)

Both features are built in - they just need OAuth credentials you create once
(free). Keel never sees more than it should: Drive access is limited to files
Keel created itself (`drive.file` scope), and OneDrive access is limited to
Keel's own App Folder (`Files.ReadWrite.AppFolder`). Workspace refresh tokens
and storage credentials are encrypted at rest before they are stored in the
local Keel database.

## Google (sign-in + Drive backups) - ~5 minutes

1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the
   app name and your email, add yourself as a test user, save. (For personal
   use it can stay in "Testing" forever.)
3. **APIs & Services → Library**: enable **Google Drive API**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs - add all three:
     - `http://localhost:3000/api/auth/google/callback`
     - `http://localhost:3000/api/account/google/callback`
     - `http://localhost:3000/api/cloud/callback/google`
     - (add the same three for any other port/host you serve Keel on)
5. In Keel, open **Settings -> Integrations -> Google**. The panel shows the
   exact callback URLs for this server. Compare them with the Google console,
   then paste the Client ID and Client Secret and save.
6. Keel marks the pair **Saved, not verified**. Complete **Connect Google
   Drive** from the signed-in workspace to prove Google accepts it. No restart
   is needed. To test Google sign-in itself, first confirm password sign-in
   remains available, then use a separate private or incognito window so the
   Settings session is not replaced.

The secret is write-only in Settings. Keel stores managed credentials encrypted
with a host key kept outside the database and never sends the saved value back
to the browser. Operators may instead set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in the server environment; environment values lock the
Google panel so browser settings cannot override them.

Google sign-in never takes over a password account merely because the email
strings match. This fail-closed behavior prevents someone from pre-registering
another person's address and retaining password access after that person uses
Google. A signed-in user may instead choose **Link Google sign-in** in Settings.
That explicit flow is bound to the current session, expires after five minutes,
can be used once, and requires Google's verified email to exactly match the
current Keel account. It adds Google without removing the password or any
security-key requirement.

## Cloudflare R2 backups - ~3 minutes

R2 is S3-compatible object storage. In the Cloudflare dashboard → **R2**: create
a bucket, then **Manage API Tokens → Create** an *Object Read & Write* token.
In Keel → Settings → *Cloud backups* → **Cloudflare R2**, paste your account
ID, bucket name, and the token's access key + secret. Every backup then uploads
to the `keel-backups/` prefix in that bucket, and you can restore from there.

(This is separate from Litestream, which replicates the whole database
continuously on the always-on VPS - see docs/HOSTING.md.)

## Remote access without a server (Cloudflare Tunnel)

Running Keel locally? Settings → *Remote access (Cloudflare Tunnel)* can start
a **quick tunnel** (instant public URL) or a **named tunnel** (your own domain)
straight from the UI, as long as `cloudflared` is installed. Lock the instance
down first (Settings → *Registration and sign-in*).

## OneDrive backups - ~5 minutes

1. Go to <https://portal.azure.com> → **Microsoft Entra ID → App registrations
   → New registration**.
   - Supported account types: *Accounts in any organizational directory and
     personal Microsoft accounts*.
   - Redirect URI: platform **Web**, value
     `http://localhost:3000/api/cloud/callback/onedrive`.
2. **Certificates & secrets → New client secret** - copy the secret **value**.
3. In Keel, open **Settings -> Integrations -> Microsoft**. Copy the exact
   OneDrive and OneNote callback URLs into the Entra registration, paste the
   Application (client) ID and secret value, and save.
4. Complete **Connect OneDrive** or **Connect OneNote** to verify the saved
   pair. No restart is needed.

The Microsoft secret is also write-only and encrypted with the host key.
`MS_CLIENT_ID` and `MS_CLIENT_SECRET` remain supported as environment-locked
operator overrides.

Drive and OneNote connection callbacks are bound on the server to the exact
signed-in session, user, active workspace, provider, and connection purpose.
The random state expires after ten minutes, is stored only as a digest, and can
be consumed once. Switching sessions or workspaces in another tab makes the
callback fail safely instead of writing a refresh token into a different
workspace. Cancelling at the provider also consumes the state.

## Managed-secret key and recovery

For SQLite, Keel creates `.keel-server-secrets.key` beside the database and
restricts it to mode `0600` on macOS and Linux. The key is intentionally
outside the database, so a copied database does not reveal usable managed
credentials. It protects server OAuth client credentials, Google/OneDrive/
OneNote refresh tokens, Azure SAS URLs, R2 keys, and the managed scheduled-
backup passphrase. Legacy plaintext cloud rows are encrypted lazily on first
use when the host key is available; new or rotated credentials are encrypted
immediately. Keep the key private and retain it separately when you need those
credentials to survive a full machine recovery. Never commit it or place it in
a database backup.

For PostgreSQL, set `KEEL_SERVER_SECRET_KEY` in the host or container secret
store before saving OAuth credentials in Settings. It must be exactly 32 bytes,
encoded as 64 hexadecimal characters, 43-character unpadded base64url, or
44-character standard base64. Keep the same value for the life of the managed
credentials. Losing or changing it leaves notes usable but makes affected cloud
integrations and other managed secrets unavailable until the key is recovered
or the credential is replaced. A raw database backup does not contain usable
secrets without the sidecar or environment key.

## How it behaves once connected

- Every backup - manual **Back up now** and the automatic schedule - is
  written locally *and* uploaded to your drive ("Keel Backups" folder on
  Google Drive; `Apps/Keel` App Folder on OneDrive).
- Encrypted backups stay encrypted in the cloud (`.keelbak`, AES-256-GCM).
- Settings lists your cloud backups; **Restore** downloads and restores one
  non-destructively on any machine - that's your disaster-recovery path.
- A failed upload never breaks the local backup; the error shows in Settings.
- Disconnecting removes only Keel's access; uploaded files stay in your drive.

## Desktop app

**Google sign-in in the desktop app opens your system browser.** Google
refuses OAuth inside embedded app windows ("this browser or app may not be
secure"), so clicking **Continue with Google** in the app launches your default
browser for the Google step, then hands the signed-in session back to the app
window automatically - you land signed in, and stay signed in across launches.
No extra configuration; it uses the same `localhost:3000` redirect URIs.

The desktop app talks to `http://localhost:3000`:

- If your Keel server is already running there (Windows service or
  `npm run dev`), the app attaches to it and uses that server&apos;s Integrations
  settings or environment overrides.
- If nothing is running, the app starts its own server on port 3000. Configure
  Google or Microsoft from **Settings -> Integrations** in the app. The same
  registered redirect URIs work because the port is still 3000.
- Only if port 3000 is occupied by a different application does the app fall
  back to a random port - everything works there except Google/OneDrive
  OAuth (whose redirect URIs are port-specific).
