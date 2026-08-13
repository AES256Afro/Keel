import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, requirePage, handleApiError } from "@/lib/api";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace } = await requireContext();
    const { pageId } = await params;
    await requirePage(pageId, workspace.id);
    const body = await req.json().catch(() => ({}));
    if (body.on) {
      await prisma.favorite.upsert({
        where: { userId_pageId: { userId: user.id, pageId } },
        create: { userId: user.id, pageId },
        update: {},
      });
    } else {
      await prisma.favorite.deleteMany({ where: { userId: user.id, pageId } });
    }
    return NextResponse.json({ favorite: Boolean(body.on) });
  } catch (err) {
    return handleApiError(err);
  }
}
