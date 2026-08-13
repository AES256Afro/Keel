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
 *  otherwise a pending invite awaiting verified signup or owner confirmation. */
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
      // Password registration cannot safely consume an email invite because
      // it does not prove control of that mailbox. The workspace owner is the
      // trusted party who confirms the now-existing account here. Upsert the
      // membership and remove the stale invite together so retries repair old
      // member-plus-invite duplicates without changing an established role.
      await prisma.$transaction([
        prisma.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: existing.id } },
          create: { workspaceId: workspace.id, userId: existing.id, role },
          update: {},
        }),
        prisma.workspaceInvite.deleteMany({
          where: { workspaceId: workspace.id, email },
        }),
      ]);
    } else {
      await prisma.workspaceInvite.upsert({
        where: { workspaceId_email: { workspaceId: workspace.id, email } },
        create: { workspaceId: workspace.id, email, role },
        update: { role },
      });
    }
    await audit("member.invite", user, {
      target: email,
      detail: { role, existingAccount: Boolean(existing) },
    });
    return NextResponse.json(await listMembersAndInvites(workspace.id, workspace.ownerId), {
      status: 201,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
