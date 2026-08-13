import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { buildAuthUrl, googleConfigured, LOGIN_SCOPE } from "@/lib/oauth";
import { isDesktopHandoffAllowed } from "@/lib/desktop-mode";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";

/** Start Google sign-in. */
export async function GET(req: NextRequest) {
  if (!(await googleConfigured())) {
    return relativeRedirect("/login?error=google-not-configured");
  }
  const state = randomBytes(16).toString("hex");
  const url = await buildAuthUrl({
    provider: "google",
    redirectUri: `${publicOrigin(req)}/api/auth/google/callback`,
    scope: LOGIN_SCOPE,
    state,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set("keel-oauth-state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  // Desktop flow: sign-in runs in the system browser (Google blocks embedded
  // windows). Remember the app's handoff id so the callback can park the
  // session for the app window to redeem. Restricted to a plausible id - and
  // to loopback, so a public instance can't be talked into parking a session
  // for someone else to claim (see src/lib/desktop-mode.ts).
  const desktop = isDesktopHandoffAllowed(req)
    ? req.nextUrl.searchParams.get("desktop")
    : null;
  if (desktop && /^[a-f0-9]{16,128}$/.test(desktop)) {
    res.cookies.set("keel-oauth-desktop", desktop, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }
  return res;
}
