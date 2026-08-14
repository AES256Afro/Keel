import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError, ApiError } from "@/lib/api";
import { assertBackupDirAllowed, backupDirFor, configuredBackupPassphrase } from "@/lib/backup";
import { isInstanceOwner } from "@/lib/instance";
import { MAX_NAME } from "@/lib/limits";

export async function GET() {
  try {
    const { user, workspace, role } = await requireContext();
    const workspaceOwner = role === "owner";
    const instanceOwner = workspaceOwner ? await isInstanceOwner(user) : false;
    const hasConfiguredPassphrase = workspaceOwner
      ? Boolean(await configuredBackupPassphrase())
      : true;
    return NextResponse.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        role,
        backupEnabled: workspace.backupEnabled,
        backupIntervalHours: workspace.backupIntervalHours,
        backupDir: workspaceOwner ? workspace.backupDir : null,
        backupResolvedDir: instanceOwner ? backupDirFor(workspace) : "",
        backupKeep: workspace.backupKeep,
        backupEncrypt: workspace.backupEncrypt,
        trashRetentionDays: workspace.trashRetentionDays,
        lastBackupAt: workspaceOwner ? workspace.lastBackupAt?.toISOString() ?? null : null,
        lastBackupError: workspaceOwner ? workspace.lastBackupError : null,
        hasScheduledPassphrase: hasConfiguredPassphrase,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user, workspace, role } = await requireContext();
    if (role !== "owner") throw new ApiError(403, "Only the workspace owner can change settings");
    const body = await req.json().catch(() => ({}));
    const instanceOwner = await isInstanceOwner(user);
    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      data.name = body.name.trim().slice(0, MAX_NAME);
    }
    if (typeof body.backupEnabled === "boolean") data.backupEnabled = body.backupEnabled;
    if (typeof body.backupIntervalHours === "number" && body.backupIntervalHours >= 1) {
      data.backupIntervalHours = Math.min(24 * 30, Math.round(body.backupIntervalHours));
    }
    if (typeof body.backupKeep === "number" && body.backupKeep >= 1) {
      data.backupKeep = Math.min(365, Math.round(body.backupKeep));
    }
    if (typeof body.backupEncrypt === "boolean") data.backupEncrypt = body.backupEncrypt;
    if (
      typeof body.trashRetentionDays === "number" &&
      Number.isFinite(body.trashRetentionDays) &&
      body.trashRetentionDays >= 0
    ) {
      data.trashRetentionDays = Math.min(3650, Math.round(body.trashRetentionDays));
    }
    if (body.backupDir === null || typeof body.backupDir === "string") {
      const dir = body.backupDir?.trim() || null;
      // Writing backups anywhere on the filesystem is an operator power, not a
      // per-workspace setting - see assertBackupDirAllowed.
      try {
        assertBackupDirAllowed(dir, { isInstanceOwner: instanceOwner });
      } catch (e) {
        throw new ApiError(403, e instanceof Error ? e.message : "That backup folder isn't allowed.");
      }
      data.backupDir = dir;
    }
    const updated = await prisma.workspace.update({ where: { id: workspace.id }, data });
    return NextResponse.json({
      workspace: {
        id: updated.id,
        name: updated.name,
        backupResolvedDir: instanceOwner ? backupDirFor(updated) : "",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
