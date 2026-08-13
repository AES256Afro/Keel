import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireEditor, requirePage, enforceLimit, handleApiError, ApiError } from "@/lib/api";
import { requireSameOriginMutation } from "@/lib/same-origin";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import {
  attachmentQuotaBytes,
  maxAttachmentBytes,
  safeFilename,
  sniffInlineMime,
} from "@/lib/attachments";
import {
  AttachmentUploadBusyError,
  withAttachmentUploadSlot,
} from "@/lib/attachment-upload-guard";
import {
  withWorkspaceStorageLock,
  workspaceStorageUsage,
} from "@/lib/workspace-storage";

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
    requireSameOriginMutation(req, "File uploads must come from the Keel site.");
    const { user, workspace } = await requireEditor();
    await enforceLimit("attachment-upload", { limit: 30, windowMs: 60_000, userId: user.id });

    try {
      return await withAttachmentUploadSlot(async () => {
        const cap = maxAttachmentBytes();
        const message = `File too large - the limit is ${Math.round(cap / 1048576)} MB`;
        // Multipart framing is small, but cap it explicitly before formData()
        // can buffer an attacker-controlled body without a trustworthy length.
        let raw: Uint8Array;
        try {
          raw = await readBoundedRequestBody(req, cap + 16_384, message);
        } catch (err) {
          if (err instanceof RequestBodyTooLargeError) throw new ApiError(413, err.message);
          throw err;
        }
        const bounded = new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: Buffer.from(raw),
        });
        const form = await bounded.formData();
        const file = form.get("file");
        const pageId = form.get("pageId");
        if (!(file instanceof File) || typeof pageId !== "string") {
          throw new ApiError(400, "Expected multipart form data with `file` and `pageId`");
        }
        await requirePage(pageId, workspace.id);

        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length === 0) throw new ApiError(400, "Empty file");
        if (bytes.length > cap) throw new ApiError(413, message);

        const mime = sniffInlineMime(bytes) ?? "application/octet-stream";
        const attachment = await withWorkspaceStorageLock(workspace.id, async () => {
          const used = await workspaceStorageUsage(workspace.id);
          const quota = attachmentQuotaBytes();
          if (used.totalBytes + bytes.length > quota) {
            throw new ApiError(
              413,
              `Workspace attachment storage is full (${Math.round(quota / 1048576)} MB) - delete some files first`
            );
          }
          return prisma.attachment.create({
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
        });

        return NextResponse.json(
          { attachment: { ...attachment, url: `/api/attachments/${attachment.id}` } },
          { status: 201 }
        );
      });
    } catch (err) {
      if (err instanceof AttachmentUploadBusyError) throw new ApiError(503, err.message);
      throw err;
    }
  } catch (err) {
    return handleApiError(err);
  }
}
