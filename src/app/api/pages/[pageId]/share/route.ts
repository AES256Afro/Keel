import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { ApiError, enforceLimit, handleApiError, requireOwner, requirePage } from "@/lib/api";
import {
  PAGE_SHARE_EXPIRY_DAYS,
  issuePageShare,
  pageShareStatus,
  revokePageShare,
} from "@/lib/page-share";
import { requireJsonRequest } from "@/lib/same-origin";

async function shareablePage(pageId: string) {
  const { user, workspace } = await requireOwner();
  const page = await requirePage(pageId, workspace.id);
  if (page.type !== "document" || page.archivedAt || page.externalSource) {
    throw new ApiError(400, "Only an active Keel document can be shared publicly");
  }
  return { user, page };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { pageId } = await params;
    await shareablePage(pageId);
    return NextResponse.json(await pageShareStatus(pageId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    requireJsonRequest(req, "Share settings must be sent as JSON.");
    const { pageId } = await params;
    const { user, page } = await shareablePage(pageId);
    await enforceLimit("page-share-create", { limit: 10, windowMs: 10 * 60_000, userId: user.id });
    const body = await req.json().catch(() => ({}));
    const expiresInDays = body.expiresInDays === null ? null : Number(body.expiresInDays);
    if (expiresInDays !== null && !PAGE_SHARE_EXPIRY_DAYS.has(expiresInDays)) {
      throw new ApiError(400, "Choose a 1, 7, 30, or 90 day expiry, or no expiry");
    }
    const result = await issuePageShare({
      pageId: page.id,
      createdById: user.id,
      expiresInDays,
    });
    await audit("page.share.create", user, {
      target: page.id,
      detail: { expiresInDays },
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { pageId } = await params;
    const { user, page } = await shareablePage(pageId);
    await enforceLimit("page-share-revoke", { limit: 20, windowMs: 10 * 60_000, userId: user.id });
    const revoked = await revokePageShare(page.id);
    if (revoked) await audit("page.share.revoke", user, { target: page.id });
    return NextResponse.json({ revoked }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
