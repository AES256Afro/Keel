import { NextRequest, NextResponse } from "next/server";
import { ApiError, enforceLimit, handleApiError, requireOwner } from "@/lib/api";
import { buildAuthUrl, microsoftConfigured, ONENOTE_SCOPE } from "@/lib/oauth";
import { publicOrigin } from "@/lib/request-origin";
import { issueOAuthConnectionState } from "@/lib/oauth-connection-state";
import { activeRequestSession } from "@/lib/oauth-request-session";

export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    await enforceLimit("onenote-oauth-start", {
      limit: 10,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    if (!(await microsoftConfigured())) {
      throw new ApiError(400, "Configure Microsoft sign-in in Settings first");
    }
    const session = await activeRequestSession(req, user.id);
    if (!session) throw new ApiError(401, "Not signed in");
    const { state } = await issueOAuthConnectionState({
      session,
      workspaceId: workspace.id,
      provider: "onedrive",
      purpose: "onenote",
    });
    const redirectUri = `${publicOrigin(req)}/api/onenote/callback`;
    const authUrl = new URL(
      await buildAuthUrl({
        provider: "onedrive",
        redirectUri,
        scope: ONENOTE_SCOPE,
        state,
        offline: true,
      })
    );
    authUrl.searchParams.set("prompt", "consent");
    const response = NextResponse.redirect(authUrl);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
