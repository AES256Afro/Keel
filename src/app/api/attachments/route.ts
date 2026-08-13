import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireEditor, requirePage, enforceLimit, handleApiError, ApiError } from "@/lib/api";
import {
  attachmentQuotaBytes,
  maxAttachmentBytes,
  safeFilename,
  sniffInlineMime,
} from "@/lib/attachments";

/**
 * Upload a file onto a page.
 *
 * multipart/form-data: `file` (the bytes), `pageId` (its home).
 *
 * Viewers can't upload (requireEditor); the page must be in the caller's
 * workspace; the size cap is checked twice - Content-Length up front so an
 * oversized body is refused before it is buffered, and the real byte length
 * afterwards because Content-Length is a claim, not a fact.
 */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireEditor();
    await enforceLimit("attachment-upload", { limit: 30, windowMs: 60_000, userId: user.id });

    const cap = maxAttachmentBytes();
    const claimed = Number(req.headers.get("content-length") ?? 0);
    if (claimed > cap + 16_384) {
      throw new ApiError(413, `File too large - the limit is ${Math.round(cap / 1048576)} MB`);
    }

    const form = await req.formData();
    const file = form.get("file");
    const pageId = form.get("pageId");
    if (!(file instanceof File) || typeof pageId !== "string") {
      throw new ApiError(400, "Expected multipart form data with `file` and `pageId`");
    }
    await requirePage(pageId, workspace.id);

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) throw new ApiError(400, "Empty file");
    if (bytes.length > cap) {
      throw new ApiError(413, `File too large - the limit is ${Math.round(cap / 1048576)} MB`);
    }

    // Quota - the sum of what this workspace already stores.
    const used = await prisma.attachment.aggregate({
      where: { workspaceId: workspace.id },
      _sum: { size: true },
    });
    const quota = attachmentQuotaBytes();
    if ((used._sum.size ?? 0) + bytes.length > quota) {
      throw new ApiError(
        413,
        `Workspace attachment storage is full (${Math.round(quota / 1048576)} MB) - delete some files first`
      );
    }

    // The stored type is what the bytes say, never what the client claims. A
    // body that doesn't sniff as an inline-safe type is an opaque download.
    const mime = sniffInlineMime(bytes) ?? "application/octet-stream";

    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: workspace.id,
        pageId,
        name: safeFilename(file.name || "file"),
        mime,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes,
        createdById: user.id,
      },
      select: { id: true, name: true, mime: true, size: true },
    });

    return NextResponse.json(
      { attachment: { ...attachment, url: `/api/attachments/${attachment.id}` } },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
