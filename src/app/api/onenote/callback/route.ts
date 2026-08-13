import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { enforceLimit, requireOwner } from "@/lib/api";
import { exchangeCode } from "@/lib/oauth";
import { oneNoteAccount } from "@/lib/onenote";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";
import { sealWorkspaceCredential } from "@/lib/workspace-secrets";
import { consumeOAuthConnectionState } from "@/lib/oauth-connection-state";
import { activeRequestSession } from "@/lib/oauth-request-session";

export async function GET(req: NextRequest) {
  const back = (status: string) =>
    relativeRedirect(`/settings?onenote=${status}`);
  try {
    const { user, workspace } = await requireOwner();
    await enforceLimit("onenote-oauth-callback", {
      limit: 20,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    const session = await activeRequestSession(req, user.id);
    if (!session) return back("failed");
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const consumed = await consumeOAuthConnectionState({
      session,
      provider: "onedrive",
      purpose: "onenote",
      state,
    });
    if (!consumed.ok || consumed.workspaceId !== workspace.id) return back("failed");
    const providerError = req.nextUrl.searchParams.get("error");
    if (providerError) {
      return back(providerError === "access_denied" ? "cancelled" : "failed");
    }
    if (!code) return back("failed");
    const token = await exchangeCode(
      "onedrive",
      code,
      `${publicOrigin(req)}/api/onenote/callback`
    );
    if (!token.refresh_token) return back("no-refresh-token");
    const email = await oneNoteAccount(token.access_token);
    const updated = await prisma.workspace.updateMany({
      where: { id: consumed.workspaceId, ownerId: user.id },
      data: {
        oneNoteRefreshToken: sealWorkspaceCredential(
          consumed.workspaceId,
          "oneNote",
          token.refresh_token
        ),
        oneNoteEmail: email,
        oneNoteEnabled: true,
        oneNoteLastError: null,
      },
    });
    if (updated.count !== 1) return back("failed");
    return back("connected");
  } catch (error) {
    console.error(
      "[keel] OneNote connection failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    return back("failed");
  }
}
