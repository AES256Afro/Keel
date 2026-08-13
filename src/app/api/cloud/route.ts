import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

/** Disconnect cloud backups. Local backups and already-uploaded files stay. */
export async function DELETE() {
  try {
    const { user, workspace } = await requireOwner();
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { cloudProvider: null, cloudRefreshToken: null, cloudEmail: null, cloudFolderId: null },
    });
    await audit("cloud.disconnect", user, { target: workspace.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
