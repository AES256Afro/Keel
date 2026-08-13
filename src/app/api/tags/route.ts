import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError } from "@/lib/api";
import { listTags } from "@/lib/links";

/**
 * Every tag in the workspace, or the pages carrying one.
 *
 *   GET /api/tags            → all tags with counts
 *   GET /api/tags?tag=work   → pages tagged #work
 */
export async function GET(req: NextRequest) {
  try {
    const { workspace } = await requireContext();
    const tag = req.nextUrl.searchParams.get("tag")?.trim().toLowerCase().slice(0, 60);

    if (!tag) {
      return NextResponse.json({ tags: await listTags(workspace.id) });
    }

    const rows = await prisma.pageTag.findMany({
      where: { workspaceId: workspace.id, tag, page: { archivedAt: null } },
      include: { page: { select: { id: true, title: true, icon: true, type: true, updatedAt: true } } },
      take: 200,
    });
    return NextResponse.json({
      tag,
      pages: rows
        .map((r) => ({
          id: r.page.id,
          title: r.page.title || "Untitled",
          icon: r.page.icon,
          type: r.page.type,
          updatedAt: r.page.updatedAt.toISOString(),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
