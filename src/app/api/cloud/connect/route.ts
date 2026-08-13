import { NextRequest, NextResponse } from "next/server";
import { requireOwner, handleApiError, ApiError, enforceLimit } from "@/lib/api";
import { publicOrigin } from "@/lib/request-origin";
import {
  buildAuthUrl,
  googleConfigured,
  microsoftConfigured,
  DRIVE_SCOPE,
  ONEDRIVE_SCOPE,
} from "@/lib/oauth";
import { issueOAuthConnectionState } from "@/lib/oauth-connection-state";
import { activeRequestSession } from "@/lib/oauth-request-session";

/** Start connecting Google Drive or OneDrive for cloud backups (owner only). */
export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    await enforceLimit("cloud-oauth-start", {
      limit: 10,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    const provider = req.nextUrl.searchParams.get("provider");
    if (provider !== "google" && provider !== "onedrive") {
      throw new ApiError(400, "provider must be google or onedrive");
    }
    if (provider === "google" && !(await googleConfigured())) {
      throw new ApiError(400, "Configure Google sign-in in Settings first");
    }
    if (provider === "onedrive" && !(await microsoftConfigured())) {
      throw new ApiError(400, "Configure Microsoft sign-in in Settings first");
    }
    const session = await activeRequestSession(req, user.id);
    if (!session) throw new ApiError(401, "Not signed in");
    const { state } = await issueOAuthConnectionState({
      session,
      workspaceId: workspace.id,
      provider,
      purpose: "cloud",
    });
    const url = await buildAuthUrl({
      provider,
      redirectUri: `${publicOrigin(req)}/api/cloud/callback/${provider}`,
      scope: provider === "google" ? `openid email ${DRIVE_SCOPE}` : ONEDRIVE_SCOPE,
      state,
      offline: true,
    });
    const res = NextResponse.redirect(url);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
