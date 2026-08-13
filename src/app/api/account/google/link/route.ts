import { NextRequest, NextResponse } from "next/server";
import { ApiError, enforceLimit, handleApiError, requireContext } from "@/lib/api";
import { readSessionToken } from "@/lib/auth";
import { issueGoogleAccountLinkState } from "@/lib/google-account-link";
import { buildAuthUrl, googleConfigured, LOGIN_SCOPE } from "@/lib/oauth";
import { prisma } from "@/lib/prisma";
import { publicOrigin } from "@/lib/request-origin";
import { requireSameOriginMutation } from "@/lib/same-origin";

export const runtime = "nodejs";

async function boundSession(req: NextRequest, userId: string) {
  const token = readSessionToken(req.cookies);
  if (!token) throw new ApiError(401, "Not signed in");
  const session = await prisma.session.findUnique({
    where: { token },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!session || session.userId !== userId || session.expiresAt <= new Date()) {
    throw new ApiError(401, "Not signed in");
  }
  return { id: session.id, userId: session.userId };
}

/** Start an explicit account-self link. This is intentionally not restricted
 * to the instance owner: the owner configures Google for the server, but every
 * signed-in user controls which sign-in methods belong to their own account. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireContext();
    requireSameOriginMutation(req, "Start Google account linking from Settings");
    await enforceLimit("google-account-link-start", {
      limit: 5,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    if (!(await googleConfigured())) {
      throw new ApiError(409, "Google sign-in is not configured on this server");
    }
    if (user.googleId) {
      throw new ApiError(409, "This account already has Google sign-in linked");
    }

    const session = await boundSession(req, user.id);
    const issued = await issueGoogleAccountLinkState(session, user.email);
    const authorizationUrl = await buildAuthUrl({
      provider: "google",
      redirectUri: `${publicOrigin(req)}/api/account/google/callback`,
      scope: LOGIN_SCOPE,
      state: issued.state,
    });
    return NextResponse.json(
      { authorizationUrl, expiresAt: issued.expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
