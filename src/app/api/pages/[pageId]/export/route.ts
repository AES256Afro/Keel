import { NextRequest, NextResponse } from "next/server";
import { requireContext, requirePage, handleApiError } from "@/lib/api";
import { tiptapToMarkdown } from "@/lib/markdown";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { workspace } = await requireContext();
    const { pageId } = await params;
    const page = await requirePage(pageId, workspace.id);
    const markdown = tiptapToMarkdown(page.content, page.title || "Untitled");
    const filename = (page.title || "untitled").replace(/[^\w\- ]+/g, "").trim() || "untitled";
    return new NextResponse(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.md"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
