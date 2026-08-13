import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { enforceLimit, requireOwner } from "@/lib/api";
import {
  exchangeCode,
  googleUserInfo,
  microsoftUserInfo,
  verifiedGoogleIdentity,
} from "@/lib/oauth";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";
import { sealWorkspaceCredential } from "@/lib/workspace-secrets";
import { consumeOAuthConnectionState } from "@/lib/oauth-connection-state";
import { activeRequestSession } from "@/lib/oauth-request-session";

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
    const { user, workspace } = await requireOwner();
    await enforceLimit("cloud-oauth-callback", {
      limit: 20,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    const session = await activeRequestSession(req, user.id);
    if (!session) return back("cloud=failed");
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const consumed = await consumeOAuthConnectionState({
      session,
      provider,
      purpose: "cloud",
      state,
    });
    if (!consumed.ok || consumed.workspaceId !== workspace.id) return back("cloud=failed");

    const providerError = req.nextUrl.searchParams.get("error");
    if (providerError) {
      return back(providerError === "access_denied" ? "cloud=cancelled" : "cloud=failed");
    }
    if (!code) return back("cloud=failed");

    const token = await exchangeCode(
      provider,
      code,
      `${publicOrigin(req)}/api/cloud/callback/${provider}`
    );
    if (!token.refresh_token) return back("cloud=no-refresh-token");

    let email: string;
    if (provider === "google") {
      const identity = verifiedGoogleIdentity(await googleUserInfo(token.access_token));
      if (!identity) return back("cloud=failed");
      email = identity.email;
    } else {
      email = (await microsoftUserInfo(token.access_token)).email;
    }

    const updated = await prisma.workspace.updateMany({
      where: { id: consumed.workspaceId, ownerId: user.id },
      data: {
        cloudProvider: provider,
        cloudRefreshToken: sealWorkspaceCredential(
          consumed.workspaceId,
          provider,
          token.refresh_token
        ),
        cloudEmail: email,
        cloudFolderId: null,
        lastBackupError: null,
      },
    });
    if (updated.count !== 1) return back("cloud=failed");
    return back("cloud=connected");
  } catch (err) {
    console.error(
      "[keel] cloud connect failed",
      err instanceof Error ? err.name : "UnknownError"
    );
    return back("cloud=failed");
  }
}
