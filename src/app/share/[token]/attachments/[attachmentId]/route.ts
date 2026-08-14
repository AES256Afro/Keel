import { NextResponse } from "next/server";
import { enforceLimit, handleApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { resolvePageShare } from "@/lib/page-share";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; attachmentId: string }> }
) {
  try {
    const { token, attachmentId } = await params;
    await enforceLimit("public-page-attachment", { limit: 240, windowMs: 60_000 });
    const share = await resolvePageShare(token);
    if (!share) return new NextResponse("Not found", { status: 404 });
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.pageId !== share.page.id || attachment.workspaceId !== share.page.workspaceId) {
      return new NextResponse("Not found", { status: 404 });
    }
    return new NextResponse(new Uint8Array(attachment.data), {
      headers: {
        "Content-Type": attachment.mime,
        "Content-Length": String(attachment.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
