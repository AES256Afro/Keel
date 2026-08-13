import { NextRequest, NextResponse } from "next/server";
import { requireContext, requirePage, handleApiError } from "@/lib/api";
import { getBacklinks } from "@/lib/links";

/** Pages that link here, with the text around each link. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { workspace } = await requireContext();
    const { pageId } = await params;
    // Scoped, so a page id from another workspace reveals nothing.
    await requirePage(pageId, workspace.id);
    return NextResponse.json({ backlinks: await getBacklinks(pageId) });
  } catch (err) {
    return handleApiError(err);
  }
}
