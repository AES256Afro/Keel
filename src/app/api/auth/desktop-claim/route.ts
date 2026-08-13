import { NextRequest, NextResponse } from "next/server";
import { applySessionCookie } from "@/lib/auth";
import { takeHandoff } from "@/lib/desktop-handoff";
import { isDesktopHandoffAllowed } from "@/lib/desktop-mode";
import { relativeRedirect } from "@/lib/request-origin";

/** Redeem a parked desktop session. Loaded by the app window itself, so the
 *  Set-Cookie lands in the app's cookie jar and it becomes signed in.
 *
 *  Loopback only - this endpoint hands out a session without authenticating
 *  the caller, which is safe on 127.0.0.1 and session fixation anywhere else.
 *  See src/lib/desktop-mode.ts. */
export function GET(req: NextRequest) {
  if (!isDesktopHandoffAllowed(req)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const entry = id ? takeHandoff(id) : null;
  if (!entry) {
    return relativeRedirect("/login?error=desktop-link-expired");
  }
  const res = relativeRedirect("/");
  return applySessionCookie(res, entry.token, entry.expiresAt);
}
