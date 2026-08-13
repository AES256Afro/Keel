import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import os from "os";
import path from "path";
import { StringDecoder } from "string_decoder";
import { NextRequest, NextResponse } from "next/server";
import { requireEditor, enforceLimit, handleApiError, ApiError } from "@/lib/api";
import { RestoreRefused, readBackupStream, restoreSnapshot } from "@/lib/backup";
import { maxBackupUploadBytes } from "@/lib/limits";
import { audit } from "@/lib/audit";
import { requireSameOriginMutation } from "@/lib/same-origin";

export const runtime = "nodejs";

const CRLF = Buffer.from("\r\n");
/** Non-file form fields are passphrases and flags, never documents. */
const MAX_FIELD = 64 * 1024;
/** A part's headers. Real ones are a few hundred bytes. */
const MAX_PART_HEADERS = 16 * 1024;

/**
 * Read a multipart/form-data body without materializing it.
 *
 * `req.formData()` cannot be used here. Undici parses the whole body into
 * in-memory Blobs - measured at ~800 MB of RSS for a 400 MB upload - and a
 * workspace at the default attachment quota legitimately produces a backup
 * several gigabytes long. Since maxBackupUploadBytes() now honestly admits
 * files that big, the route that accepts them cannot be the thing that holds
 * them.
 *
 * So the body is scanned for boundaries as it arrives: small fields are
 * collected as text, and the one file part is spooled straight to `spoolFile`.
 * Spooled rather than piped directly into the parser because the passphrase
 * field may legally arrive AFTER the file, and a decrypting reader needs it
 * first - memory stays bounded either way, which is the property that matters.
 */
async function spoolUpload(
  req: NextRequest,
  spoolFile: string
): Promise<{ fields: Map<string, string>; bytes: number; filename: string | null }> {
  const contentType = req.headers.get("content-type") ?? "";
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!/^multipart\/form-data/i.test(contentType) || !match) {
    throw new ApiError(400, "Expected a multipart/form-data upload");
  }
  const delim = Buffer.from(`\r\n--${match[1] ?? match[2]}`);
  const body = req.body;
  if (!body) throw new ApiError(400, "No backup file uploaded");
  const reader = body.getReader();

  // The synthetic leading CRLF lets the very first `--boundary` match the same
  // delimiter as every later one.
  let buf: Buffer = Buffer.from(CRLF);
  let ended = false;
  const fill = async (): Promise<boolean> => {
    if (ended) return false;
    const next = await reader.read();
    if (next.done) {
      ended = true;
      return false;
    }
    buf = Buffer.concat([buf, Buffer.from(next.value)]);
    return true;
  };
  const malformed = (): never => {
    throw new ApiError(400, "The upload ended before the backup file did");
  };

  const fields = new Map<string, string>();
  let bytes = 0;
  let filename: string | null = null;
  let sink: ReturnType<typeof createWriteStream> | null = null;
  // Resolves once the chunk is flushed, which is the backpressure: the reader
  // above cannot run ahead of the disk.
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      sink!.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  try {
    // Skip the preamble up to the first boundary. Bounded: a body that never
    // produces a boundary must not be buffered forever.
    for (;;) {
      const at = buf.indexOf(delim);
      if (at !== -1) {
        buf = buf.subarray(at + delim.length);
        break;
      }
      if (buf.length > MAX_PART_HEADERS) throw new ApiError(400, "Malformed upload");
      if (!(await fill())) malformed();
    }

    for (;;) {
      while (buf.length < 2) if (!(await fill())) malformed();
      // "--" after a boundary closes the body.
      if (buf[0] === 0x2d && buf[1] === 0x2d) break;
      for (;;) {
        const nl = buf.indexOf(CRLF);
        if (nl !== -1) {
          buf = buf.subarray(nl + 2);
          break;
        }
        if (buf.length > MAX_PART_HEADERS) throw new ApiError(400, "Malformed upload");
        if (!(await fill())) malformed();
      }

      // Part headers.
      let headerEnd = -1;
      for (;;) {
        headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd !== -1) break;
        if (buf.length > MAX_PART_HEADERS) throw new ApiError(400, "Malformed upload");
        if (!(await fill())) malformed();
      }
      const headers = buf.subarray(0, headerEnd).toString("latin1");
      buf = buf.subarray(headerEnd + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1] ?? "";
      const partFile = /filename="([^"]*)"/i.exec(headers)?.[1] ?? null;
      const isFile = partFile !== null && name === "file";
      if (isFile) {
        filename = partFile;
        sink ??= createWriteStream(spoolFile);
      }

      // Part body, up to the next boundary. `keep` holds back the bytes a
      // delimiter straddling two chunks would need.
      const keep = delim.length - 1;
      // Field text goes through a StringDecoder rather than a per-piece
      // toString("utf8"). The flush below cuts at `buffered - keep`, a byte
      // offset chosen by the delimiter's length and by where the network split
      // the body - nowhere near a character boundary. Decoding each piece on
      // its own turns a multi-byte character straddling that cut into U+FFFD,
      // which for the one field that matters here means a correct non-ASCII
      // passphrase is rejected as "Wrong passphrase (or corrupted backup)".
      // The decoder carries the partial sequence across instead.
      const isField = partFile === null;
      const decoder = isField ? new StringDecoder("utf8") : null;
      let text = "";
      for (;;) {
        const at = buf.indexOf(delim);
        if (at !== -1) {
          const piece = buf.subarray(0, at);
          if (isFile) {
            bytes += piece.length;
            await write(piece);
          } else if (decoder) {
            // end() flushes any trailing partial sequence - at the real end of
            // the field's bytes it is genuinely truncated input, not a cut.
            text += decoder.write(piece) + decoder.end();
          }
          buf = buf.subarray(at + delim.length);
          break;
        }
        if (buf.length > keep) {
          const piece = buf.subarray(0, buf.length - keep);
          if (isFile) {
            bytes += piece.length;
            await write(piece);
          } else if (decoder) {
            text += decoder.write(piece);
            if (text.length > MAX_FIELD) throw new ApiError(400, "Malformed upload");
          }
          buf = Buffer.from(buf.subarray(buf.length - keep));
        }
        if (bytes > maxBackupUploadBytes()) throw new ApiError(413, "Backup file too large");
        if (!(await fill())) malformed();
      }
      if (isField && name) fields.set(name, text);
    }
  } finally {
    if (sink) await new Promise<void>((resolve) => sink!.end(resolve));
    await reader.cancel().catch(() => {});
  }

  return { fields, bytes, filename };
}

/**
 * Restore a backup file into the workspace. Non-destructive: the backup's
 * content is recreated as new pages alongside existing content.
 *
 * Nothing on this path holds the file. The upload is spooled to a temp file as
 * it arrives, readBackupStream() walks that file structurally and spools the
 * attachment bytes separately, and the restore reads them back one row at a
 * time - so a multi-gigabyte backup, which a workspace at the default
 * attachment quota legitimately produces, imports with memory bounded by its
 * largest single attachment.
 */
export async function POST(req: NextRequest) {
  let spool: string | null = null;
  try {
    requireSameOriginMutation(req, "Imports must come from the Keel site.");
    const { user, workspace } = await requireEditor();
    // Streams an upload up to maxBackupUploadBytes() and writes thousands of rows.
    await enforceLimit("import", { limit: 5, windowMs: 10 * 60_000, userId: user.id });

    spool = await fs.mkdtemp(path.join(os.tmpdir(), "keel-import-"));
    const upload = path.join(spool, "upload.bin");
    const { fields, bytes, filename } = await spoolUpload(req, upload);
    if (filename === null || bytes === 0) throw new ApiError(400, "No backup file uploaded");
    const passphrase = fields.get("passphrase") || undefined;

    let read;
    try {
      read = await readBackupStream(createReadStream(upload), passphrase);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "Invalid backup");
    }

    let restored;
    try {
      restored = await restoreSnapshot(read.snapshot, {
        workspaceId: workspace.id,
        userId: user.id,
        attachmentBytes: read.attachmentBytes,
      });
    } catch (err) {
      // A refusal is about this workspace's limits, not about the file being
      // broken - the operator needs the message, not a generic 500.
      if (err instanceof RestoreRefused) throw new ApiError(400, err.message);
      throw err;
    } finally {
      await read.dispose();
    }

    // The skip counts ride along because an import that dropped attachments is
    // exactly the one someone will come back to the log asking about. Flat
    // numbers, not the nested report: audit's safeDetail() writes any object
    // value as the literal "[object]".
    await audit("workspace.import", user, {
      target: workspace.id,
      detail: {
        restored: restored.rootPageIds.length,
        bytes,
        skippedEmpty: restored.skippedAttachments.empty,
        skippedTooLarge: restored.skippedAttachments.tooLarge,
      },
    });
    return NextResponse.json({
      restored: restored.rootPageIds.length,
      rootPageIds: restored.rootPageIds,
      skippedAttachments: restored.skippedAttachments,
    });
  } catch (err) {
    return handleApiError(err);
  } finally {
    if (spool) await fs.rm(spool, { recursive: true, force: true }).catch(() => {});
  }
}
