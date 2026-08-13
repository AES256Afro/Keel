import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, requirePage, handleApiError } from "@/lib/api";

/** Record a page visit for the "Recent" sidebar section. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace } = await requireContext();
    const { pageId } = await params;
    await requirePage(pageId, workspace.id);
    await prisma.recentVisit.upsert({
      where: { userId_pageId: { userId: user.id, pageId } },
      create: { userId: user.id, pageId },
      update: { visitedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
