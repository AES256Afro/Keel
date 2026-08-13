import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireOwner, handleApiError, ApiError } from "@/lib/api";
import {
  CloudBackupTooLargeError,
  cloudConnected,
  downloadCloudBackupToFile,
  listCloudBackups,
} from "@/lib/cloud";
import { maxBackupUploadBytes } from "@/lib/limits";
import { RestoreRefused, readBackupStream, restoreSnapshot } from "@/lib/backup";
import { isEncryptedBackupName } from "@/lib/backup-format";
import { audit } from "@/lib/audit";

/** Restore a backup straight from Google Drive / OneDrive (non-destructive). */
export async function POST(req: NextRequest) {
  let spool: string | null = null;
  try {
    const { user, workspace } = await requireOwner();
    if (!cloudConnected(workspace)) throw new ApiError(400, "No cloud storage connected");
    const body = await req.json().catch(() => ({}));
    const fileId = String(body.id ?? "");
    if (!fileId) throw new ApiError(400, "id is required");
    const passphrase =
      typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined;

    // Resolve the id through the provider's backup listing first. Besides
    // recovering the trusted filename for the encryption boundary, this stops
    // a crafted id from reading an unrelated R2 or Azure object in the bucket.
    const selected = (await listCloudBackups(workspace)).find((file) => file.id === fileId);
    if (!selected) throw new ApiError(404, "That cloud backup is no longer available");
    const maxBytes = maxBackupUploadBytes();
    if (selected.size > maxBytes) {
      throw new ApiError(413, "Backup file too large");
    }

    spool = await fs.mkdtemp(path.join(os.tmpdir(), "keel-cloud-restore-"));
    const localFile = path.join(spool, "backup.bin");
    let read;
    try {
      await downloadCloudBackupToFile(workspace, fileId, localFile, {
        declaredSize: selected.size,
        maxBytes,
      });
      read = await readBackupStream(
        createReadStream(localFile),
        passphrase,
        isEncryptedBackupName(selected.name)
      );
    } catch (err) {
      if (err instanceof CloudBackupTooLargeError) {
        throw new ApiError(413, err.message);
      }
      throw new ApiError(400, err instanceof Error ? err.message : "Could not read cloud backup");
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
    await audit("backup.restore", user, {
      target: selected.name,
      detail: {
        source: workspace.cloudProvider ?? "cloud",
        restored: restored.rootPageIds.length,
        skippedEmpty: restored.skippedAttachments.empty,
        skippedTooLarge: restored.skippedAttachments.tooLarge,
      },
    });
    return NextResponse.json({
      restored: restored.rootPageIds.length,
      skippedAttachments: restored.skippedAttachments,
    });
  } catch (err) {
    return handleApiError(err);
  } finally {
    if (spool) await fs.rm(spool, { recursive: true, force: true }).catch(() => {});
  }
}
