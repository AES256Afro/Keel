import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { listMembersAndInvites } from "@/lib/members";
import { audit } from "@/lib/audit";

export async function GET() {
  try {
    const { workspace } = await requireOwner();
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId));
  } catch (err) {
    return handleApiError(err);
  }
}

/** Invite someone by email: instant membership if they have an account,
 *  otherwise a pending invite applied when they register. */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const role = body.role === "viewer" ? "viewer" : "editor";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ApiError(400, "Enter a valid email address");
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      const already = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: existing.id } },
      });
      if (already) throw new ApiError(400, "That person is already a member");
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: existing.id, role },
      });
    } else {
      await prisma.workspaceInvite.upsert({
        where: { workspaceId_email: { workspaceId: workspace.id, email } },
        create: { workspaceId: workspace.id, email, role },
        update: { role },
      });
    }
    await audit("member.invite", user, { target: email, detail: { role } });
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId), {
      status: 201,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
