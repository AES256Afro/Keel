import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError, requireOwner } from "@/lib/api";
import { buildAuthUrl, microsoftConfigured, ONENOTE_SCOPE } from "@/lib/oauth";
import { publicOrigin } from "@/lib/request-origin";

export async function GET(req: NextRequest) {
  try {
    await requireOwner();
    if (!microsoftConfigured()) throw new ApiError(400, "Set MS_CLIENT_ID and MS_CLIENT_SECRET first");
    const state = randomBytes(24).toString("hex");
    const redirectUri = `${publicOrigin(req)}/api/onenote/callback`;
    const authUrl = new URL(
      buildAuthUrl({
        provider: "onedrive",
        redirectUri,
        scope: ONENOTE_SCOPE,
        state,
        offline: true,
      })
    );
    authUrl.searchParams.set("prompt", "consent");
    const response = NextResponse.redirect(authUrl);
    response.cookies.set("nopin-onenote-state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
