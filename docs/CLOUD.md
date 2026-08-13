# Google sign-in & cloud backups (Google Drive / OneDrive)

Both features are built in - they just need OAuth credentials you create once
(free). Keel never sees more than it should: Drive access is limited to files
Keel created itself (`drive.file` scope), and OneDrive access is limited to
Keel's own App Folder (`Files.ReadWrite.AppFolder`). Refresh tokens are stored
in your local Keel database only.

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
     - `http://localhost:3000/api/cloud/callback/google`
     - (add the same pair for any other port/host you serve Keel on)
5. Copy the Client ID and Client Secret into `.env`:

   ```env
   GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="..."
   ```

6. Restart Keel. The login page now shows **Continue with Google**, and
   Settings → *Cloud backups* shows **Connect Google Drive**.

Google accounts and password accounts with the same email are linked
automatically - signing in with Google on an existing email attaches the
Google identity to that account.

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
down first (Settings → *Access control*).

## OneDrive backups - ~5 minutes

1. Go to <https://portal.azure.com> → **Microsoft Entra ID → App registrations
   → New registration**.
   - Supported account types: *Accounts in any organizational directory and
     personal Microsoft accounts*.
   - Redirect URI: platform **Web**, value
     `http://localhost:3000/api/cloud/callback/onedrive`.
2. **Certificates & secrets → New client secret** - copy the secret **value**.
3. Copy into `.env`:

   ```env
   MS_CLIENT_ID="<Application (client) ID>"
   MS_CLIENT_SECRET="<secret value>"
   ```

4. Restart Keel, then Settings → *Cloud backups* → **Connect OneDrive**.

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
  `npm run dev`), the app attaches to it - **the server's `.env` applies**,
  using the same redirect URIs you already registered.
- If nothing is running, the app starts its own server on port 3000. A
  standalone Next.js server does **not** read a project `.env`, so the embedded
  server gets its credentials from `keel.env` in the app's data folder
  (`%APPDATA%\Keel\keel.env` on Windows, `~/.config/Keel/keel.env` on
  Linux). The app **creates this file for you on first launch** with commented
  placeholders - open it, uncomment the `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` lines, paste your values, then fully close and reopen
  Keel. "Continue with Google" appears. The same registered redirect URIs
  work, since the port is still 3000.
- Only if port 3000 is occupied by a different application does the app fall
  back to a random port - everything works there except Google/OneDrive
  OAuth (whose redirect URIs are port-specific).
