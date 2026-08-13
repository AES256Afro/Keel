import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requirePage, handleApiError, ApiError } from "@/lib/api";
import { createFromTemplate, TEMPLATES } from "@/lib/templates";

export async function GET() {
  return NextResponse.json({
    templates: TEMPLATES.map(({ key, name, icon, description, kind }) => ({
      key,
      name,
      icon,
      description,
      kind,
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireEditor();
    const body = await req.json().catch(() => ({}));
    const key = String(body.key ?? "");
    const parentPageId =
      typeof body.parentPageId === "string" ? body.parentPageId : null;
    if (parentPageId) await requirePage(parentPageId, workspace.id);
    // Only the expected client mistake is a 400. Everything else out of
    // createFromTemplate - SQLITE_BUSY, a transaction timeout - is a
    // transient server failure: handleApiError turns it into a logged,
    // retryable 500 instead of a raw internal message stamped "client error".
    if (!TEMPLATES.some((t) => t.key === key)) {
      throw new ApiError(400, "Unknown template");
    }
    const { pageId } = await createFromTemplate(key, {
      workspaceId: workspace.id,
      userId: user.id,
      parentPageId,
    });
    return NextResponse.json({ pageId }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
