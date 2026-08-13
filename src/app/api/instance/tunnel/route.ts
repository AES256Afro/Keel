import { NextRequest, NextResponse } from "next/server";
import { requireInstanceOwner, handleApiError, ApiError } from "@/lib/api";
import { cloudflaredAvailable, startTunnel, stopTunnel, tunnelState } from "@/lib/tunnel";
import { audit } from "@/lib/audit";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireInstanceOwner();
    return NextResponse.json({ state: tunnelState(), available: cloudflaredAvailable() });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change tunnel settings from Keel Settings");
    requireJsonRequest(req, "Tunnel requests must use application/json");
    const b = await req.json().catch(() => ({}));
    const mode = b.mode === "named" ? "named" : "quick";
    const token = b.token ? String(b.token).trim() : "";
    if (mode === "named" && !token) throw new ApiError(400, "A tunnel token is required for a named tunnel.");
    if (!cloudflaredAvailable()) {
      throw new ApiError(400, "cloudflared isn't installed on this machine. Install it, then try again.");
    }
    const port = Number(process.env.PORT) || 3000;
    const state = startTunnel({ mode, token, port });
    // Publishing a private instance to the internet is worth a record.
    await audit("tunnel.start", ctx.user, { detail: { mode, port } });
    return NextResponse.json({ state });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change tunnel settings from Keel Settings");
    const state = stopTunnel();
    await audit("tunnel.stop", ctx.user);
    return NextResponse.json({ state });
  } catch (err) {
    return handleApiError(err);
  }
}
