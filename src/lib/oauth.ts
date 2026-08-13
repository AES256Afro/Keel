// OAuth 2.0 plumbing for Google (sign-in + Drive backups) and Microsoft
// (OneDrive backups). No SDK  -  plain authorization-code flow over fetch.
//
// Required environment variables (see docs/CLOUD.md):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET        Google sign-in + Drive
//   MS_CLIENT_ID / MS_CLIENT_SECRET                OneDrive

export type CloudProvider = "google" | "onedrive";

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function microsoftConfigured() {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

const ENDPOINTS = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientId: () => process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  onedrive: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientId: () => process.env.MS_CLIENT_ID ?? "",
    clientSecret: () => process.env.MS_CLIENT_SECRET ?? "",
  },
} as const;

export const LOGIN_SCOPE = "openid email profile";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // app-created files only
export const ONEDRIVE_SCOPE = "offline_access User.Read Files.ReadWrite.AppFolder"; // app folder only
export const ONENOTE_SCOPE = "offline_access User.Read Notes.Read";

export function buildAuthUrl(opts: {
  provider: CloudProvider;
  redirectUri: string;
  scope: string;
  state: string;
  offline?: boolean;
}): string {
  const cfg = ENDPOINTS[opts.provider];
  const params = new URLSearchParams({
    client_id: cfg.clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scope,
    state: opts.state,
  });
  if (opts.provider === "google") {
    if (opts.offline) {
      // Force a refresh token so scheduled backups keep working.
      params.set("access_type", "offline");
      params.set("prompt", "consent");
    } else {
      params.set("prompt", "select_account");
    }
  }
  return `${cfg.auth}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  provider: CloudProvider,
  body: Record<string, string>
): Promise<TokenResponse> {
  const cfg = ENDPOINTS[provider];
  const res = await fetch(cfg.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId(),
      client_secret: cfg.clientSecret(),
      ...body,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) {
    throw new Error(`${provider} token error: ${data.error_description ?? data.error ?? res.status}`);
  }
  return data;
}

export function exchangeCode(provider: CloudProvider, code: string, redirectUri: string) {
  return tokenRequest(provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

export function refreshAccessToken(provider: CloudProvider, refreshToken: string, scope?: string) {
  return tokenRequest(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(provider === "onedrive" ? { scope: scope ?? ONEDRIVE_SCOPE } : {}),
  });
}

/** Google userinfo (email/name/id) for a fresh access token. */
export async function googleUserInfo(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
  return (await res.json()) as { id: string; email: string; name?: string };
}

/** Microsoft Graph /me  -  used for the account label in Settings. */
export async function microsoftUserInfo(accessToken: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Microsoft Graph /me failed (${res.status})`);
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  return { email: data.mail ?? data.userPrincipalName ?? "OneDrive account" };
}
