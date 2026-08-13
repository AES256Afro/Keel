import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

export const ONENOTE_ASSET_NAME = /^onenote-[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/;

const globalForStorage = globalThis as typeof globalThis & {
  keelWorkspaceStorageLocks?: Map<string, Promise<void>>;
};
const workspaceLocks =
  globalForStorage.keelWorkspaceStorageLocks ?? new Map<string, Promise<void>>();
globalForStorage.keelWorkspaceStorageLocks = workspaceLocks;

export type WorkspaceStorageUsage = {
  attachmentBytes: number;
  oneNoteBytes: number;
  oneNoteFiles: number;
  oneNoteNames: Set<string>;
  totalBytes: number;
};

export function workspaceAssetsDir(workspaceId: string): string {
  const configured = process.env.NOPIN_UPLOAD_DIR;
  if (configured) {
    return path.join(/* turbopackIgnore: true */ configured, workspaceId);
  }
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "uploads",
    workspaceId
  );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Serialize storage quota decisions for one workspace across every backing
 * store. The attachment route and OneNote sync must both hold this lock from
 * their final combined-usage check through their write. */
export async function withWorkspaceStorageLock<T>(
  workspaceId: string,
  work: () => Promise<T>
): Promise<T> {
  const prior = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceLocks.set(workspaceId, current);
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (workspaceLocks.get(workspaceId) === current) workspaceLocks.delete(workspaceId);
  }
}

/** Count only OneNote assets Keel itself can name and serve. Unrelated files
 * in a custom upload directory cannot consume or disguise workspace quota. */
export async function oneNoteStorageUsage(workspaceId: string): Promise<{
  bytes: number;
  files: number;
  names: Set<string>;
}> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(
      /* turbopackIgnore: true */ workspaceAssetsDir(workspaceId),
      { withFileTypes: true }
    );
  } catch (error) {
    if (isMissingFile(error)) entries = [];
    else throw error;
  }

  let bytes = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !ONENOTE_ASSET_NAME.test(entry.name)) continue;
    try {
      const file = await fs.stat(
        /* turbopackIgnore: true */ path.join(workspaceAssetsDir(workspaceId), entry.name)
      );
      if (!file.isFile()) continue;
      names.add(entry.name);
      bytes += file.size;
    } catch (error) {
      // Cleanup may remove an unreferenced image while usage is being read.
      // A disappearing file only frees space, so it is safe to ignore.
      if (!isMissingFile(error)) throw error;
    }
  }
  return { bytes, files: names.size, names };
}

/** Combined workspace storage usage. Tests for an injected OneNote budget set
 * includeAttachments=false, which keeps those deterministic filesystem-only
 * checks away from the live database. */
export async function workspaceStorageUsage(
  workspaceId: string,
  options: {
    includeAttachments?: boolean;
    oneNoteUsage?: { bytes: number; names: Set<string> };
  } = {}
): Promise<WorkspaceStorageUsage> {
  const includeAttachments = options.includeAttachments ?? true;
  const [oneNote, attachments] = await Promise.all([
    options.oneNoteUsage
      ? Promise.resolve({
          bytes: options.oneNoteUsage.bytes,
          files: options.oneNoteUsage.names.size,
          names: options.oneNoteUsage.names,
        })
      : oneNoteStorageUsage(workspaceId),
    includeAttachments
      ? prisma.attachment.aggregate({
          where: { workspaceId },
          _sum: { size: true },
        })
      : Promise.resolve({ _sum: { size: null } }),
  ]);
  const attachmentBytes = attachments._sum.size ?? 0;
  return {
    attachmentBytes,
    oneNoteBytes: oneNote.bytes,
    oneNoteFiles: oneNote.files,
    oneNoteNames: oneNote.names,
    totalBytes: attachmentBytes + oneNote.bytes,
  };
}
