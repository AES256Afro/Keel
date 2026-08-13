import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireContext, handleApiError, ApiError } from "@/lib/api";
import { readSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revokeSession } from "@/lib/sessions";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** End one session. Scoped to the caller's own sessions. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { user } = await requireContext();
    const { sessionId } = await params;

    // Revoking the session you are using is "sign out", which has its own
    // flow - doing it here would leave the browser holding a dead cookie.
    const token = readSessionToken(await cookies());
    if (token) {
      const current = await prisma.session.findUnique({
        where: { token },
        select: { id: true },
      });
      if (current?.id === sessionId) {
        throw new ApiError(400, "That's this session - use Sign out instead.");
      }
    }

    if (!(await revokeSession(user.id, sessionId))) {
      throw new ApiError(404, "Session not found");
    }
    await audit("account.session.revoke", user, { target: sessionId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
