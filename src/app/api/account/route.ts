import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError, ApiError, isUniqueViolation } from "@/lib/api";

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireContext();
    const body = await req.json().catch(() => ({}));
    const username = String(body.username ?? "").trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new ApiError(
        400,
        "Username must be 3-30 characters: lowercase letters, numbers, dots, dashes, underscores."
      );
    }
    try {
      await prisma.user.update({ where: { id: user.id }, data: { username } });
    } catch (e) {
      // The database enforces uniqueness now, so let it decide - a
      // findFirst-then-update check races with a concurrent claim.
      if (isUniqueViolation(e)) throw new ApiError(409, "That username is taken.");
      throw e;
    }
    return NextResponse.json({ username });
  } catch (err) {
    return handleApiError(err);
  }
}
