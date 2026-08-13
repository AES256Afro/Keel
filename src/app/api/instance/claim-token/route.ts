import { NextRequest, NextResponse } from "next/server";
import { ApiError, enforceLimit, handleApiError, requireContext } from "@/lib/api";
import { InstanceClaimError, issueInstanceClaimToken } from "@/lib/instance-claim";
import { requireSameOriginMutation } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a short-lived, one-use token for the signed-in account.
 *
 * This endpoint cannot claim the server. The token becomes useful only after
 * the machine operator runs the local CLI and passes fresh OS authorization.
 * The plaintext is returned once, never stored, and never written to logs.
 */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireContext();
    requireSameOriginMutation(req, "Generate a claim command from Keel Settings");
    await enforceLimit("instance-claim-token", {
      limit: 5,
      windowMs: 5 * 60 * 1000,
      userId: user.id,
    });
    try {
      const claim = await issueInstanceClaimToken(user.id);
      return NextResponse.json(
        { token: claim.token, expiresAt: claim.expiresAt.toISOString() },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof InstanceClaimError) {
        throw new ApiError(409, error.message);
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
