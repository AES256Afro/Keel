import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { azureTestConnection } from "@/lib/cloud";
import { audit } from "@/lib/audit";
import { sealWorkspaceCredential } from "@/lib/workspace-secrets";

/**
 * Connect Azure Blob Storage as the backup target (owner-only).
 *
 * One input: a container SAS URL. It is validated structurally (https, a real
 * *.blob.core.windows.net host - the server fetches this URL, so arbitrary
 * hosts would be SSRF) and then proven by actually listing the container, so
 * a wrong-permission SAS fails here with a clear message instead of at 3 a.m.
 * when the nightly backup does.
 */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    const b = await req.json().catch(() => ({}));
    const sasUrl = String(b.sasUrl ?? "").trim();
    if (!sasUrl) throw new ApiError(400, "Paste the container's Blob SAS URL.");

    let cfg;
    try {
      cfg = await azureTestConnection(sasUrl);
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : "Couldn't reach Azure.");
    }

    const container = cfg.base.split("/").pop();
    const account = new URL(cfg.base).hostname.split(".")[0];
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        cloudProvider: "azure",
        cloudRefreshToken: sealWorkspaceCredential(workspace.id, "azure", sasUrl),
        cloudEmail: `Azure: ${account}/${container}`,
        cloudFolderId: null,
      },
    });
    // The SAS itself never goes to the audit log - it IS the credential.
    await audit("cloud.connect", user, {
      target: workspace.id,
      detail: { provider: "azure", account, container },
    });
    return NextResponse.json({ ok: true, email: `Azure: ${account}/${container}` });
  } catch (err) {
    return handleApiError(err);
  }
}
