import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, enforceLimit, handleApiError, ApiError } from "@/lib/api";
import { hashPassword, verifyPassword, readSessionToken } from "@/lib/auth";
import { revokeOtherSessions } from "@/lib/sessions";
import { audit } from "@/lib/audit";
import { cookies } from "next/headers";

export const runtime = "nodejs";

const MIN_LENGTH = 8;
/** bcrypt only reads the first 72 bytes; refuse absurd input rather than hash it. */
const MAX_LENGTH = 512;

/**
 * Change the account password.
 *
 * Requires the current password even though the caller already holds a valid
 * session: a session is "this browser", not "this person", and a borrowed
 * laptop shouldn't be able to take the account.
 *
 * Every other session is ended on success. A password change that leaves old
 * sessions alive does not remove whoever you changed it because of.
 */
export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireContext();
    // Verifying the current password runs bcrypt, so this is also a guessing
    // oracle if left open.
    await enforceLimit("password-change", {
      limit: 10,
      windowMs: 15 * 60_000,
      userId: user.id,
    });

    const body = await req.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");

    if (!user.passwordHash) {
      throw new ApiError(
        400,
        "This account signs in with Google and has no password to change."
      );
    }
    if (newPassword.length < MIN_LENGTH) {
      throw new ApiError(400, `A password needs at least ${MIN_LENGTH} characters.`);
    }
    if (newPassword.length > MAX_LENGTH) {
      throw new ApiError(400, "That password is too long.");
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ApiError(403, "That is not your current password.");
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new ApiError(400, "That is already your password.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    const currentToken = readSessionToken(await cookies());
    const endedElsewhere = await revokeOtherSessions(user.id, currentToken);

    await audit("account.password", user, { detail: { endedElsewhere } });
    return NextResponse.json({ ok: true, endedElsewhere });
  } catch (err) {
    return handleApiError(err);
  }
}
