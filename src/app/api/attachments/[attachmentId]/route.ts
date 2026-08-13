import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, requireEditor, handleApiError, ApiError } from "@/lib/api";
import { safeFilename } from "@/lib/attachments";

/**
 * A Content-Disposition value that survives any stored filename.
 *
 * Header values are ByteStrings, so one code point above 0xFF (CJK, emoji,
 * curly quotes) throws while the Response is being constructed - which used to
 * turn every GET of such an attachment into a permanent 500. RFC 6266/5987
 * shape instead: an ASCII-only `filename` fallback every client accepts, plus
 * - only when the fallback lost something - the true name percent-encoded
 * under `filename*=UTF-8''…`, which browsers prefer when present.
 */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  // safeFilename already removed quotes, backslashes and CR/LF, so the quoted
  // fallback cannot break out of its parameter; this only flattens what a
  // ByteString header cannot carry.
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  if (fallback === filename) return `${kind}; filename="${fallback}"`;
  // RFC 5987 ext-value: percent-encode everything outside attr-char.
  // encodeURIComponent leaves ' ( ) * bare, which are not attr-chars.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serve an attachment.
 *
 * Only the sniffed-at-upload inline types render in the browser; everything
 * else is forced to download. Every response is sandboxed and nosniffed, so
 * even a body that lies about itself gets no scripting context on this
 * origin - that is the entire defence against stored XSS via file upload.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
) {
  try {
    const { workspace } = await requireContext();
    const { attachmentId } = await params;

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
    });
    // Same 404 whether it doesn't exist or belongs to someone else - the
    // response must not confirm foreign ids.
    if (!attachment || attachment.workspaceId !== workspace.id) {
      throw new ApiError(404, "Not found");
    }

    const inline = attachment.mime !== "application/octet-stream";
    const name = safeFilename(attachment.name);

    return new NextResponse(new Uint8Array(attachment.data), {
      headers: {
        "Content-Type": inline ? attachment.mime : "application/octet-stream",
        "Content-Length": String(attachment.size),
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", name),
        // Rows are immutable - an id always serves the same bytes - so the
        // browser may cache hard. `private`: it still required a session.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { attachmentId } = await params;
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, workspaceId: true },
    });
    if (!attachment || attachment.workspaceId !== workspace.id) {
      throw new ApiError(404, "Not found");
    }
    await prisma.attachment.delete({ where: { id: attachment.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
