import { NextRequest, NextResponse } from "next/server";
import { ApiError, enforceLimit, handleApiError, requireContext } from "@/lib/api";
import {
  claimInstanceWithBootstrapToken,
  InstanceClaimError,
} from "@/lib/instance-claim";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireContext();
    requireSameOriginMutation(req, "Start hosted server claiming from Keel Settings");
    requireJsonRequest(req, "Hosted claim requests must use application/json");
    await enforceLimit("instance-claim-bootstrap", {
      limit: 5,
      windowMs: 15 * 60 * 1000,
      blockMs: 15 * 60 * 1000,
      userId: user.id,
    });

    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 2048) {
      throw new ApiError(413, "Hosted claim requests are limited to 2 KB");
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > 2048) {
      throw new ApiError(413, "Hosted claim requests are limited to 2 KB");
    }
    const body = (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })() as { token?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.token !== "string") {
      throw new ApiError(400, "Enter the hosted owner bootstrap token");
    }
    if (body.token.length > 512) throw new ApiError(400, "The bootstrap token is invalid");

    const result = await claimInstanceWithBootstrapToken(user, body.token);
    return NextResponse.json(
      { status: result.status },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof InstanceClaimError) {
      return handleApiError(new ApiError(403, error.message));
    }
    return handleApiError(error);
  }
}
