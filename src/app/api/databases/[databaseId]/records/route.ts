import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, requireDatabase, handleApiError, ApiError } from "@/lib/api";
import { createRecord } from "@/lib/pages";
import { MAX_TITLE } from "@/lib/limits";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ databaseId: string }> }
) {
  try {
    const { user, workspace } = await requireEditor();
    const { databaseId } = await params;
    const db = await requireDatabase(databaseId, workspace.id);
    const body = await req.json().catch(() => ({}));

    // A parent must be a record in THIS database - the mind map creates child
    // nodes through here, and an edge to another database would be a cycle-free
    // but meaningless graph.
    let parentRecordId: string | null = null;
    if (typeof body.parentRecordId === "string" && body.parentRecordId) {
      const parent = await prisma.databaseRecord.findUnique({
        where: { id: body.parentRecordId },
        select: { databaseId: true },
      });
      if (!parent || parent.databaseId !== db.id) {
        throw new ApiError(400, "The parent record must be in this database.");
      }
      parentRecordId = body.parentRecordId;
    }

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const record = await createRecord({
      databaseId: db.id,
      workspaceId: workspace.id,
      userId: user.id,
      databasePageId: db.pageId,
      title: typeof body.title === "string" ? body.title.slice(0, MAX_TITLE) : "",
      parentRecordId,
      mapX: num(body.mapX),
      mapY: num(body.mapY),
    });
    return NextResponse.json(
      {
        record: {
          id: record.id,
          pageId: record.pageId,
          parentRecordId: record.parentRecordId,
          mapX: record.mapX,
          mapY: record.mapY,
          sortOrder: record.sortOrder,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
