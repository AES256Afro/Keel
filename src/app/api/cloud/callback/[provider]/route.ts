import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/api";
import { exchangeCode, googleUserInfo, microsoftUserInfo } from "@/lib/oauth";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";

/** OAuth callback for cloud backup connections; stores the refresh token. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const back = (query: string) =>
    relativeRedirect(`/settings?${query}`);

  const { provider } = await params;
  if (provider !== "google" && provider !== "onedrive") return back("cloud=invalid");

  try {
    const { workspace } = await requireOwner();
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const expected = req.cookies.get("keel-oauth-state")?.value;
    if (!code || !state || !expected || state !== expected) return back("cloud=failed");

    const token = await exchangeCode(
      provider,
      code,
      `${publicOrigin(req)}/api/cloud/callback/${provider}`
    );
    if (!token.refresh_token) return back("cloud=no-refresh-token");

    const email =
      provider === "google"
        ? (await googleUserInfo(token.access_token)).email
        : (await microsoftUserInfo(token.access_token)).email;

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        cloudProvider: provider,
        cloudRefreshToken: token.refresh_token,
        cloudEmail: email,
        cloudFolderId: null,
        lastBackupError: null,
      },
    });
    const res = back("cloud=connected");
    res.cookies.delete("keel-oauth-state");
    return res;
  } catch (err) {
    console.error("[keel] cloud connect failed", err);
    return back("cloud=failed");
  }
}
