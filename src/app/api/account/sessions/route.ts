import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireContext, handleApiError } from "@/lib/api";
import { readSessionToken } from "@/lib/auth";
import { listSessions, revokeOtherSessions } from "@/lib/sessions";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Where this account is currently signed in. */
export async function GET() {
  try {
    const { user } = await requireContext();
    const token = readSessionToken(await cookies());
    return NextResponse.json({ sessions: await listSessions(user.id, token) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** Sign out everywhere else, keeping the session making the request. */
export async function DELETE(_req: NextRequest) {
  try {
    const { user } = await requireContext();
    const token = readSessionToken(await cookies());
    const revoked = await revokeOtherSessions(user.id, token);
    await audit("account.sessions.revokeAll", user, { detail: { revoked } });
    return NextResponse.json({ revoked });
  } catch (err) {
    return handleApiError(err);
  }
}
