import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import {
  ApiError,
  enforceLimit,
  handleApiError,
  requireInstanceOwner,
} from "@/lib/api";
import {
  clearOAuthProviderSettings,
  getOAuthProviderStatus,
  OAuthSettingsError,
  type OAuthProviderStatus,
  type OAuthSettingsProvider,
  saveOAuthProviderSettings,
} from "@/lib/oauth-settings";
import { publicOrigin } from "@/lib/request-origin";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";

function providerName(value: unknown): OAuthSettingsProvider {
  if (value !== "google" && value !== "microsoft") {
    throw new ApiError(400, "provider must be google or microsoft");
  }
  return value;
}

function optionalCredential(value: unknown, field: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new ApiError(400, `${field} must be a string`);
  return value;
}

function publicStatus(
  status: OAuthProviderStatus,
  origin: string
): OAuthProviderStatus & {
  callbacks: Record<string, string>;
  testPaths: Record<string, string>;
} {
  return status.provider === "google"
    ? {
        ...status,
        callbacks: {
          signIn: `${origin}/api/auth/google/callback`,
          accountLink: `${origin}/api/account/google/callback`,
          cloud: `${origin}/api/cloud/callback/google`,
        },
        testPaths: {
          cloud: "/api/cloud/connect?provider=google",
        },
      }
    : {
        ...status,
        callbacks: {
          cloud: `${origin}/api/cloud/callback/onedrive`,
          oneNote: `${origin}/api/onenote/callback`,
        },
        testPaths: {
          cloud: "/api/cloud/connect?provider=onedrive",
          oneNote: "/api/onenote/connect",
        },
      };
}

async function statusResponse(req: NextRequest) {
  const origin = publicOrigin(req);
  const [google, microsoft] = await Promise.all([
    getOAuthProviderStatus("google"),
    getOAuthProviderStatus("microsoft"),
  ]);
  return {
    providers: {
      google: publicStatus(google, origin),
      microsoft: publicStatus(microsoft, origin),
    },
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireInstanceOwner();
    return NextResponse.json(await statusResponse(req));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change OAuth settings from Keel Settings");
    requireJsonRequest(req, "OAuth settings requests must use application/json");
    await enforceLimit("oauth-settings", {
      limit: 10,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });

    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      throw new ApiError(413, "OAuth settings requests are limited to 16 KB");
    }

    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > 16 * 1024) {
      throw new ApiError(413, "OAuth settings requests are limited to 16 KB");
    }
    const body = (() => {
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        return null;
      }
    })() as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "Request body must be a JSON object");
    }
    const provider = providerName(body.provider);
    let status: OAuthProviderStatus;
    let operation: "save" | "clear";

    if (body.action === "save") {
      operation = "save";
      status = await saveOAuthProviderSettings(provider, {
        clientId: optionalCredential(body.clientId, "clientId"),
        clientSecret: optionalCredential(body.clientSecret, "clientSecret"),
      });
    } else if (body.action === "clear") {
      operation = "clear";
      if (body.confirm !== true) {
        throw new ApiError(400, "Set confirm to true to clear managed credentials");
      }
      status = await clearOAuthProviderSettings(provider);
    } else {
      throw new ApiError(400, "action must be save or clear");
    }

    await audit("oauth.settings", user, {
      target: provider,
      detail: {
        provider,
        operation,
        configured: status.configured,
        source: status.source,
      },
    });
    return NextResponse.json({ provider: publicStatus(status, publicOrigin(req)) });
  } catch (error) {
    if (error instanceof OAuthSettingsError) {
      return handleApiError(new ApiError(error.status, error.message));
    }
    return handleApiError(error);
  }
}
