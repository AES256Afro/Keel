import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError } from "@/lib/api";

/** Mark the caller's own onboarding as seen. Idempotent, self-only. */
export async function POST() {
  try {
    const { user } = await requireContext();
    await prisma.user.update({
      where: { id: user.id },
      data: { onboardedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
