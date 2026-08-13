import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireContext,
  requireEditor,
  requireDatabase,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { MAX_NAME } from "@/lib/limits";
import { isViewType, parseViewConfig, sanitizeConfig, serializeViewConfig, type ViewDTO } from "@/lib/views";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ databaseId: string }> }
) {
  try {
    const { workspace } = await requireContext();
    const { databaseId } = await params;
    await requireDatabase(databaseId, workspace.id);
    const rows = await prisma.databaseView.findMany({
      where: { databaseId },
      orderBy: { sortOrder: "asc" },
    });
    const views: ViewDTO[] = rows.map((v) => ({
      id: v.id,
      name: v.name,
      type: isViewType(v.type) ? v.type : "table",
      sortOrder: v.sortOrder,
      config: parseViewConfig(v.config),
    }));
    return NextResponse.json({ views });
  } catch (err) {
    return handleApiError(err);
  }
}

/** Add a view to a database. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ databaseId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { databaseId } = await params;
    await requireDatabase(databaseId, workspace.id);

    const body = await req.json().catch(() => ({}));
    const type = isViewType(body.type) ? body.type : "table";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, MAX_NAME)
        : type[0].toUpperCase() + type.slice(1);

    const count = await prisma.databaseView.count({ where: { databaseId } });
    if (count >= 50) throw new ApiError(400, "That database already has the maximum of 50 views.");
    const last = await prisma.databaseView.findFirst({
      where: { databaseId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const view = await prisma.databaseView.create({
      data: {
        databaseId,
        name,
        type,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        config: serializeViewConfig(sanitizeConfig(body.config)),
      },
    });
    return NextResponse.json(
      {
        view: {
          id: view.id,
          name: view.name,
          type,
          sortOrder: view.sortOrder,
          config: parseViewConfig(view.config),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
