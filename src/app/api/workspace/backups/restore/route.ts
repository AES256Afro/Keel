import { NextRequest, NextResponse } from "next/server";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import {
  RestoreRefused,
  backupFileStream,
  readBackupStream,
  restoreSnapshot,
} from "@/lib/backup";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Restore one of the workspace's own backup files by name. Non-destructive:
 * the snapshot's content is recreated as new pages alongside what's there.
 *
 * The filename goes through backupFileStream(), which basenames it and
 * requires this workspace's backup prefix - so a caller can't read arbitrary
 * files by passing a path.
 */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    const body = await req.json().catch(() => ({}));

    const filename = String(body.filename ?? "").trim();
    if (!filename) throw new ApiError(400, "filename is required");
    const passphrase =
      typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined;

    // Streamed off disk rather than read into a string: a backup of a
    // workspace anywhere near its attachment quota is larger than a string can
    // be, and its own restore route refusing to read it would be absurd.
    let read;
    try {
      read = await readBackupStream(backupFileStream(workspace, filename), passphrase);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "Could not read that backup");
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
    const { rootPageIds, skippedAttachments } = restored;
    // A restore silently multiplies content; knowing who ran one matters.
    // The skip counts ride along because a restore that dropped attachments is
    // exactly the one someone will come back to the log asking about. Flat
    // numbers, not the nested report: audit's safeDetail() writes any object
    // value as the literal "[object]".
    await audit("backup.restore", user, {
      target: filename,
      detail: {
        restored: rootPageIds.length,
        skippedEmpty: skippedAttachments.empty,
        skippedTooLarge: skippedAttachments.tooLarge,
      },
    });
    return NextResponse.json({ restored: rootPageIds.length, rootPageIds, skippedAttachments });
  } catch (err) {
    return handleApiError(err);
  }
}
