import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, handleApiError, ApiError } from "@/lib/api";
import {
  assertCanReparent,
  needsRenumber,
  renumber,
  sortOrderBetween,
  TreeError,
} from "@/lib/record-tree";

/**
 * Structural updates to a record: where it sits in the tree, where its node
 * sits on the mind-map canvas, whether its branch is folded, and where it sits
 * among its siblings.
 *
 * Separate from /values, which changes what a record *says*. This changes where
 * it *is* - and both the board and the mind map are just different ways of
 * expressing that, so they share this endpoint.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ recordId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { recordId } = await params;

    const record = await prisma.databaseRecord.findUnique({
      where: { id: recordId },
      include: { database: { select: { workspaceId: true } } },
    });
    if (!record || record.database.workspaceId !== workspace.id) {
      throw new ApiError(404, "Record not found");
    }

    const body = await req.json().catch(() => ({}));
    const data: Record<string, unknown> = {};

    // ---- Tree position ------------------------------------------------------
    // Validated inside the write transaction below, not here: a check that runs
    // before the write can pass for two concurrent reparents that jointly form
    // a cycle.
    if (body.parentRecordId !== undefined) {
      data.parentRecordId =
        typeof body.parentRecordId === "string" && body.parentRecordId ? body.parentRecordId : null;
    }

    // ---- Mind-map canvas position ------------------------------------------
    // Both or neither: a half-placed node has no meaning.
    if (body.mapX !== undefined || body.mapY !== undefined) {
      const x = Number(body.mapX);
      const y = Number(body.mapY);
      if (body.mapX === null && body.mapY === null) {
        data.mapX = null; // back to auto-layout
        data.mapY = null;
      } else if (Number.isFinite(x) && Number.isFinite(y)) {
        // Clamp to a sane canvas so one bad drag can't send a node to infinity
        // and make every other node render as a dot.
        data.mapX = Math.max(-100_000, Math.min(100_000, x));
        data.mapY = Math.max(-100_000, Math.min(100_000, y));
      } else {
        throw new ApiError(400, "mapX and mapY must both be numbers, or both null.");
      }
    }

    if (typeof body.collapsed === "boolean") data.collapsed = body.collapsed;

    // ---- Order among siblings / within a board column ----------------------
    // The client sends the two records it was dropped between; the server picks
    // the midpoint. That keeps reordering to a single-row write, and means two
    // people dragging at once can't stomp each other's whole column.
    if (body.between !== undefined) {
      const { beforeId, afterId } = (body.between ?? {}) as {
        beforeId?: string | null;
        afterId?: string | null;
      };
      const neighbours = await prisma.databaseRecord.findMany({
        where: {
          id: { in: [beforeId, afterId].filter((v): v is string => typeof v === "string") },
          databaseId: record.databaseId,
        },
        select: { id: true, sortOrder: true },
      });
      const before = neighbours.find((n) => n.id === beforeId)?.sortOrder ?? null;
      const after = neighbours.find((n) => n.id === afterId)?.sortOrder ?? null;
      data.sortOrder = sortOrderBetween(before, after);

      // Floats run out of room after ~50 splits between the same pair; when
      // that happens, renumber the whole database rather than silently
      // producing an unstable order.
      if (needsRenumber(before, after)) {
        const all = await prisma.databaseRecord.findMany({
          where: { databaseId: record.databaseId },
          orderBy: { sortOrder: "asc" },
          select: { id: true },
        });
        await renumber(all.map((r) => r.id));
        const refreshed = await prisma.databaseRecord.findMany({
          where: {
            id: { in: [beforeId, afterId].filter((v): v is string => typeof v === "string") },
          },
          select: { id: true, sortOrder: true },
        });
        data.sortOrder = sortOrderBetween(
          refreshed.find((n) => n.id === beforeId)?.sortOrder ?? null,
          refreshed.find((n) => n.id === afterId)?.sortOrder ?? null
        );
      }
    } else if (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)) {
      data.sortOrder = body.sortOrder;
    }

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    let updated;
    try {
      // The cycle walk and the write commit together or not at all. SQLite
      // serializes writers, so one transaction closes the window where two
      // concurrent reparents each see the other's edge as not-yet-written.
      updated = await prisma.$transaction(async (tx) => {
        if (data.parentRecordId !== undefined) {
          await assertCanReparent(record.id, data.parentRecordId as string | null, tx);
        }
        return tx.databaseRecord.update({ where: { id: record.id }, data });
      });
    } catch (e) {
      if (e instanceof TreeError) throw new ApiError(400, e.message);
      throw e;
    }
    return NextResponse.json({
      record: {
        id: updated.id,
        parentRecordId: updated.parentRecordId,
        mapX: updated.mapX,
        mapY: updated.mapY,
        collapsed: updated.collapsed,
        sortOrder: updated.sortOrder,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
