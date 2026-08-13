import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { publicOrigin } from "@/lib/request-origin";
import {
  buildAuthUrl,
  googleConfigured,
  microsoftConfigured,
  DRIVE_SCOPE,
  ONEDRIVE_SCOPE,
} from "@/lib/oauth";

/** Start connecting Google Drive or OneDrive for cloud backups (owner only). */
export async function GET(req: NextRequest) {
  try {
    await requireOwner();
    const provider = req.nextUrl.searchParams.get("provider");
    if (provider !== "google" && provider !== "onedrive") {
      throw new ApiError(400, "provider must be google or onedrive");
    }
    if (provider === "google" && !googleConfigured()) {
      throw new ApiError(400, "Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET first");
    }
    if (provider === "onedrive" && !microsoftConfigured()) {
      throw new ApiError(400, "Set MS_CLIENT_ID / MS_CLIENT_SECRET first");
    }
    const state = randomBytes(16).toString("hex");
    const url = buildAuthUrl({
      provider,
      redirectUri: `${publicOrigin(req)}/api/cloud/callback/${provider}`,
      scope: provider === "google" ? `openid email ${DRIVE_SCOPE}` : ONEDRIVE_SCOPE,
      state,
      offline: true,
    });
    const res = NextResponse.redirect(url);
    res.cookies.set("keel-oauth-state", state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
