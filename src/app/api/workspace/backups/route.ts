import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireOwner, handleApiError, ApiError, enforceLimit } from "@/lib/api";
import {
  BackupInProgressError,
  configuredBackupPassphrase,
  listBackups,
  runBackup,
} from "@/lib/backup";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** The workspace's on-disk backup files, newest first. */
export async function GET() {
  try {
    const { workspace } = await requireOwner();
    return NextResponse.json({ backups: await listBackups(workspace) });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * "Back up now" - write a snapshot to the backup folder and, when cloud storage
 * is connected, upload it off-site.
 *
 * `encrypt` lets the caller encrypt this one backup without changing the
 * workspace's saved setting. The passphrase is taken from the request, falling
 * back to the instance owner's write-only managed secret or environment override.
 */
export async function POST(req: NextRequest) {
  try {
    const { user, workspace } = await requireOwner();
    // Snapshots the entire workspace, serializes it, optionally derives a
    // scrypt key and uploads it - strictly more work than the exports that are
    // already budgeted, so it gets the same treatment.
    await enforceLimit("workspace-backup", { limit: 6, windowMs: 60_000, userId: user.id });
    const body = await req.json().catch(() => ({}));

    const encrypt =
      typeof body.encrypt === "boolean" ? body.encrypt : workspace.backupEncrypt;
    const passphrase =
      typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined;

    if (encrypt && !passphrase && !(await configuredBackupPassphrase())) {
      throw new ApiError(
        400,
        "Encrypted backups need a passphrase. Enter one, or ask the instance owner to configure the scheduled-backup secret in Settings or the host environment."
      );
    }

    let result;
    try {
      result = await runBackup({ ...workspace, backupEncrypt: encrypt }, passphrase);
    } catch (err) {
      if (err instanceof BackupInProgressError) {
        throw new ApiError(409, err.message);
      }
      const message = err instanceof Error ? err.message : "Backup failed";
      // Surface the failure in Settings on the next load, not just in the log.
      await prisma.workspace
        .update({ where: { id: workspace.id }, data: { lastBackupError: message } })
        .catch(() => {});
      throw new ApiError(500, message);
    }

    await audit("backup.run", user, {
      target: workspace.id,
      detail: { encrypted: encrypt, cloud: result.cloud ?? null },
    });
    return NextResponse.json({
      // Workspace owners need the filename for restore/UI feedback, never the
      // server's absolute filesystem layout.
      file: path.basename(result.file),
      cloud: result.cloud ?? null,
      backups: await listBackups(workspace),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
