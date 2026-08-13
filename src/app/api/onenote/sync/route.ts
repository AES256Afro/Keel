import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handleApiError, requireOwner } from "@/lib/api";
import { syncOneNote } from "@/lib/onenote";

function internalAuthorized(req: NextRequest) {
  const expected = process.env.KEEL_SYNC_SECRET ?? process.env.NOPIN_SYNC_SECRET;
  const supplied = req.headers.get("x-keel-sync-secret") ?? req.headers.get("x-nopin-sync-secret");
  return Boolean(expected && supplied && expected.length >= 32 && supplied === expected);
}

export async function POST(req: NextRequest) {
  try {
    if (internalAuthorized(req)) {
      const workspaces = await prisma.workspace.findMany({
        where: { oneNoteEnabled: true, oneNoteRefreshToken: { not: null } },
        select: { id: true },
      });
      const results = [];
      for (const workspace of workspaces) {
        results.push({ workspaceId: workspace.id, result: await syncOneNote(workspace.id) });
      }
      return NextResponse.json({ workspaces: results });
    }
    const { workspace } = await requireOwner();
    if (!workspace.oneNoteEnabled || !workspace.oneNoteRefreshToken) {
      throw new ApiError(400, "Connect OneNote first");
    }
    return NextResponse.json(await syncOneNote(workspace.id));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    const { workspace } = await requireOwner();
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        oneNoteRefreshToken: null,
        oneNoteEmail: null,
        oneNoteEnabled: false,
        oneNoteLastError: null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
