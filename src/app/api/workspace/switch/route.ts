import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setActiveWorkspace } from "@/lib/auth";
import { requireContext, handleApiError, ApiError } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireContext();
    const body = await req.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId ?? "");
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (!membership) throw new ApiError(404, "You are not a member of that workspace");
    await setActiveWorkspace(workspaceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
