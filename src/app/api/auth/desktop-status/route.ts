import { NextRequest, NextResponse } from "next/server";
import { handoffReady } from "@/lib/desktop-handoff";
import { isDesktopHandoffAllowed } from "@/lib/desktop-mode";

/** Polled by the desktop app while the user signs in via the system browser.
 *  Reveals only whether a session is ready to claim for the given id.
 *
 *  Loopback only - see src/lib/desktop-mode.ts. */
export function GET(req: NextRequest) {
  if (!isDesktopHandoffAllowed(req)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  return NextResponse.json({ ready: Boolean(id) && handoffReady(id) });
}
