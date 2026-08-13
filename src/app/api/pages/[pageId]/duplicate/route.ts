import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requirePage, handleApiError, ApiError } from "@/lib/api";
import { RestoreRefused, snapshotWorkspace, restoreSnapshot } from "@/lib/backup";

/** Deep-copy a page (or database) subtree, including records and values. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace } = await requireEditor();
    const { pageId } = await params;
    const page = await requirePage(pageId, workspace.id);
    if (page.type === "record") {
      throw new ApiError(400, "Duplicate the database instead of a single record");
    }
    const snapshot = await snapshotWorkspace(workspace.id, page.id);
    // A duplicate is a restore, so it goes through the same attachment quota
    // check - and can be refused by it. A refusal is about this workspace's
    // limits, not about anything being broken: the operator needs the message
    // (which names the knob to turn), not a generic 500.
    let restored;
    try {
      restored = await restoreSnapshot(snapshot, {
        workspaceId: workspace.id,
        userId: user.id,
        parentPageId: page.parentPageId,
        rootTitle: `${page.title || "Untitled"} (copy)`,
        sortOrderBase: page.sortOrder + 0.5,
      });
    } catch (err) {
      if (err instanceof RestoreRefused) throw new ApiError(400, err.message);
      throw err;
    }
    return NextResponse.json(
      {
        pageId: restored.rootPageIds[0],
        // Same shape as the three restore routes. A duplicate can skip rows
        // too (an over-cap live attachment), and a skipped id is deliberately
        // left out of the id map - so the copy keeps pointing at the ORIGINAL's
        // row, to break the day the original is deleted. The sidebar says so.
        skippedAttachments: restored.skippedAttachments,
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
