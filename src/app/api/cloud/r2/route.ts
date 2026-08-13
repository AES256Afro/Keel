import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import { normalizeR2Config, r2TestConnection } from "@/lib/cloud";
import { audit } from "@/lib/audit";
import { sealWorkspaceCredential } from "@/lib/workspace-secrets";

/** Connect Cloudflare R2 as the cloud backup target (owner-only). Credentials
 *  are validated by listing the bucket, then stored on the workspace. */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    const b = await req.json().catch(() => ({}));

    const bucket = String(b.bucket ?? "").trim();
    const accessKeyId = String(b.accessKeyId ?? "").trim();
    const secretKey = String(b.secretKey ?? "").trim();
    // Accept either a full endpoint or just the account id.
    let endpoint = String(b.endpoint ?? "").trim();
    const accountId = String(b.accountId ?? "").trim();
    if (!endpoint && accountId) endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    if (!endpoint || !bucket || !accessKeyId || !secretKey) {
      throw new ApiError(400, "Endpoint (or account ID), bucket, access key and secret are required.");
    }

    // The server makes signed requests to this endpoint, so it is an SSRF
    // boundary, not a formality - the same reason parseAzureSasUrl pins its
    // host. Without this, any workspace owner (which is every account) could
    // point the endpoint at http://169.254.169.254 or an internal host:port
    // and use the connection test as a blind internal probe. R2 endpoints are
    // always https on <account>.r2.cloudflarestorage.com; nothing else is R2.
    const cfg = normalizeR2Config({ endpoint, bucket, accessKeyId, secretKey });
    if (!cfg) {
      throw new ApiError(
        400,
        "Use a Cloudflare R2 endpoint and a 3-63 character lowercase bucket name."
      );
    }
    try {
      await r2TestConnection(cfg);
    } catch (e) {
      throw new ApiError(400, `Couldn't reach R2: ${e instanceof Error ? e.message : "unknown error"}`);
    }

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        cloudProvider: "r2",
        cloudRefreshToken: sealWorkspaceCredential(
          workspace.id,
          "r2",
          JSON.stringify(cfg)
        ),
        cloudEmail: `R2: ${bucket}`,
        cloudFolderId: null,
      },
    });
    await audit("cloud.connect", user, {
      target: workspace.id,
      detail: { provider: "r2", bucket, endpoint },
    });
    return NextResponse.json({ ok: true, email: `R2: ${bucket}` });
  } catch (err) {
    return handleApiError(err);
  }
}
