import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requirePage, handleApiError } from "@/lib/api";
import { createDatabasePage, createDocumentPage } from "@/lib/pages";
import { MAX_TITLE } from "@/lib/limits";
import { resolveLinksTo } from "@/lib/links";

export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireEditor();
    const body = await req.json().catch(() => ({}));
    const type = body.type === "database" ? "database" : "document";
    // The parent must live in this workspace - otherwise the tree can be wired
    // across workspace boundaries (PATCH has always checked this; POST didn't).
    const parentPageId = typeof body.parentPageId === "string" ? body.parentPageId : null;
    if (parentPageId) await requirePage(parentPageId, workspace.id);
    const opts = {
      workspaceId: workspace.id,
      userId: user.id,
      parentPageId,
      title: typeof body.title === "string" ? body.title.slice(0, MAX_TITLE) : "",
    };
    const page =
      type === "database" ? await createDatabasePage(opts) : await createDocumentPage(opts);

    // Someone may already have written [[this title]] before the page existed.
    if (page.title) {
      await resolveLinksTo({ id: page.id, workspaceId: workspace.id, title: page.title });
    }

    return NextResponse.json({ page: { id: page.id, type: page.type } }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
