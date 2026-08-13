import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, handleApiError, ApiError } from "@/lib/api";
import { MAX_NAME } from "@/lib/limits";
import { isViewType, parseViewConfig, sanitizeConfig, serializeViewConfig } from "@/lib/views";

async function requireView(viewId: string, workspaceId: string) {
  const view = await prisma.databaseView.findUnique({
    where: { id: viewId },
    include: { database: true },
  });
  if (!view || view.database.workspaceId !== workspaceId) {
    throw new ApiError(404, "View not found");
  }
  return view;
}

/**
 * Update a view's name, type or config.
 *
 * The config is merged, not replaced: the board writes `wipLimits` while the
 * mind map writes `mindmap`, and neither should clobber the other's settings
 * just by saving its own.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ viewId: string }> }) {
  try {
    const { workspace } = await requireEditor();
    const { viewId } = await params;
    const view = await requireView(viewId, workspace.id);
    const body = await req.json().catch(() => ({}));

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      data.name = body.name.trim().slice(0, MAX_NAME);
    }
    if (isViewType(body.type)) data.type = body.type;
    if (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)) {
      data.sortOrder = body.sortOrder;
    }
    if (body.config !== undefined) {
      const incoming = sanitizeConfig(body.config);
      const merged =
        body.replaceConfig === true ? incoming : { ...parseViewConfig(view.config), ...incoming };
      data.config = serializeViewConfig(merged);
    }

    const updated = await prisma.databaseView.update({ where: { id: view.id }, data });
    return NextResponse.json({
      view: {
        id: updated.id,
        name: updated.name,
        type: isViewType(updated.type) ? updated.type : "table",
        sortOrder: updated.sortOrder,
        config: parseViewConfig(updated.config),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ viewId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { viewId } = await params;
    const view = await requireView(viewId, workspace.id);
    // A database with no views has nothing to render.
    const remaining = await prisma.databaseView.count({ where: { databaseId: view.databaseId } });
    if (remaining <= 1) throw new ApiError(400, "A database needs at least one view.");
    await prisma.databaseView.delete({ where: { id: view.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
