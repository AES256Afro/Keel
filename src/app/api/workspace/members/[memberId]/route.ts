import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { listMembersAndInvites } from "@/lib/members";
import { audit } from "@/lib/audit";

async function requireMember(memberId: string, workspaceId: string, ownerId: string) {
  const member = await prisma.workspaceMember.findUnique({ where: { id: memberId } });
  if (!member || member.workspaceId !== workspaceId) throw new ApiError(404, "Member not found");
  if (member.userId === ownerId) {
    throw new ApiError(400, "The workspace owner's access cannot be changed");
  }
  return member;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> }
) {
  try {
    const { user, workspace } = await requireOwner();
    const { memberId } = await params;
    const member = await requireMember(memberId, workspace.id, workspace.ownerId);
    const body = await req.json().catch(() => ({}));
    const role = body.role === "viewer" ? "viewer" : "editor";
    await prisma.workspaceMember.update({ where: { id: member.id }, data: { role } });
    await audit("member.role", user, {
      target: member.userId,
      detail: { from: member.role, to: role },
    });
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> }
) {
  try {
    const { user, workspace } = await requireOwner();
    const { memberId } = await params;
    const member = await requireMember(memberId, workspace.id, workspace.ownerId);
    await prisma.workspaceMember.delete({ where: { id: member.id } });
    await audit("member.remove", user, { target: member.userId });
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId));
  } catch (err) {
    return handleApiError(err);
  }
}
