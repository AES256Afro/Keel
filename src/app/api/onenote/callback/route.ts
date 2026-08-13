import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/api";
import { exchangeCode } from "@/lib/oauth";
import { oneNoteAccount } from "@/lib/onenote";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";

export async function GET(req: NextRequest) {
  const back = (status: string) =>
    relativeRedirect(`/settings?onenote=${status}`);
  try {
    const { workspace } = await requireOwner();
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const expected = req.cookies.get("nopin-onenote-state")?.value;
    if (!code || !state || !expected || state !== expected) return back("failed");
    const token = await exchangeCode(
      "onedrive",
      code,
      `${publicOrigin(req)}/api/onenote/callback`
    );
    if (!token.refresh_token) return back("no-refresh-token");
    const email = await oneNoteAccount(token.access_token);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        oneNoteRefreshToken: token.refresh_token,
        oneNoteEmail: email,
        oneNoteEnabled: true,
        oneNoteLastError: null,
      },
    });
    const response = back("connected");
    response.cookies.delete("nopin-onenote-state");
    return response;
  } catch (error) {
    console.error("[nopin] OneNote connection failed", error);
    return back("failed");
  }
}
