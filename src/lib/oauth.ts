// OAuth 2.0 plumbing for Google (sign-in + Drive backups) and Microsoft
// (OneDrive backups). No SDK  -  plain authorization-code flow over fetch.
//
// Environment variables remain the highest-priority source. When neither is
// present, the instance owner may save an encrypted pair from Settings. Every
// operation resolves the pair afresh so a managed change takes effect without
// rewriting .env or restarting the server.

import {
  markOAuthProviderVerified,
  resolveOAuthCredentials,
  settingsProviderForRuntime,
} from "@/lib/oauth-settings";

export type CloudProvider = "google" | "onedrive";

export async function googleConfigured() {
  return Boolean(await resolveOAuthCredentials("google"));
}

export async function microsoftConfigured() {
  return Boolean(await resolveOAuthCredentials("microsoft"));
}

const ENDPOINTS = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  onedrive: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
} as const;

export const LOGIN_SCOPE = "openid email profile";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // app-created files only
export const ONEDRIVE_SCOPE = "offline_access User.Read Files.ReadWrite.AppFolder"; // app folder only
export const ONENOTE_SCOPE = "offline_access User.Read Notes.Read";

export async function buildAuthUrl(opts: {
  provider: CloudProvider;
  redirectUri: string;
  scope: string;
  state: string;
  offline?: boolean;
}): Promise<string> {
  const cfg = ENDPOINTS[opts.provider];
  const credentials = await resolveOAuthCredentials(settingsProviderForRuntime(opts.provider));
  if (!credentials) throw new Error(`${opts.provider} OAuth is not configured`);
  const params = new URLSearchParams({
    client_id: credentials.clientId,
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
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const OAUTH_FETCH_TIMEOUT_MS = 15_000;

async function tokenRequest(
  provider: CloudProvider,
  body: Record<string, string>
): Promise<OAuthTokenResponse> {
  const cfg = ENDPOINTS[provider];
  const credentials = await resolveOAuthCredentials(settingsProviderForRuntime(provider));
  if (!credentials) throw new Error(`${provider} OAuth is not configured`);
  const res = await fetch(cfg.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      ...body,
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) {
    const description =
      typeof data.error_description === "string"
        ? data.error_description
        : typeof data.error === "string"
          ? data.error
          : String(res.status);
    throw new Error(`${provider} token error: ${description}`);
  }
  if (typeof data.access_token !== "string" || data.access_token.trim() === "") {
    throw new Error(`${provider} token error: provider returned no access token`);
  }
  if (body.grant_type === "authorization_code") {
    await markOAuthProviderVerified(settingsProviderForRuntime(provider), credentials).catch((error) => {
      // A successful external sign-in or connection must not be undone by a
      // best-effort status marker. The credential itself is never logged.
      console.warn(`[keel] could not record ${provider} OAuth verification`, error);
    });
  }
  return {
    access_token: data.access_token,
    ...(typeof data.refresh_token === "string" && data.refresh_token
      ? { refresh_token: data.refresh_token }
      : {}),
    ...(typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? { expires_in: data.expires_in }
      : {}),
  };
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

export type GoogleUserInfoResponse = {
  id?: unknown;
  email?: unknown;
  name?: unknown;
  verified_email?: unknown;
};

export type VerifiedGoogleIdentity = {
  id: string;
  email: string;
  name?: string;
};

/** Narrow an untrusted userinfo response to an identity whose mailbox Google
 * explicitly verified. Callers must not use an email or subject before this
 * check, especially for invite conversion. */
export function verifiedGoogleIdentity(
  info: GoogleUserInfoResponse
): VerifiedGoogleIdentity | null {
  if (
    info.verified_email !== true ||
    typeof info.id !== "string" ||
    !info.id.trim() ||
    typeof info.email !== "string"
  ) {
    return null;
  }
  const email = info.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const name = typeof info.name === "string" ? info.name.trim().slice(0, 200) : "";
  return { id: info.id.trim(), email, ...(name ? { name } : {}) };
}

/** Google userinfo response for a fresh access token. Treat it as untrusted
 * until verifiedGoogleIdentity has accepted it. */
export async function googleUserInfo(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
  return (await res.json()) as GoogleUserInfoResponse;
}

/** Microsoft Graph /me  -  used for the account label in Settings. */
export async function microsoftUserInfo(accessToken: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Microsoft Graph /me failed (${res.status})`);
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  return { email: data.mail ?? data.userPrincipalName ?? "OneDrive account" };
}
