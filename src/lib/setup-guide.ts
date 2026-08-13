// The setup guide: everything Keel can do that needs something from outside,
// described as "what you get, what it needs, exactly where to get it".
//
// This registry is the single source of truth for that story. The /setup page
// renders all of it with live detected status; SetupHint drops a breadcrumb
// wherever a feature is blocked ("this needs X - here's the trail to X"),
// always pointing back here rather than repeating instructions ad hoc.
//
// The writing rules for this file, because the copy IS the feature:
//   • Name the exact page in the external console and link straight to it -
//     "Google Cloud Console → Credentials" with the URL, never "your provider".
//   • Warn about the traps we've actually hit (the R2 token page shows THREE
//     values and the account ID is the most prominent and the wrong one).
//   • Every secret says where it goes: an env var on the server, or a field in
//     Settings after signing in. Nothing assumes prior knowledge.

import { keelFlag } from "@/lib/env";
import { getBackupPassphraseStatus } from "@/lib/instance-settings";
import { googleConfigured, microsoftConfigured } from "@/lib/oauth";

export type CapabilityState = "ready" | "action-needed" | "optional";

export interface SetupNeed {
  /** The thing itself: "OAuth client ID". */
  name: string;
  /** One sentence of plain language: what this is and why it exists. */
  what: string;
  /** The exact external page that hands it out. */
  where: { label: string; url: string };
  /** Numbered, follow-along steps. Write for someone's first time. */
  steps: string[];
  /** Where the value goes once you have it. */
  destination: string;
}

export interface Capability {
  key: string;
  title: string;
  /** What you get out of setting this up - the reason to bother. */
  payoff: string;
  group: "Sign in" | "Keep your data safe" | "Bring content in" | "Go online" | "Move & update";
  needs: SetupNeed[];
  /** Rendered when the capability is ready. */
  readyLine: string;
}

/** Deep links, kept together so a moved console page is a one-line fix. */
export const LINKS = {
  googleCredentials: "https://console.cloud.google.com/apis/credentials",
  googleNewProject: "https://console.cloud.google.com/projectcreate",
  entraRegistrations:
    "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  azureStorageAccounts:
    "https://portal.azure.com/#browse/Microsoft.Storage%2FStorageAccounts",
  r2Dashboard: "https://dash.cloudflare.com/?to=/:account/r2/overview",
  r2ApiTokens: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
  cloudflareTunnels: "https://one.dash.cloudflare.com/?to=/:account/networks/tunnels",
} as const;

export function buildCapabilities(baseUrl: string): Capability[] {
  const callback = (path: string) => `${baseUrl}${path}`;
  return [
    {
      key: "google-signin",
      title: "Sign in with Google",
      payoff:
        "One-tap sign-in with the Google account you already have - no separate password to remember. (Password sign-in always works without any setup.)",
      group: "Sign in",
      readyLine: "Google sign-in is configured on this server.",
      needs: [
        {
          name: "Google OAuth client ID and secret",
          what: "A free credential pair that lets this Keel server ask Google “who is this?” when you click Sign in with Google.",
          where: { label: "Google Cloud Console → APIs & Services → Credentials", url: LINKS.googleCredentials },
          steps: [
            `If you've never used Google Cloud: create a project first (any name - "Keel" is fine).`,
            `On the Credentials page, click “+ Create credentials” → “OAuth client ID”.`,
            `If asked to configure a consent screen: choose External, fill in only the app name and your email, and skip every optional section.`,
            `Application type: “Web application”.`,
            `Under “Authorized redirect URIs”, add exactly: ${callback("/api/auth/google/callback")}`,
            `Add the account-link redirect too: ${callback("/api/account/google/callback")}`,
            `Click Create. Copy both values from the dialog - the Client ID (ends in .apps.googleusercontent.com) and the Client secret (starts with GOCSPX-).`,
          ],
          destination:
            "Settings -> Integrations -> Google. Paste both values and save; no server restart is needed. Server environment values remain a locked operator override.",
        },
      ],
    },
    {
      key: "backup-local",
      title: "Local snapshots",
      payoff:
        "Encrypted snapshot files on this machine - the baseline safety net. Works out of the box; this entry mostly tells you where things actually live.",
      group: "Keep your data safe",
      readyLine: "Snapshots work out of the box - Settings → Backups → “Back up now”.",
      needs: [
        {
          name: "Nothing to obtain",
          what: "Your notes live in one SQLite file; pasted images live inside that same database, so one file really is everything. Snapshots are written next to it.",
          where: { label: "Settings → Backups & data safety", url: "/settings" },
          steps: [
            "Your database and backup folder locations are shown on the Welcome page and below on this page.",
            "Before your first real backup, the instance owner should open Settings -> Scheduled backup secret and save a write-only passphrase. A host operator can instead set KEEL_BACKUP_PASSPHRASE as a locked environment override.",
            "Keep a separate copy in a password manager. A lost passphrase means unreadable backups, by design, and replacing it does not re-encrypt older files.",
          ],
          destination: "Settings -> Scheduled backup secret, or KEEL_BACKUP_PASSPHRASE in the host secret store.",
        },
      ],
    },
    {
      key: "backup-gdrive",
      title: "Back up to Google Drive",
      payoff: "Every snapshot is also uploaded to a Keel Backups folder in your Google Drive - off-machine, automatic.",
      group: "Keep your data safe",
      readyLine: "Connected - backups upload to your Drive automatically.",
      needs: [
        {
          name: "Google sign-in (above), then one click",
          what: "Drive backups reuse the same Google credential as sign-in; there is nothing extra to create.",
          where: { label: "Settings → Cloud backups → Connect Google Drive", url: "/settings" },
          steps: [
            "Finish “Sign in with Google” above (same client ID/secret).",
            "In Settings → Cloud backups, click “Connect Google Drive” and approve the one Drive permission.",
          ],
          destination: "A click in Settings - the connection is stored per-workspace.",
        },
      ],
    },
    {
      key: "backup-onedrive",
      title: "Back up to OneDrive",
      payoff: "Snapshots upload to an Apps folder in your OneDrive.",
      group: "Keep your data safe",
      readyLine: "Connected - backups upload to your OneDrive automatically.",
      needs: [
        {
          name: "Microsoft app registration (client ID + secret)",
          what: "Microsoft's equivalent of the Google credential: it lets this server ask “may I put files in this person's OneDrive?”.",
          where: { label: "Azure Portal → Microsoft Entra ID → App registrations", url: LINKS.entraRegistrations },
          steps: [
            `Click “New registration”. Name: Keel. Supported account types: “Personal Microsoft accounts and organizational”.`,
            `Redirect URI: choose “Web” and enter exactly: ${callback("/api/cloud/callback/onedrive")}`,
            `Also add: ${callback("/api/onenote/callback")} (used by the OneNote import, same registration).`,
            `After creating: the “Application (client) ID” on the Overview page is your MS_CLIENT_ID.`,
            `Then “Certificates & secrets” → “New client secret”. Copy the VALUE column immediately (it is shown once; the Secret ID column is not it - a trap much like R2's).`,
          ],
          destination:
            "Settings -> Integrations -> Microsoft. Paste both values and save; no server restart is needed. Server environment values remain a locked operator override.",
        },
      ],
    },
    {
      key: "backup-azure",
      title: "Back up to Azure Blob Storage",
      payoff:
        "Snapshots upload to an Azure storage container. No app registration needed - you paste one URL and you're done.",
      group: "Keep your data safe",
      readyLine: "Connected - backups upload to your Azure container automatically.",
      needs: [
        {
          name: "A container SAS URL",
          what: "A single https link that carries its own scoped permission - “may add and list files in this one container until this date”. Nothing else about your Azure account is exposed.",
          where: { label: "Azure Portal → Storage accounts", url: LINKS.azureStorageAccounts },
          steps: [
            "Create a storage account if you don't have one (any name/region; Standard performance and LRS redundancy are fine and cheapest).",
            "In the storage account: Data storage → Containers → “+ Container”, name it keel-backups, private access.",
            "Open the new container → “Shared access tokens” (left menu).",
            "Permissions: tick Read, Add, Create, Write, List - and nothing else.",
            "Expiry: pick something far out (e.g. two years - put a calendar reminder to renew).",
            "Click “Generate SAS token and URL” and copy the “Blob SAS URL” (the full https link, not the token line above it).",
          ],
          destination: "Settings → Cloud backups → Azure Blob → paste the URL. Keel tests it before saving.",
        },
      ],
    },
    {
      key: "backup-r2",
      title: "Back up to Cloudflare R2",
      payoff: "Snapshots upload to an R2 bucket - S3-compatible storage with a generous free tier.",
      group: "Keep your data safe",
      readyLine: "Connected - backups upload to your R2 bucket automatically.",
      needs: [
        {
          name: "Bucket + Access Key ID + Secret Access Key",
          what: "An S3-style credential pair scoped to one bucket.",
          where: { label: "Cloudflare Dashboard → R2", url: LINKS.r2Dashboard },
          steps: [
            "Create a bucket (keel-notes, or any name).",
            "From the R2 overview page, open “Manage R2 API Tokens” (upper right - it is not inside the bucket).",
            "Create API token → permissions “Object Read & Write” → scope it to your bucket.",
            "The result page shows FOUR values and two are traps: ignore “Token value” (that's for a different API). You want “Access Key ID” (32 hex chars) and “Secret Access Key” (64 hex chars).",
            "Neither of those is your Account ID - the ID shown in the endpoint URL. If you find yourself pasting the same value twice, it's the wrong value.",
            "The secret is shown exactly once. If the page is gone, delete the token and make a new one.",
          ],
          destination: "Settings → Cloud backups → Cloudflare R2 - Keel tests the credentials before saving.",
        },
      ],
    },
    {
      key: "onenote-import",
      title: "Mirror your OneNote notebooks",
      payoff:
        "An hourly, read-only copy of your OneNote notebooks appears under Imported - pages, sections, images and all. OneNote stays the editor; Keel becomes the searchable archive.",
      group: "Bring content in",
      readyLine: "Connected - the mirror refreshes hourly (Settings → OneNote for “Sync now”).",
      needs: [
        {
          name: "The same Microsoft registration as OneDrive",
          what: "One registration covers both - if you set up OneDrive backups above, this is already done.",
          where: { label: "Azure Portal → Microsoft Entra ID → App registrations", url: LINKS.entraRegistrations },
          steps: [
            "Follow the OneDrive steps above (one registration, both redirect URIs).",
            "Then Settings → OneNote hourly import → “Connect OneNote” and approve read access.",
          ],
          destination:
            "Settings -> Integrations -> Microsoft (the same saved credential is shared with OneDrive).",
        },
      ],
    },
    {
      key: "move-install",
      title: "Move this install anywhere",
      payoff:
        "Your whole notebook - pages, users, settings, pasted images - is one SQLite file. That makes moving between a laptop, Docker, or a server a copy, not a project.",
      group: "Move & update",
      readyLine: "Nothing to configure - the portability is built in.",
      needs: [
        {
          name: "Nothing to obtain - pick the move that fits",
          what: "Installed with the keel CLI (brew/npm/tarball), three commands cover every direction. Any install can also use encrypted snapshots from Settings → Backups: download on one machine, restore on another.",
          where: { label: "Settings → Backups & data safety", url: "/settings" },
          steps: [
            "To another machine, same style of install: `keel stop && keel export notebook.db`, copy the file over, `keel import notebook.db && keel start` there.",
            "To Docker (local or remote): `keel to-docker` writes a ready docker-compose directory with your data inside - `docker compose up -d` and you're moved. For a remote host, copy the directory there first.",
            "From Docker back to a laptop: copy /data/keel.db off the volume and `keel import` it.",
            "Any install → any install: Settings → Backups → “Back up now”, download the snapshot, restore it on the other side. Snapshots are encrypted when a passphrase is set.",
          ],
          destination: "Nowhere - these are actions, not credentials.",
        },
      ],
    },
    {
      key: "updates",
      title: "Stay up to date, seamlessly",
      payoff:
        "Updating never touches your data: the app directory is swapped, and the database migrates itself on the next start - whichever way Keel was installed.",
      group: "Move & update",
      readyLine: "The Server panel in Settings shows when a new version is out.",
      needs: [
        {
          name: "Nothing to obtain - one command per install method",
          what: "Settings → Server checks for new releases and tells you when one is out. Applying it is the one command matching how you installed.",
          where: { label: "Settings → Server", url: "/settings" },
          steps: [
            "keel CLI (tarball): `keel update` - downloads, swaps, restarts, keeps the previous version beside it.",
            "Homebrew: `brew upgrade keel`.",
            "npm: `npm update -g keel-notes`.",
            "Docker: `docker compose build --pull && docker compose up -d`.",
            "In every case your notes are untouched and the schema catches up on its own.",
          ],
          destination: "Nowhere - these are actions, not credentials.",
        },
      ],
    },
    {
      key: "trust-proxy",
      title: "Tell Keel about your reverse proxy",
      payoff:
        "Restores per-IP rate limiting and real source addresses in the audit log. Without it Keel cannot tell callers apart and skips IP-based limits entirely - the per-account login lockout still protects sign-in, but abuse from many addresses is unthrottled.",
      group: "Go online",
      readyLine: "Keel trusts your proxy's forwarded address.",
      needs: [
        {
          name: "One environment variable",
          what: "Keel only trusts the X-Forwarded-For header when you confirm a proxy sets it - otherwise anyone could forge their address and slip every limit. So it must be told, not guessed.",
          where: { label: "Your deployment's environment file", url: "/setup#trust-proxy" },
          steps: [
            "If a reverse proxy (Caddy, nginx, Cloudflare Tunnel, Tailscale Serve) sits in front of Keel, set KEEL_TRUST_PROXY=1 in the server environment.",
            "If TWO trusted proxies are chained (e.g. Cloudflare in front of your own Caddy), also set KEEL_TRUSTED_PROXY_HOPS=2.",
            "If Keel is exposed DIRECTLY on a public port with nothing in front, leave it unset - and consider putting a proxy in front, which is also how you get HTTPS.",
            "The bundled docker-compose.prod.yml and the cloud-init deployment already set it.",
          ],
          destination: "Server environment: KEEL_TRUST_PROXY=1, then restart Keel.",
        },
      ],
    },
    {
      key: "public-domain",
      title: "Reach your notes from anywhere",
      payoff:
        "Your own domain in any browser - no VPN app required - through a Cloudflare Tunnel, with no ports opened on this machine.",
      group: "Go online",
      readyLine: "This instance is reachable through its tunnel.",
      needs: [
        {
          name: "A Cloudflare Tunnel token",
          what: "A long token that lets a tiny connector on this server hold an outbound link to Cloudflare, which then routes your domain to it.",
          where: { label: "Cloudflare Zero Trust → Networks → Tunnels", url: LINKS.cloudflareTunnels },
          steps: [
            "Create a tunnel (type: Cloudflared), name it after this server.",
            "Copy the token (a long string starting eyJ) into the deployment's secrets file - see docs/HOSTING.md for the compose setup.",
            "In the tunnel's “Public hostname” tab, point your subdomain at the Keel service. Cloudflare creates the DNS record for you.",
            "Before going public, confirm the lockdown line below shows sign-ups disabled and your allowlist set.",
          ],
          destination: "The deployment's secrets file on the server (never in git).",
        },
      ],
    },
  ];
}

export interface CapabilityStatus {
  state: CapabilityState;
  /** One human line about the CURRENT state, e.g. what's missing. */
  detail: string;
}

interface DetectWorkspace {
  cloudProvider: string | null;
  cloudRefreshToken: string | null;
  cloudEmail: string | null;
  oneNoteRefreshToken: string | null;
}

/** Live status per capability. Pure reads - env plus the workspace row. */
export async function detectStatus(ws: DetectWorkspace): Promise<Record<string, CapabilityStatus>> {
  const [googleReady, microsoftReady, backupPassphrase] = await Promise.all([
    googleConfigured(),
    microsoftConfigured(),
    getBackupPassphraseStatus(),
  ]);
  const cloud = (provider: string, title: string): CapabilityStatus =>
    ws.cloudProvider === provider
      ? { state: "ready", detail: ws.cloudEmail ?? "connected" }
      : {
          state: "optional",
          detail:
            ws.cloudProvider && ws.cloudProvider !== provider
              ? `Backups currently go to ${ws.cloudEmail ?? ws.cloudProvider} - connecting ${title} would switch them.`
              : "Not connected.",
        };

  return {
    "google-signin": googleReady
      ? { state: "ready", detail: "Configured." }
      : { state: "optional", detail: "Not configured - password sign-in works regardless." },
    "backup-local": {
      state: backupPassphrase.configured ? "ready" : "action-needed",
      detail: backupPassphrase.configured
        ? `Snapshots use a ${backupPassphrase.source === "environment" ? "host-managed" : "write-only managed"} passphrase.`
        : backupPassphrase.source === "managed"
          ? "The saved passphrase cannot be decrypted. Replace it in Settings before the next encrypted snapshot."
          : "Works now, but snapshots are UNENCRYPTED until the instance owner saves a passphrase in Settings or the host environment.",
    },
    "backup-gdrive": googleReady
      ? cloud("google", "Google Drive")
      : { state: "optional", detail: "Needs Google sign-in configured first (above)." },
    "backup-onedrive": microsoftReady
      ? cloud("onedrive", "OneDrive")
      : { state: "optional", detail: "Needs the Microsoft registration first." },
    "backup-azure": cloud("azure", "Azure"),
    "backup-r2": cloud("r2", "R2"),
    "onenote-import": !microsoftReady
      ? { state: "optional", detail: "Needs the Microsoft registration first." }
      : ws.oneNoteRefreshToken
        ? { state: "ready", detail: "Connected." }
        : { state: "optional", detail: "Registration ready - connect in Settings → OneNote." },
    "move-install": { state: "ready", detail: "Built in." },
    updates: { state: "ready", detail: "Checked from Settings → Server." },
    "trust-proxy": keelFlag("TRUST_PROXY")
      ? { state: "ready", detail: "KEEL_TRUST_PROXY is set - per-IP limits and audit IPs are active." }
      : {
          state: "action-needed",
          detail:
            "Not set. If a proxy fronts this instance, setting it restores per-IP rate limiting and real audit addresses.",
        },
    "public-domain": {
      state: "optional",
      detail: "Configured on the server, not from the browser - see the steps.",
    },
  };
}

/** True when not a single off-machine backup destination is connected - the
 *  one situation the sidebar badge nags about. */
export function needsBackupAttention(ws: DetectWorkspace): boolean {
  return !ws.cloudProvider;
}
