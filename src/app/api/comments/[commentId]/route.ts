import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError, ApiError } from "@/lib/api";

async function requireManageableComment(commentId: string, userId: string, workspaceId: string, role: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { page: true },
  });
  if (!comment || comment.page.workspaceId !== workspaceId) {
    throw new ApiError(404, "Comment not found");
  }
  if (comment.authorId !== userId && role !== "owner") {
    throw new ApiError(403, "Only the author or the workspace owner can manage this comment");
  }
  return comment;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  try {
    const { user, workspace, role } = await requireContext();
    const { commentId } = await params;
    const comment = await requireManageableComment(commentId, user.id, workspace.id, role);
    const body = await req.json().catch(() => ({}));
    if (typeof body.resolved === "boolean") {
      await prisma.comment.update({
        where: { id: comment.id },
        data: { resolvedAt: body.resolved ? new Date() : null },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  try {
    const { user, workspace, role } = await requireContext();
    const { commentId } = await params;
    const comment = await requireManageableComment(commentId, user.id, workspace.id, role);
    await prisma.comment.delete({ where: { id: comment.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
