import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { listMembersAndInvites } from "@/lib/members";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ inviteId: string }> }
) {
  try {
    const { workspace } = await requireOwner();
    const { inviteId } = await params;
    const invite = await prisma.workspaceInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.workspaceId !== workspace.id) {
      throw new ApiError(404, "Invite not found");
    }
    await prisma.workspaceInvite.delete({ where: { id: invite.id } });
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId));
  } catch (err) {
    return handleApiError(err);
  }
}
