import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { cloudConnected, uploadBackupToCloud } from "@/lib/cloud";
import { documentToPlainText } from "@/lib/plaintext";
import { extractLinks, normalizeTitle } from "@/lib/links";
import { isViewType, sanitizeConfig, serializeViewConfig } from "@/lib/views";
import {
  attachmentQuotaBytes,
  maxAttachmentBytes,
  safeFilename,
  sniffInlineMime,
} from "@/lib/attachments";
import {
  MAX_NAME,
  MAX_RESTORED_CONTENT,
  MAX_RESTORED_ROW,
  MAX_TITLE,
  MAX_VALUE,
} from "@/lib/limits";
import { keelEnv, keelFlag } from "@/lib/env";
import { resolveScheduledBackupPassphrase } from "@/lib/instance-settings";
import {
  ENCRYPTED_EXTENSION,
  backupPrefixes,
  isBackupName,
  isEncryptedBackupName,
} from "@/lib/backup-format";

/**
 * Snapshot / restore engine.
 *
 * A snapshot is a plain-JSON copy of a workspace (or of a single page subtree).
 * The same format powers: full-workspace backup files, download/upload export,
 * restore, and page duplication (snapshot a subtree, restore it next to the
 * original with fresh IDs).
 *
 * ---------------------------------------------------------------------------
 * Why nothing here builds the file as one string
 * ---------------------------------------------------------------------------
 *
 * Version 3 put attachment bytes inside the JSON as base64. That is the right
 * file format - a backup that doesn't carry your images is not a backup - but
 * the obvious implementation (`JSON.stringify(snapshot)`) has a hard ceiling:
 * V8 refuses to create a string longer than 536,870,888 characters. With the
 * default 2048 MB attachment quota, base64 alone reaches that at ~400 MB of
 * attachments, and the encrypted envelope's second base64 pass reaches it at
 * ~300 MB. Past those points backup and Settings -> Export threw RangeError -
 * the data-safety feature failing exactly on the workspaces that need it, and
 * (because the scheduler never advanced anything on failure) re-failing every
 * five minutes forever.
 *
 * So the whole path is incremental in both directions:
 *
 *   write  snapshotChunks() / backupChunks() are async generators. The
 *          non-attachment sections are serialized section by section, then
 *          each attachment's bytes are loaded, base64-encoded in slices and
 *          written out, one attachment at a time. runBackup() pipes that into
 *          a file; the export route pipes it into the HTTP response.
 *
 *   read   readBackupStream() scans the JSON structurally as chunks arrive,
 *          parsing one array element at a time, and spools attachment bytes to
 *          a temp directory instead of holding them. restoreSnapshot() then
 *          reads them back one at a time as it inserts.
 *
 * What that bounds, and what it does not. Attachment bytes - the only
 * individually enormous thing in a backup - are never resident on either path:
 * the writer encodes one row at a time and the reader spools each `data` value
 * straight to disk, so the peak is one attachment rather than the workspace
 * total. The other sections ARE materialized; a snapshot object holds every
 * page, record and value row, by construction, because a restore needs them
 * all at once. Those are bounded by the per-section row caps (SECTION_CAPS
 * below), which the reader enforces AS ROWS ARRIVE. They used to run only
 * after the whole file had been parsed, which made them unable to refuse the
 * very files they existed for: a row-heavy file exhausted the heap first.
 *
 * The on-disk format is unchanged: a v3 file written by the streaming writer
 * is byte-for-byte the shape the old JSON.stringify produced, so old files
 * restore and new files are readable by anything that could read a v3 file
 * before.
 */

export interface Snapshot {
  format: "keel-backup" | "nopin-backup";
  // Version 2 added the record tree/layout fields and `views`; version 3 added
  // `attachments`. Every addition is optional on read, so a version-1 or -2
  // file restores forever - a backup format that expires is not a backup
  // format.
  version: 1 | 2 | 3;
  exportedAt: string;
  workspace: { name: string };
  pages: {
    id: string;
    parentPageId: string | null;
    type: string;
    title: string;
    icon: string | null;
    content: string | null;
    sortOrder: number;
    archivedAt: string | null;
  }[];
  databases: { id: string; pageId: string }[];
  properties: {
    id: string;
    databaseId: string;
    name: string;
    type: string;
    settings: string | null;
    sortOrder: number;
  }[];
  records: {
    id: string;
    databaseId: string;
    pageId: string;
    sortOrder: number;
    // Tree and mind-map layout. Absent in version-1 snapshots, which restore
    // as a flat, auto-laid-out set - the pre-tree shape they were saved from.
    parentRecordId?: string | null;
    mapX?: number | null;
    mapY?: number | null;
    collapsed?: boolean;
  }[];
  values: { recordId: string; propertyId: string; value: string | null }[];
  // Saved views. Absent in version-1 snapshots; a restored database with no
  // views renders the virtual fallback set, same as any view-less database.
  views?: {
    databaseId: string;
    name: string;
    type: string;
    sortOrder: number;
    config: string | null;
  }[];
  // Attachment rows. Absent before version 3 - those snapshots restore
  // documents whose embedded /api/attachments/<id> URLs point at whatever rows
  // still exist, which is what they always did. From version 3 the bytes
  // travel in the file, restore mints fresh rows, and the URLs in restored
  // content are remapped to them - so a restore on a fresh instance (or after
  // the original pages were hard-deleted) keeps its images, and a duplicate is
  // self-contained instead of borrowing the original's rows. `size`/`mime` are
  // informational: restore derives both (and sha256) from the actual bytes,
  // exactly as the upload path does, so a hand-edited file cannot claim a type
  // its bytes don't have.
  //
  // `data` is the base64 of the bytes AS THEY APPEAR IN A FILE - 4/3 inflation,
  // which is why attachment-heavy workspaces produce visibly larger backups.
  // It is optional in memory: snapshotWorkspace() deliberately leaves it out
  // and readBackupStream() spools it to disk, because materializing every
  // attachment's base64 at once is the ceiling this module exists to avoid. A
  // row without `data` means "the bytes live outside this object" - see
  // AttachmentBytes and resolveAttachmentBytes below for where they are found.
  attachments?: {
    id: string;
    pageId: string;
    name: string;
    mime: string;
    size: number;
    data?: string;
  }[];
}

/**
 * Where an attachment's bytes live when the snapshot object doesn't carry them.
 *
 * Deliberately a caller-supplied object rather than a field on the snapshot: a
 * snapshot can arrive from a hostile file, and a *file* must never be able to
 * name a byte source (a filesystem path, another workspace's row). Only the
 * code that built the stream gets to say where the bytes are.
 */
export interface AttachmentBytes {
  /** Exact decoded byte length, or null when this source doesn't have the id. */
  size(id: string): Promise<number | null>;
  /** The bytes. Called once per attachment, at insert time. */
  read(id: string): Promise<Buffer<ArrayBuffer>>;
}

interface EncryptedEnvelope {
  format: "keel-backup-encrypted" | "nopin-backup-encrypted";
  // 1: `data` is the whole ciphertext, written after `tag`, produced by one
  //    JSON.stringify - so it could never exceed V8's string ceiling.
  // 2: identical fields, but `tag` is written AFTER `data` because a streaming
  //    writer only learns the GCM tag once the last byte is enciphered. Both
  //    are plain JSON and both parse with JSON.parse, so a v2 envelope is
  //    readable by anything that could read a v1 one.
  version: 1 | 2;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  data: string;
}

/**
 * Snapshot the whole workspace, or only the subtree rooted at `rootPageId`.
 *
 * The returned attachment rows carry metadata only - no `data`. Callers that
 * need the bytes get them from the live rows the ids name (restoreSnapshot and
 * the streaming writer both do this, one attachment at a time); a snapshot
 * object that carried every attachment's base64 would be the ~400 MB ceiling
 * this module is built to avoid.
 */
export async function snapshotWorkspace(
  workspaceId: string,
  rootPageId?: string
): Promise<Snapshot> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const databases = await prisma.database.findMany({ where: { workspaceId } });

  let pages: Awaited<ReturnType<typeof prisma.page.findMany>>;
  if (rootPageId) {
    // Subtree snapshot (duplicate). Fetch only the subtree by descending
    // parent → children, not the whole workspace - duplicating one small page
    // must not load thousands of unrelated pages into memory.
    const root = await prisma.page.findFirst({ where: { id: rootPageId, workspaceId } });
    const collected: typeof pages = root ? [root] : [];
    const seen = new Set(collected.map((p) => p.id));
    const collectSubtrees = async (rootIds: string[]) => {
      let frontier = rootIds;
      while (frontier.length) {
        const children = await prisma.page.findMany({
          where: { workspaceId, parentPageId: { in: frontier } },
          orderBy: { sortOrder: "asc" },
        });
        frontier = [];
        for (const p of children) {
          if (seen.has(p.id)) continue; // defensive: a parent cycle must not spin
          seen.add(p.id);
          collected.push(p);
          frontier.push(p.id);
        }
      }
    };
    await collectSubtrees(collected.map((p) => p.id));

    // A record page of an in-scope database can sit OUTSIDE the walked
    // subtree: un-archiving a record page while its parent is still trashed
    // detaches it to the workspace root, and the generic move endpoint
    // accepts any page type. Views still show such records (they read the
    // DatabaseRecord rows), and restoreInto normalizes every record page back
    // under its database's page - so the snapshot must carry them, or a
    // duplicate silently loses records its views display. Fixpoint, because a
    // pulled-in page can host a nested database with detached records of its
    // own.
    for (;;) {
      const inScopeDbIds = databases.filter((d) => seen.has(d.pageId)).map((d) => d.id);
      const recordPages = await prisma.databaseRecord.findMany({
        where: { databaseId: { in: inScopeDbIds } },
        select: { pageId: true },
      });
      const missing = [...new Set(recordPages.map((r) => r.pageId))].filter(
        (id) => !seen.has(id)
      );
      if (missing.length === 0) break;
      // Mark before fetching: a row deleted between the two queries must not
      // keep the loop spinning on an id that will never turn up.
      for (const id of missing) seen.add(id);
      const detached: typeof pages = [];
      for (let i = 0; i < missing.length; i += 500) {
        detached.push(
          ...(await prisma.page.findMany({
            where: { workspaceId, id: { in: missing.slice(i, i + 500) } },
            orderBy: { sortOrder: "asc" },
          }))
        );
      }
      collected.push(...detached);
      await collectSubtrees(detached.map((p) => p.id));
    }
    pages = collected;
  } else {
    pages = await prisma.page.findMany({
      where: { workspaceId },
      orderBy: { sortOrder: "asc" },
    });
  }

  const pageIds = new Set(pages.map((p) => p.id));
  const inScopeDbs = databases.filter((d) => pageIds.has(d.pageId));
  const dbIds = inScopeDbs.map((d) => d.id);
  const properties = await prisma.databaseProperty.findMany({
    where: { databaseId: { in: dbIds } },
    orderBy: { sortOrder: "asc" },
  });
  const records = await prisma.databaseRecord.findMany({
    where: { databaseId: { in: dbIds } },
    orderBy: { sortOrder: "asc" },
  });
  const inScopeRecords = records.filter((r) => pageIds.has(r.pageId));
  const inScopeRecordIds = new Set(inScopeRecords.map((r) => r.id));
  const values = await prisma.databaseValue.findMany({
    where: { recordId: { in: [...inScopeRecordIds] } },
  });
  const views = await prisma.databaseView.findMany({
    where: { databaseId: { in: dbIds } },
    orderBy: { sortOrder: "asc" },
  });

  // Attachment bytes exist ONLY in these rows - the editor embeds
  // /api/attachments/<id> URLs, and a snapshot without the rows restores
  // documents whose images 404 forever. Whole-workspace snapshots can filter
  // by workspaceId (uploads are always tied to a page in their workspace);
  // subtree snapshots go through the page list, chunked to stay under
  // SQLite's bound-parameter cap.
  //
  // `select` without `data`: this query used to pull every attachment's bytes
  // into one array, which alone put the whole workspace's attachments in
  // memory before a single byte was encoded. The bytes are fetched later, one
  // row at a time, by whoever actually needs them.
  const attachmentColumns = {
    id: true,
    pageId: true,
    name: true,
    mime: true,
    size: true,
  } as const;
  let attachments: { id: string; pageId: string; name: string; mime: string; size: number }[];
  if (rootPageId) {
    attachments = [];
    const ids = [...pageIds];
    for (let i = 0; i < ids.length; i += 500) {
      attachments.push(
        ...(await prisma.attachment.findMany({
          where: { pageId: { in: ids.slice(i, i + 500) } },
          orderBy: { createdAt: "asc" },
          select: attachmentColumns,
        }))
      );
    }
  } else {
    attachments = await prisma.attachment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: attachmentColumns,
    });
  }

  return {
    format: "keel-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    workspace: { name: workspace.name },
    pages: pages.map((p) => ({
      id: p.id,
      parentPageId: p.parentPageId,
      type: p.type,
      title: p.title,
      icon: p.icon,
      content: p.content,
      sortOrder: p.sortOrder,
      archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
    })),
    databases: inScopeDbs.map((d) => ({ id: d.id, pageId: d.pageId })),
    properties: properties.map((p) => ({
      id: p.id,
      databaseId: p.databaseId,
      name: p.name,
      type: p.type,
      settings: p.settings,
      sortOrder: p.sortOrder,
    })),
    records: inScopeRecords.map((r) => ({
      id: r.id,
      databaseId: r.databaseId,
      pageId: r.pageId,
      sortOrder: r.sortOrder,
      parentRecordId: r.parentRecordId,
      mapX: r.mapX,
      mapY: r.mapY,
      collapsed: r.collapsed,
    })),
    // Set membership, not Array.some inside filter: the latter is O(values x
    // records), which on a 10k-record workspace is ~10^9 comparisons per
    // backup - and the scheduler runs this on a timer.
    values: values
      .filter((v) => inScopeRecordIds.has(v.recordId))
      .map((v) => ({ recordId: v.recordId, propertyId: v.propertyId, value: v.value })),
    views: views.map((v) => ({
      databaseId: v.databaseId,
      name: v.name,
      type: v.type,
      sortOrder: v.sortOrder,
      config: v.config,
    })),
    // No `data`: see the note on Snapshot.attachments.
    attachments: attachments.map((a) => ({
      id: a.id,
      pageId: a.pageId,
      name: a.name,
      mime: a.mime,
      size: a.size,
    })),
  };
}

/**
 * The bytes behind a snapshot produced by snapshotWorkspace(): the live
 * Attachment rows its ids name, read one at a time.
 *
 * `workspaceId` scopes the lookup when the snapshot came from a file rather
 * than from snapshotWorkspace(). A hand-edited backup can list any attachment
 * id it likes with no `data`; scoping to the restore's own workspace means the
 * worst it can do is copy a row the caller could already read.
 */
function liveAttachmentBytes(
  db: Prisma.TransactionClient | typeof prisma,
  workspaceId?: string
): AttachmentBytes {
  const where = (id: string) => (workspaceId ? { id, workspaceId } : { id });
  return {
    async size(id) {
      const row = await db.attachment.findFirst({
        where: where(id),
        select: { size: true },
      });
      return row ? row.size : null;
    },
    async read(id) {
      const row = await db.attachment.findFirst({ where: where(id), select: { data: true } });
      return row ? (Buffer.from(row.data) as Buffer<ArrayBuffer>) : Buffer.alloc(0);
    },
  };
}

/** The bytes a file carried inline, as base64 on the snapshot rows themselves. */
function inlineAttachmentBytes(snapshot: Snapshot): AttachmentBytes {
  const byId = new Map<string, string>();
  for (const a of snapshot.attachments ?? []) {
    if (a.data !== undefined && !byId.has(a.id)) byId.set(a.id, a.data);
  }
  return {
    async size(id) {
      const b64 = byId.get(id);
      if (b64 === undefined) return null;
      // Decode and discard rather than estimating: Buffer.byteLength()
      // over-reports for base64 containing characters outside the alphabet,
      // and the "an empty decode is skipped" rule has to agree exactly with
      // what read() will produce.
      return Buffer.from(b64, "base64").length;
    },
    async read(id) {
      return Buffer.from(byId.get(id) ?? "", "base64");
    },
  };
}

/**
 * Attachment bytes spooled to a temp directory by the streaming reader.
 *
 * `file` is null for a row whose bytes went past the per-file cap while they
 * were streaming in: the count is kept so the restore can report it as
 * too-large rather than as missing, but nothing beyond the cap was written to
 * disk - a hand-built file must not be able to fill the disk with an
 * attachment the restore was always going to refuse.
 */
function spooledAttachmentBytes(
  files: Map<string, { file: string | null; bytes: number }>
): AttachmentBytes {
  return {
    async size(id) {
      return files.get(id)?.bytes ?? null;
    },
    async read(id) {
      const entry = files.get(id);
      return entry?.file ? ((await fs.readFile(entry.file)) as Buffer<ArrayBuffer>) : Buffer.alloc(0);
    },
  };
}

/**
 * How many rows a section may carry.
 *
 * The import route accepts files up to maxBackupUploadBytes(), which can
 * validly encode hundreds of thousands of rows - enough to burn the restore
 * transaction's whole budget while holding SQLite's single write slot, roll
 * back at the timeout, and fail identically on every retry. These bounds are
 * far above any real workspace, so the only files they refuse are ones that
 * could never restore anyway.
 *
 * Shared by the validator and the streaming reader on purpose. The validator
 * can only check a list it already holds, which is too late to protect the
 * heap; the reader checks the same numbers as each row is pushed, so a
 * row-heavy file is refused at the row that crosses the cap. Two copies of
 * these numbers would be two chances for the two paths to disagree about which
 * files exist.
 */
const SECTION_CAPS = {
  pages: 200_000,
  databases: 50_000,
  properties: 100_000,
  records: 500_000,
  values: 2_000_000,
  views: 100_000,
  attachments: 50_000,
} as const;

/**
 * Minimal structural validation of a snapshot.
 *
 * parseBackup() accepts any JSON carrying the right `format` string, and a
 * truncated download or hand-edited file can carry that string while missing
 * whole sections. The restore used to discover that halfway through its
 * writes; checking shape up front means a corrupt file fails before the first
 * row is touched. Deliberately minimal - lists are lists, required strings
 * are strings, numbers are numbers - so every historical file that once
 * restored still does (version-1 files omit the optional fields, and that
 * stays legal).
 */
function assertSnapshotShape(snapshot: unknown): asserts snapshot is Snapshot {
  const bad = (what: string): never => {
    throw new Error(`Not a valid Keel backup file (${what}).`);
  };
  const str = (v: unknown) => typeof v === "string";
  // Primary ids seed the restore's id maps; an empty string is shape-valid
  // garbage that silently cross-wires those maps, so ids must be non-empty.
  const id = (v: unknown) => typeof v === "string" && v.length > 0;
  const strOrNull = (v: unknown) => v == null || typeof v === "string";
  // A date string feeds `new Date()` inside the transaction, where an
  // unparseable value throws as an unclassified 500 - refuse it here instead.
  const dateOrNull = (v: unknown) =>
    v == null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const numOrNull = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v));
  // Structure first, then the row-count gate (SECTION_CAPS). A file read
  // through readBackupStream has already been held to these as it streamed;
  // repeating them here is what covers snapshots that never went through the
  // reader - parseBackup's buffered path, and restoreSnapshot's own door.
  const rows = (v: unknown, cap: number, what: string): Record<string, unknown>[] => {
    if (!Array.isArray(v) || !v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
      bad(`${what} is not a list of ${what}`);
    }
    const list = v as Record<string, unknown>[];
    if (list.length > cap) bad(`the ${what} section is implausibly large`);
    return list;
  };

  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    bad("not a snapshot object");
  }
  const s = snapshot as Record<string, unknown>;

  const pages = rows(s.pages, SECTION_CAPS.pages, "pages");
  for (const p of pages) {
    if (!id(p.id) || !str(p.type) || !str(p.title)) bad("a page row is malformed");
    if (!strOrNull(p.parentPageId) || !strOrNull(p.icon) || !strOrNull(p.content)) {
      bad("a page row is malformed");
    }
    if (!dateOrNull(p.archivedAt) || !num(p.sortOrder)) bad("a page row is malformed");
    if (p.content != null) {
      // No size ceiling here. This validator runs at restoreSnapshot's door,
      // where the snapshot may have been built in-process from rows that
      // already exist (page duplication, templates) - refusing those refuses a
      // page the workspace is already storing, which is how the previous
      // MAX_CONTENT check here turned duplicating a big page into a 500 and
      // made Keel's own backups unrestorable. Size is a question about a FILE,
      // so the two file readers ask it: see applyFileLimits (MAX_RESTORED_CONTENT).
      //
      // The restore derives plainText from this content inside the
      // transaction, and documentToPlainText throws on shape-valid hostile
      // documents (marks: 5, marks: [null], …). Probe it out here so the
      // failure is this validator's clear 400, not a mid-transaction 500.
      try {
        documentToPlainText(p.content as string);
      } catch {
        bad("a page's content is not a valid document");
      }
    }
  }

  const databases = rows(s.databases, SECTION_CAPS.databases, "databases");
  for (const d of databases) {
    if (!id(d.id) || !id(d.pageId)) bad("a database row is malformed");
  }

  const properties = rows(s.properties, SECTION_CAPS.properties, "properties");
  for (const p of properties) {
    if (!id(p.id) || !id(p.databaseId) || !str(p.name) || !str(p.type)) {
      bad("a property row is malformed");
    }
    if (!strOrNull(p.settings) || !num(p.sortOrder)) bad("a property row is malformed");
  }

  const records = rows(s.records, SECTION_CAPS.records, "records");
  for (const r of records) {
    if (!id(r.id) || !id(r.databaseId) || !id(r.pageId) || !num(r.sortOrder)) {
      bad("a record row is malformed");
    }
    if (!strOrNull(r.parentRecordId) || !numOrNull(r.mapX) || !numOrNull(r.mapY)) {
      bad("a record row is malformed");
    }
    if (r.collapsed != null && typeof r.collapsed !== "boolean") bad("a record row is malformed");
  }

  const values = rows(s.values, SECTION_CAPS.values, "values");
  for (const v of values) {
    if (!id(v.recordId) || !id(v.propertyId) || !strOrNull(v.value)) {
      bad("a value row is malformed");
    }
  }

  // Optional forever: version-1 snapshots have no `views` key.
  if (s.views != null) {
    const views = rows(s.views, SECTION_CAPS.views, "views");
    for (const v of views) {
      if (!id(v.databaseId) || !str(v.name) || !str(v.type)) bad("a view row is malformed");
      if (!num(v.sortOrder) || !strOrNull(v.config)) bad("a view row is malformed");
    }
  }

  // Optional forever: only version-3 snapshots carry attachment bytes.
  if (s.attachments != null) {
    const attachments = rows(s.attachments, SECTION_CAPS.attachments, "attachments");
    for (const a of attachments) {
      if (!id(a.id) || !id(a.pageId) || !str(a.name) || !str(a.mime)) {
        bad("an attachment row is malformed");
      }
      // `data` is optional in memory (snapshotWorkspace omits it, the
      // streaming reader spools it) but must be base64 text when present.
      if (!num(a.size)) bad("an attachment row is malformed");
      if (a.data !== undefined && !str(a.data)) bad("an attachment row is malformed");
    }
  }
}

/**
 * Hold a snapshot that arrived as a FILE to the per-column limits the write
 * APIs enforce.
 *
 * Applied by the two readers (readBackupStream, parseBackup) rather than by
 * restoreSnapshot, because it is a statement about provenance, not about
 * shape. A snapshot built in-process - page duplication, templates - describes
 * rows this database already holds, and clamping or refusing those would only
 * break the feature; a file describes rows an editor is asking to create, and
 * import is otherwise the one way in that skips every ceiling limits.ts
 * exists to impose. The round-12 fix covered exactly one of the four columns,
 * and covered it in the one place that also broke duplication.
 *
 * Skip-vs-refuse-vs-clamp is decided per column by what the live write path
 * does with an over-length value, because whatever a restore does differently
 * is a row no API could have produced:
 *
 *   title, property/view name - CLAMP. The routes slice (pages route,
 *     properties route, views route); a restore that refused instead would
 *     make a workspace whose titles came from an uncapped writer (the OneNote
 *     mirror does not slice) permanently unrestorable, and dropping the page
 *     to save its title is not a trade a restore gets to make.
 *   database value, property settings - DROP the cell. Both are JSON, so
 *     truncating them yields a string the grid cannot parse: corruption
 *     dressed as a fix. The write paths answer 413, and the nearest honest
 *     equivalent when there is no request to answer is the same state as a
 *     value that was never set. Nothing Keel writes can reach this: both
 *     writers refuse over MAX_VALUE outright.
 *   page content - REFUSE the file, at MAX_RESTORED_CONTENT rather than at
 *     MAX_CONTENT. See the note on MAX_RESTORED_CONTENT for why the save
 *     limit is the wrong number here.
 */
function applyFileLimits(snapshot: Snapshot): void {
  for (const page of snapshot.pages) {
    if (page.content != null && page.content.length > MAX_RESTORED_CONTENT) {
      throw new Error(
        `Not a valid Keel backup file (a page's content is larger than this build can restore).`
      );
    }
    if (page.title.length > MAX_TITLE) page.title = page.title.slice(0, MAX_TITLE);
  }
  for (const property of snapshot.properties) {
    if (property.name.length > MAX_NAME) property.name = property.name.slice(0, MAX_NAME);
    if (property.settings != null && property.settings.length > MAX_VALUE) {
      property.settings = null;
    }
  }
  for (const view of snapshot.views ?? []) {
    if (view.name.length > MAX_NAME) view.name = view.name.slice(0, MAX_NAME);
  }
  // Rebuilt rather than spliced: an in-place filter over a two-million-row
  // array is the one place here where the copy is cheaper than the shuffle.
  if (snapshot.values.some((v) => v.value != null && v.value.length > MAX_VALUE)) {
    snapshot.values = snapshot.values.filter(
      (v) => v.value == null || v.value.length <= MAX_VALUE
    );
  }
}

/**
 * A restore refused because the file, though structurally valid, asks for more
 * than the workspace's configured limits allow.
 *
 * Separate from the shape errors above because it is not a claim about the
 * file: the same file restores fine into a workspace with room. Routes turn it
 * into a 400 with the message intact, so the operator is told which limit and
 * by how much rather than getting an opaque failure.
 */
export class RestoreRefused extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefused";
  }
}

interface RestoreOptions {
  workspaceId: string;
  userId: string;
  /** Attach restored root pages under this page (null = workspace root). */
  parentPageId?: string | null;
  /** Rename the first root page (used by duplicate: "Title (copy)"). */
  rootTitle?: string;
  /** Place first root page right after this sort position. */
  sortOrderBase?: number;
  /**
   * Where the snapshot's attachment bytes are, when its rows carry no `data`.
   * Supplied by whoever produced the snapshot - never by the snapshot itself.
   * Defaults to the destination workspace's own live rows, which is what a
   * duplicate (snapshot a subtree, restore it beside the original) needs.
   */
  attachmentBytes?: AttachmentBytes;
}

/** What a restore chose not to bring in, for the caller to report. */
export interface RestoreReport {
  rootPageIds: string[];
  /** Attachments skipped, by reason. Empty on a clean restore. */
  skippedAttachments: {
    /** Bytes that wouldn't decode, or a row whose page wasn't restored. */
    empty: number;
    /** Bigger than the per-file cap the upload path enforces. */
    tooLarge: number;
  };
}

/**
 * Recreate a snapshot's content inside a workspace with fresh IDs.
 * Existing content is never touched; restored pages appear as a new subtree.
 *
 * The whole restore is one transaction. It used to be hundreds of loose
 * writes, so an import that failed partway (corrupt file, restart,
 * SQLITE_BUSY) committed a half-restored tree - and a retry then duplicated
 * whatever had landed, the exact failure the template path's transaction
 * exists to prevent. Now it all lands or none of it does. The timeout is
 * generous because a workspace import can legitimately be tens of thousands
 * of rows; the default five seconds would abort - and roll back - a large but
 * perfectly healthy restore.
 */
export async function restoreSnapshot(
  snapshot: Snapshot,
  opts: RestoreOptions
): Promise<RestoreReport> {
  // parseBackup() validates uploaded files, but duplicate builds its snapshot
  // in-process and this function is exported - check at the door so nothing
  // malformed can ever start writing.
  assertSnapshotShape(snapshot);
  return prisma.$transaction((tx) => restoreInto(tx, snapshot, opts), {
    maxWait: 10_000,
    timeout: 120_000,
  });
}

/**
 * Decide, before a single row is written, which attachments this restore will
 * bring in and whether the result fits the workspace's storage limits.
 *
 * A restore used to write attachment rows with no check at all, while the
 * upload route enforced a per-file cap and a per-workspace quota on the very
 * same editor role. Import was therefore a way to put a 300 MB file, or ten
 * times the workspace quota, into a workspace that refuses a 51 MB upload. The
 * two limits are applied differently on purpose:
 *
 *   per-file cap   skip the row and report it. A backup written when the cap
 *                  was higher (or on another install) must still restore the
 *                  other 99% of the workspace; refusing the whole file would
 *                  make an old backup permanently unrestorable.
 *   workspace quota  refuse the restore outright. A quota is a statement about
 *                  the workspace as a whole, and quietly dropping an arbitrary
 *                  subset of someone's images to squeeze under it is worse
 *                  than telling them the workspace is full.
 */
async function planAttachments(
  tx: Prisma.TransactionClient,
  snapshot: Snapshot,
  opts: RestoreOptions,
  restorablePageIds: Set<string>
): Promise<{
  plan: { id: string; pageId: string; name: string; bytes: number }[];
  source: AttachmentBytes;
  skipped: RestoreReport["skippedAttachments"];
}> {
  const rows = snapshot.attachments ?? [];
  const skipped = { empty: 0, tooLarge: 0 };
  const source =
    opts.attachmentBytes ??
    (rows.some((a) => a.data !== undefined)
      ? inlineAttachmentBytes(snapshot)
      : liveAttachmentBytes(tx, opts.workspaceId));
  const plan: { id: string; pageId: string; name: string; bytes: number }[] = [];
  if (rows.length === 0) return { plan, source, skipped };

  const perFileCap = maxAttachmentBytes();
  const seen = new Set<string>();
  let incoming = 0;
  for (const a of rows) {
    if (seen.has(a.id)) continue; // duplicate id: first row wins
    seen.add(a.id);
    // Its page is not part of this restore (a dropped orphan record page, or a
    // pageId the file never carried a page for), so the row has nowhere to
    // hang. Counted, not merely dropped: `empty` is documented as covering
    // exactly this case, and the whole point of the skip counters is that
    // Settings can say which images did not come back. A silent `continue`
    // here reported the restore as clean while losing them.
    if (!restorablePageIds.has(a.pageId)) {
      skipped.empty++;
      continue;
    }
    const bytes = await source.size(a.id);
    // Hostile or truncated base64, or a source that doesn't have the id: the
    // upload path skips empty files too.
    if (bytes === null || bytes === 0) {
      skipped.empty++;
      continue;
    }
    if (bytes > perFileCap) {
      skipped.tooLarge++;
      continue;
    }
    incoming += bytes;
    plan.push({ id: a.id, pageId: a.pageId, name: a.name, bytes });
  }

  if (incoming > 0) {
    const quota = attachmentQuotaBytes();
    const used = await tx.attachment.aggregate({
      _sum: { size: true },
      where: { workspaceId: opts.workspaceId },
    });
    const after = (used._sum.size ?? 0) + incoming;
    if (after > quota) {
      const mb = (n: number) => Math.ceil(n / (1024 * 1024));
      throw new RestoreRefused(
        `Restoring this backup would put the workspace at ${mb(after)} MB of attachments, ` +
          `over its ${mb(quota)} MB limit. Free space or raise KEEL_ATTACHMENT_QUOTA_MB, then try again.`
      );
    }
  }

  return { plan, source, skipped };
}

async function restoreInto(
  tx: Prisma.TransactionClient,
  snapshot: Snapshot,
  opts: RestoreOptions
): Promise<RestoreReport> {
  const pageIdMap = new Map<string, string>();
  const dbIdMap = new Map<string, string>();
  const propIdMap = new Map<string, string>();
  // Every page created here, kept for the link rebuild at the end - links can
  // only be resolved once the whole restored set exists.
  const createdPages: {
    id: string;
    title: string;
    plainText: string | null;
    archived: boolean;
  }[] = [];

  const snapshotIds = new Set(snapshot.pages.map((p) => p.id));
  const dbById = new Map(snapshot.databases.map((d) => [d.id, d]));
  // Which record claims each page. Last claim wins and only that record is
  // restored for the page - DatabaseRecord.pageId is unique, so a crafted
  // snapshot in which two records point at one page must not insert both.
  const recordByPageId = new Map(snapshot.records.map((r) => [r.pageId, r]));

  // A record page whose database is not restorable (no database entry, or the
  // database's own page missing from the snapshot) is dropped along with its
  // subtree - same as before this restructure, and a record page without its
  // database is not a shape the app can render.
  const orphanRecordPage = (p: Snapshot["pages"][number]): boolean => {
    const record = recordByPageId.get(p.id);
    if (!record) return false;
    const db = dbById.get(record.databaseId);
    return !db || !snapshotIds.has(db.pageId) || db.pageId === p.id;
  };

  // Where a page hangs in the restored tree. Record pages hang under their
  // database's page - that is where the live app keeps them, whatever a
  // hand-edited parentPageId claims - and everything else under its snapshot
  // parent when that parent is in the snapshot.
  const treeParentId = (p: Snapshot["pages"][number]): string | null => {
    const record = recordByPageId.get(p.id);
    if (record) return dbById.get(record.databaseId)!.pageId;
    return p.parentPageId && snapshotIds.has(p.parentPageId) ? p.parentPageId : null;
  };

  const roots: Snapshot["pages"] = [];
  const byParent = new Map<string, Snapshot["pages"]>();
  for (const p of snapshot.pages) {
    if (orphanRecordPage(p)) continue;
    const parent = treeParentId(p);
    if (parent === null) {
      roots.push(p);
      continue;
    }
    const list = byParent.get(parent) ?? [];
    list.push(p);
    byParent.set(parent, list);
  }

  // Fresh ids for the attachments this restore will ACTUALLY create,
  // allocated before any page row is assembled: restored content embeds
  // /api/attachments/<id> URLs, and they must point at the rows this restore
  // mints - not at the source workspace's rows, which may not exist at all
  // (fresh instance, hard-deleted originals) and in a duplicate would leave
  // the copy borrowing the original's rows, to break the day the original is
  // deleted.
  //
  // "Actually create" is the load-bearing word. The map used to be built from
  // every row in the file, before the skip decisions were made, so content
  // referencing an attachment that was then dropped (unreadable base64, over
  // the per-file cap, page not restored) came out pointing at a freshly minted
  // id no row would ever carry - a guaranteed 404 where leaving the URL alone
  // would, in a same-workspace import, still have resolved to the live
  // original. remapAttachmentUrls promises that an id it doesn't know is left
  // exactly as dangling as it already was; that is only true if the map holds
  // nothing but restored rows. So the plan is computed first.
  const restorablePageIds = new Set(
    snapshot.pages.filter((p) => !orphanRecordPage(p)).map((p) => p.id)
  );
  const attachmentPlan = await planAttachments(tx, snapshot, opts, restorablePageIds);
  const attachmentIdMap = new Map<string, string>();
  for (const a of attachmentPlan.plan) attachmentIdMap.set(a.id, createId());

  // EVERY page - record pages included - is assembled in this one walk, so
  // that by the time databases and records restore, pageIdMap is complete.
  // (The old shape created record pages later, beside their records, which
  // meant a database nested under a record page was silently dropped.) Pages
  // are batched with createMany like everything else: ids are pre-generated,
  // so a child row carries its parent's fresh id directly, and rows are
  // emitted parent before child so the batched insert never writes a row
  // before its foreign-key target. Row-at-a-time creates here used to let a
  // big-but-valid import burn the whole transaction budget while holding
  // SQLite's one write slot, roll back at the timeout, and fail identically
  // on every retry.
  const pageRows: Prisma.PageCreateManyInput[] = [];
  const addPageRow = (
    p: Snapshot["pages"][number],
    parentId: string | null,
    overrides?: { title?: string; sortOrder?: number }
  ): string => {
    const created = createId();
    const title = overrides?.title ?? p.title;
    const content = remapAttachmentUrls(p.content, attachmentIdMap);
    // Restored pages must be searchable straight away; the snapshot format
    // carries the document, not the derived text.
    const plainText = documentToPlainText(content);
    const archivedAt = p.archivedAt ? new Date(p.archivedAt) : null;
    pageRows.push({
      id: created,
      workspaceId: opts.workspaceId,
      parentPageId: parentId,
      type: p.type,
      title,
      icon: p.icon,
      content,
      plainText,
      sortOrder: overrides?.sortOrder ?? p.sortOrder,
      archivedAt,
      createdById: opts.userId,
      editedById: opts.userId,
    });
    pageIdMap.set(p.id, created);
    createdPages.push({ id: created, title, plainText, archived: archivedAt !== null });
    return created;
  };

  // Explicit stack, not recursion: a crafted snapshot can chain pages
  // thousands deep, and the call stack must not decide what restores.
  const pageStack: { page: Snapshot["pages"][number]; parentId: string }[] = [];
  const pushChildren = (oldId: string, parentId: string) => {
    const children = byParent.get(oldId) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      pageStack.push({ page: children[i], parentId });
    }
  };
  const drainPages = () => {
    while (pageStack.length) {
      const { page, parentId } = pageStack.pop()!;
      if (pageIdMap.has(page.id)) continue; // already created: duplicate id, or a ring closed
      pushChildren(page.id, addPageRow(page, parentId));
    }
  };

  const rootPageIds: string[] = [];
  let first = true;
  for (const root of roots) {
    const created = addPageRow(root, opts.parentPageId ?? null, {
      title: first && opts.rootTitle !== undefined ? opts.rootTitle : undefined,
      sortOrder:
        first && opts.sortOrderBase !== undefined ? opts.sortOrderBase : undefined,
    });
    first = false;
    rootPageIds.push(created);
    pushChildren(root.id, created);
    drainPages();
  }

  // Sweep for pages the walk could not reach: parentPageId edges that close a
  // ring make every member somebody's child (none is a root, none descends
  // from one), and children of a dropped orphan record page hang under an id
  // that was never created. The record tree already degrades a bad edge to a
  // root rather than dropping the subtree; pages get the same treatment - the
  // unreachable page is created at the restore root and its descendants walk
  // in under it as usual. Silently losing whole subtrees is the one thing a
  // restore must never do.
  for (const p of snapshot.pages) {
    if (pageIdMap.has(p.id) || orphanRecordPage(p)) continue;
    const created = addPageRow(p, opts.parentPageId ?? null);
    rootPageIds.push(created);
    pushChildren(p.id, created);
    drainPages();
  }

  // 12 columns per page row: chunks of 80 stay inside the parameter cap.
  await createInChunks(pageRows, (rows) => tx.page.createMany({ data: rows }), 80);

  // Attachment rows, once their pages exist. mime is re-sniffed from the bytes
  // exactly as the upload path does - a hand-edited file must not claim an
  // inline-renderable type its bytes don't have - and size and sha256 are
  // likewise derived, not trusted.
  //
  // Bytes are pulled in one attachment at a time and the pending batch is
  // flushed as soon as it reaches a few megabytes. Accumulating every row
  // first, as this loop used to, meant the whole workspace's attachment bytes
  // sat in one array before the first insert: the same "resident memory scales
  // with total attachment bytes" failure as the old serializer, just on the
  // way in instead of the way out.
  const FLUSH_BYTES = 8 * 1024 * 1024;
  let pending: Prisma.AttachmentCreateManyInput[] = [];
  let pendingBytes = 0;
  const flushAttachments = async () => {
    if (pending.length === 0) return;
    await tx.attachment.createMany({ data: pending });
    pending = [];
    pendingBytes = 0;
  };
  for (const planned of attachmentPlan.plan) {
    const newPageId = pageIdMap.get(planned.pageId);
    if (!newPageId) continue; // defensive: the plan already filtered these out
    const data = await attachmentPlan.source.read(planned.id);
    if (data.length === 0) continue; // the row vanished between plan and write
    pending.push({
      id: attachmentIdMap.get(planned.id)!,
      workspaceId: opts.workspaceId,
      pageId: newPageId,
      name: safeFilename(planned.name),
      mime: sniffInlineMime(data) ?? "application/octet-stream",
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      data,
      createdById: opts.userId,
    });
    pendingBytes += data.length;
    if (pending.length >= 25 || pendingBytes >= FLUSH_BYTES) await flushAttachments();
  }
  await flushAttachments();

  // Databases + properties. Every reachable page is in pageIdMap by now -
  // nested under a record page or not - so no database can fall through this
  // loop for ordering reasons; a miss means the snapshot genuinely lacks the
  // page. A duplicate database id, or a second database claiming an already
  // claimed page, is skipped up front rather than left to explode on the
  // unique constraint mid-transaction.
  const dbRows: Prisma.DatabaseCreateManyInput[] = [];
  const claimedDbPages = new Set<string>();
  for (const db of snapshot.databases) {
    const newPageId = pageIdMap.get(db.pageId);
    if (!newPageId || dbIdMap.has(db.id) || claimedDbPages.has(newPageId)) continue;
    const created = createId();
    dbIdMap.set(db.id, created);
    claimedDbPages.add(newPageId);
    dbRows.push({ id: created, workspaceId: opts.workspaceId, pageId: newPageId });
  }
  await createInChunks(dbRows, (rows) => tx.database.createMany({ data: rows }));

  // createMany is a single statement per chunk instead of a round trip per row.
  // It cannot return generated ids, so ids are allocated here and reused for the
  // mapping - which is also what lets the values below be batched at all.
  const propertyRows = snapshot.properties.flatMap((prop) => {
    const newDbId = dbIdMap.get(prop.databaseId);
    if (!newDbId) return [];
    const id = createId();
    propIdMap.set(prop.id, id);
    return [{
      id,
      databaseId: newDbId,
      name: prop.name,
      type: prop.type,
      settings: prop.settings,
      sortOrder: prop.sortOrder,
    }];
  });
  await createInChunks(propertyRows, (rows) => tx.databaseProperty.createMany({ data: rows }));

  // Records. Their pages already exist (created in the walk above); these
  // rows only add the DatabaseRecord behind each one. Ids are pre-generated
  // and the parent edges validated before any row is written, so each row can
  // carry its parentRecordId directly in the batched insert - the per-edge
  // update pass this replaces was the other half of the row-at-a-time
  // transaction cost.
  const recordIdMap = new Map<string, string>();
  const creatable: Snapshot["records"] = [];
  for (const record of snapshot.records) {
    if (recordByPageId.get(record.pageId) !== record) continue; // page claimed twice
    if (recordIdMap.has(record.id)) continue; // duplicate record id: first wins
    if (!dbIdMap.has(record.databaseId) || !pageIdMap.has(record.pageId)) continue;
    recordIdMap.set(record.id, createId());
    creatable.push(record);
  }

  // Parent edges: snapshot.records is in sortOrder, not topological order, so
  // a parent can appear after its child. The API path runs assertCanReparent
  // on every reparent; a restore must hold the same two invariants - no
  // cross-database parents, no cycles - against whatever the file claims, or
  // a hand-edited backup reintroduces exactly the rings every tree walk in
  // the app guards against. An edge that fails a check degrades that record
  // to a root (the same fate as a parent id outside the restored set) rather
  // than failing the whole restore.
  //
  // Built from `creatable`, NOT from snapshot.records. Duplicate ids resolve
  // first-wins into recordIdMap above, but `new Map(snapshot.records.map(...))`
  // keeps the LAST row per id - so a file carrying two records with id "P", one
  // in each database, validated the child's edge against the copy that was
  // skipped while the emitted row pointed at the copy that was created. That
  // persisted exactly the cross-database parent this block exists to refuse.
  // Validating against the rows that will actually exist closes it by
  // construction: every lookup here answers with the row recordIdMap minted.
  const recordsById = new Map(creatable.map((r) => [r.id, r]));
  const acceptedParent = new Map<string, string>();
  for (const record of creatable) {
    if (!record.parentRecordId) continue;
    if (!recordIdMap.has(record.parentRecordId)) continue; // parent outside the restored set
    const parent = recordsById.get(record.parentRecordId);
    if (!parent || parent.databaseId !== record.databaseId) continue; // cross-database
    // Walk up the edges accepted so far; reaching this record again means the
    // new edge would close a ring. Edges are considered in file order, so of a
    // crafted A→B→…→A ring everything but the closing edge survives.
    let cyclic = false;
    let cursor: string | undefined = record.parentRecordId;
    for (let steps = 0; cursor !== undefined && steps <= snapshot.records.length; steps++) {
      if (cursor === record.id) {
        cyclic = true;
        break;
      }
      cursor = acceptedParent.get(cursor);
    }
    if (cyclic) continue;
    acceptedParent.set(record.id, record.parentRecordId);
  }

  // The accepted edges form a forest, so rows can be emitted parents-first -
  // which is what lets parentRecordId ride along inside createMany without
  // tripping the foreign key.
  const childRecords = new Map<string, Snapshot["records"]>();
  const rootRecords: Snapshot["records"] = [];
  for (const record of creatable) {
    const parentId = acceptedParent.get(record.id);
    if (parentId === undefined) {
      rootRecords.push(record);
      continue;
    }
    const list = childRecords.get(parentId) ?? [];
    list.push(record);
    childRecords.set(parentId, list);
  }
  const recordRows: Prisma.DatabaseRecordCreateManyInput[] = [];
  const recordStack = [...rootRecords].reverse();
  while (recordStack.length) {
    const record = recordStack.pop()!;
    const parentId = acceptedParent.get(record.id);
    recordRows.push({
      id: recordIdMap.get(record.id)!,
      databaseId: dbIdMap.get(record.databaseId)!,
      pageId: pageIdMap.get(record.pageId)!,
      sortOrder: record.sortOrder,
      parentRecordId: parentId !== undefined ? recordIdMap.get(parentId)! : null,
      // ?? defaults: version-1 snapshots carry none of the layout fields.
      mapX: record.mapX ?? null,
      mapY: record.mapY ?? null,
      collapsed: record.collapsed ?? false,
    });
    const children = childRecords.get(record.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) recordStack.push(children[i]);
  }
  await createInChunks(recordRows, (rows) => tx.databaseRecord.createMany({ data: rows }));

  // Values are the bulk of a snapshot - a 10k-record database with 10
  // properties is 100k rows, which as individual creates is 100k round trips.
  // Three columns per row, so chunks of 300 stay inside the parameter cap.
  const valueRows = snapshot.values.flatMap((value) => {
    const recordId = recordIdMap.get(value.recordId);
    const propertyId = propIdMap.get(value.propertyId);
    if (!recordId || !propertyId) return [];
    return [{ recordId, propertyId, value: value.value }];
  });
  await createInChunks(valueRows, (rows) => tx.databaseValue.createMany({ data: rows }), 300);

  // Saved views. Created after the records because a mind-map config can pin a
  // root record, and remapping that id needs recordIdMap filled in.
  const viewRows = (snapshot.views ?? []).flatMap((view) => {
    const newDbId = dbIdMap.get(view.databaseId);
    if (!newDbId) return [];
    return [{
      databaseId: newDbId,
      name: view.name,
      type: isViewType(view.type) ? view.type : "table",
      sortOrder: view.sortOrder,
      config: remapViewConfig(view.config, propIdMap, recordIdMap),
    }];
  });
  await createInChunks(viewRows, (rows) => tx.databaseView.createMany({ data: rows }));

  // PageLink/PageTag rows are derived from the document and rebuilt only on
  // editor saves - a path no restored page passes through - so they are
  // rebuilt here, once every page exists. Resolution order matters: a restore
  // into a populated workspace (an import beside existing notes, a duplicate
  // of a subtree) can add pages whose titles already exist, and a
  // whole-workspace lookup would bind a restored [[link]] to whichever
  // same-titled row the database happened to return first. Restored pages
  // resolve against the restored set first; only titles the snapshot doesn't
  // carry fall back to the rest of the workspace.
  const restoredByTitle = new Map<string, string>();
  for (const page of createdPages) {
    if (page.archived) continue; // trashed pages don't answer to their title
    const key = normalizeTitle(page.title);
    if (key && !restoredByTitle.has(key)) restoredByTitle.set(key, page.id);
  }

  // A dangling [[link]] written before this restore may point at a title that
  // only now exists. Create and rename run resolveLinksTo for this; a restore
  // is the same event - a page with that title appearing - so pre-existing
  // unresolved links attach to the restored page too. This runs before the
  // restored pages' own rows are inserted, so it can only touch links that
  // already existed.
  const preexisting = await tx.pageLink.findMany({
    where: { workspaceId: opts.workspaceId, toPageId: null },
    select: { id: true, targetTitle: true },
  });
  const resolvable = new Map<string, string[]>();
  for (const link of preexisting) {
    const target = restoredByTitle.get(normalizeTitle(link.targetTitle));
    if (!target) continue;
    const list = resolvable.get(target) ?? [];
    list.push(link.id);
    resolvable.set(target, list);
  }
  for (const [toPageId, linkIds] of resolvable) {
    await createInChunks(linkIds, (ids) =>
      tx.pageLink.updateMany({ where: { id: { in: ids } }, data: { toPageId } })
    );
  }

  const extracted = createdPages
    .map((page) => ({ page, links: extractLinks(page.plainText ?? "") }))
    .filter(({ links }) => links.targets.length > 0 || links.tags.length > 0);

  // Workspace-wide fallback, mirroring resolveTargets in links.ts: an exact
  // `in` pass catches links written verbatim, then a bounded `contains` pass
  // covers case differences (SQLite's `=` is case-sensitive and Prisma's
  // insensitive mode is PostgreSQL-only). Over-matches are harmless - lookups
  // below use exact normalized keys only.
  const fallbackByTitle = new Map<string, string>();
  const outside: string[] = [];
  const seenOutside = new Set<string>();
  for (const { links } of extracted) {
    for (const target of links.targets) {
      const key = normalizeTitle(target);
      if (restoredByTitle.has(key) || seenOutside.has(key)) continue;
      seenOutside.add(key);
      outside.push(target);
    }
  }
  if (outside.length > 0) {
    const remember = (found: { id: string; title: string }[]) => {
      for (const row of found) {
        const key = normalizeTitle(row.title);
        if (key && !fallbackByTitle.has(key)) fallbackByTitle.set(key, row.id);
      }
    };
    await createInChunks(outside, async (chunk) =>
      remember(
        await tx.page.findMany({
          where: { workspaceId: opts.workspaceId, archivedAt: null, title: { in: chunk } },
          select: { id: true, title: true },
          take: 500,
        })
      )
    );
    const leftovers = outside.filter((t) => !fallbackByTitle.has(normalizeTitle(t)));
    if (leftovers.length > 0) {
      remember(
        await tx.page.findMany({
          where: {
            workspaceId: opts.workspaceId,
            archivedAt: null,
            OR: leftovers.slice(0, 25).map((t) => ({ title: { contains: t } })),
          },
          select: { id: true, title: true },
          take: 500,
        })
      );
    }
  }

  const linkRows: {
    workspaceId: string;
    fromPageId: string;
    toPageId: string | null;
    targetTitle: string;
  }[] = [];
  const tagRows: { workspaceId: string; pageId: string; tag: string; label: string }[] = [];
  for (const { page, links } of extracted) {
    for (const target of links.targets) {
      const key = normalizeTitle(target);
      const resolved = restoredByTitle.get(key) ?? fallbackByTitle.get(key) ?? null;
      linkRows.push({
        workspaceId: opts.workspaceId,
        fromPageId: page.id,
        // A page linking to itself is noise in its own backlinks pane.
        toPageId: resolved === page.id ? null : resolved,
        targetTitle: target,
      });
    }
    for (const tag of links.tags) {
      tagRows.push({ workspaceId: opts.workspaceId, pageId: page.id, tag: tag.tag, label: tag.label });
    }
  }
  await createInChunks(linkRows, (batch) => tx.pageLink.createMany({ data: batch }));
  await createInChunks(tagRows, (batch) => tx.pageTag.createMany({ data: batch }));

  return { rootPageIds, skippedAttachments: attachmentPlan.skipped };
}

/**
 * A view's config embeds property and record ids, and a restore mints fresh
 * ones - copied verbatim it would point at rows that don't exist. Ids are
 * rewritten through the restore's maps; one that resolves to nothing becomes
 * null, which every reader treats as "unset". Option-keyed fields (wipLimits,
 * columnOrder, collapsedColumns) need no rewrite: option ids live inside the
 * property's settings blob and are copied with it. The config arrives from an
 * uploaded file, so it goes through sanitizeConfig like any client-written blob.
 */
function remapViewConfig(
  raw: string | null,
  propIds: Map<string, string>,
  recordIds: Map<string, string>
): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // A config string that parses to a primitive (`"5"`) would throw inside
  // sanitizeConfig's `in` checks - parseViewConfig has this same object
  // guard, and a restore must treat garbage the same way: as "unset".
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const config = sanitizeConfig(parsed);
  const prop = (v: string | null | undefined) => (v ? propIds.get(v) ?? null : null);
  if (config.groupByPropertyId !== undefined) config.groupByPropertyId = prop(config.groupByPropertyId);
  if (config.swimlanePropertyId !== undefined) config.swimlanePropertyId = prop(config.swimlanePropertyId);
  if (config.sortPropertyId !== undefined) config.sortPropertyId = prop(config.sortPropertyId);
  if (config.hiddenPropertyIds) {
    config.hiddenPropertyIds = config.hiddenPropertyIds.flatMap((id) => propIds.get(id) ?? []);
  }
  if (config.cardPropertyIds) {
    config.cardPropertyIds = config.cardPropertyIds.flatMap((id) => propIds.get(id) ?? []);
  }
  if (config.timeline) {
    config.timeline = {
      datePropertyId: prop(config.timeline.datePropertyId),
      endDatePropertyId: prop(config.timeline.endDatePropertyId),
    };
  }
  if (config.mindmap) {
    config.mindmap = {
      ...config.mindmap,
      rootRecordId: config.mindmap.rootRecordId
        ? recordIds.get(config.mindmap.rootRecordId) ?? null
        : null,
    };
  }
  return serializeViewConfig(config);
}

/**
 * Rewrite /api/attachments/<id> URLs in restored page content to the rows
 * this restore minted. The content is a serialized document, but the URLs
 * appear in it as plain substrings, so a targeted replace is simpler and more
 * robust than re-parsing every document. An id the map doesn't know is left
 * alone - it stays exactly as dangling as it already was, which for a
 * same-workspace import means it keeps resolving to the live original row. The
 * map therefore contains only attachments this restore actually creates (see
 * attachmentIdMap); anything skipped must NOT appear in it, or "left alone"
 * silently becomes "repointed at an id that will never exist".
 * The id token is maximal ([A-Za-z0-9_-]+), so a mapped id that happens to
 * prefix a longer token never rewrites half of it.
 */
const ATTACHMENT_URL = /\/api\/attachments\/([A-Za-z0-9_-]+)/g;
function remapAttachmentUrls(content: string | null, ids: Map<string, string>): string | null {
  if (!content || ids.size === 0 || !content.includes("/api/attachments/")) return content;
  return content.replace(ATTACHMENT_URL, (whole, oldId: string) => {
    const mapped = ids.get(oldId);
    return mapped ? `/api/attachments/${mapped}` : whole;
  });
}

/** cuid-shaped id, so rows can be batched and still be referenced afterwards. */
function createId(): string {
  return "c" + crypto.randomBytes(12).toString("hex");
}

/**
 * Insert in chunks.
 *
 * SQLite caps a statement at 999 bound parameters by default, and an unbounded
 * createMany on a large restore exceeds it. Chunking keeps each statement well
 * inside that on both engines.
 */
async function createInChunks<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  size = 100
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

/* ---------- Encryption (AES-256-GCM, scrypt KDF) ---------- */

// scrypt is deliberately CPU-heavy (that is the point of a KDF). The async
// form yields the event loop while the C++ work runs on the libuv threadpool,
// so a scheduled backup's key derivation doesn't stall concurrent requests the
// way scryptSync would. AES and JSON are comparatively cheap and stay sync.
import { promisify } from "node:util";
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };

/**
 * A problem with the encrypted ENVELOPE - its header, its parameters, its tag
 * - as opposed to a problem with the plaintext inside it.
 *
 * The distinction is only there so the reader can tell the operator something
 * useful. A wrong passphrase produces plausible garbage that fails somewhere
 * in the snapshot scan, and every such failure is reported as "Wrong
 * passphrase (or corrupted backup)" because that is what it almost always is.
 * A malformed header or a hostile KDF block is not that, and saying so beats
 * telling someone their passphrase is wrong when it isn't.
 */
class EnvelopeError extends Error {
  constructor(what: string) {
    super(`Not a valid Keel backup file (${what}).`);
    this.name = "EnvelopeError";
  }
}
function badEnvelope(what: string): never {
  throw new EnvelopeError(what);
}

/**
 * Bounds on the scrypt cost parameters an envelope may ask for.
 *
 * N, r and p arrive from the file. scrypt's work is O(N*r*p) and Node's only
 * built-in guard is a 32 MB maxmem check, which constrains 128*N*r + 128*p*r -
 * not the product. So `{N:16384, r:1, p:131072}` sails through the memory
 * check and costs minutes of CPU on a libuv threadpool thread, for a 200-byte
 * upload; four of those stall every fs, dns and crypto operation in the
 * process. Keel writes exactly one parameter set (SCRYPT), so the only reason
 * to accept anything else is to keep reading files written by some other build
 * - which is worth a window, not an unbounded one.
 *
 * The window: each parameter individually sane, and the product no more than
 * 8x what Keel itself writes (~1s of derivation on ordinary hardware). maxmem
 * is passed explicitly and derived from the accepted N and r, so it never
 * depends on Node's default.
 */
const SCRYPT_MAX_WORK = 8 * SCRYPT.N * SCRYPT.r * SCRYPT.p;
function scryptOptionsFrom(kdf: EncryptedEnvelope["kdf"] | undefined): crypto.ScryptOptions {
  const ok = (v: unknown, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
  if (!kdf || typeof kdf.salt !== "string") badEnvelope("the encrypted header is malformed");
  const { N, r, p } = kdf;
  // N must also be a power of two - scrypt rejects anything else, and saying
  // so here beats an opaque throw from OpenSSL.
  if (!ok(N, 1 << 20) || N < 2 || (N & (N - 1)) !== 0 || !ok(r, 64) || !ok(p, 64)) {
    badEnvelope("the encrypted header asks for scrypt parameters outside the accepted range");
  }
  if (N * r * p > SCRYPT_MAX_WORK) {
    badEnvelope("the encrypted header asks for more key-derivation work than this build will do");
  }
  return { N, r, p, maxmem: 256 * N * r + 128 * p * r + 1024 * 1024 };
}

/**
 * The envelope's KDF salt, validated before anything converts it.
 *
 * Both call sites used to write `Buffer.from(env.kdf.salt, "base64")` inline in
 * the scryptAsync argument list, ahead of `scryptOptionsFrom(env.kdf)`.
 * Arguments evaluate left to right, so the only salt check in the module - the
 * `typeof kdf.salt !== "string"` guard inside scryptOptionsFrom - ran after the
 * conversion that a non-string salt makes throw. The result was the mislabel
 * EnvelopeError exists to prevent: a raw Node TypeError on the buffered path,
 * and "Wrong passphrase (or corrupted backup)" on the streaming one (where
 * readBackupStream rewrites anything that is not an EnvelopeError), telling an
 * operator their passphrase was wrong when the header was mangled.
 */
function scryptSaltFrom(kdf: EncryptedEnvelope["kdf"] | undefined): Buffer {
  if (!kdf || typeof kdf.salt !== "string") badEnvelope("the encrypted header is malformed");
  return Buffer.from(kdf.salt, "base64");
}

/** V8 refuses to build a string longer than this. Everything that could reach
 *  it streams; the few places that legitimately buffer say so and check. */
const MAX_STRING = 536_870_888;

/* ---------- Writing a snapshot as a stream ---------- */

/** One array section, element by element, so no section is ever one string. */
function* jsonArraySection(name: string, items: unknown[]): Generator<string> {
  yield `"${name}":[`;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) yield ",";
    yield JSON.stringify(items[i]);
  }
  yield "]";
}

/**
 * The snapshot as v3 JSON, in pieces.
 *
 * Byte-identical in shape to what `JSON.stringify(snapshot)` produced - same
 * keys, same order, same values - but never assembled into one string, and the
 * attachment bytes are fetched, encoded and released one row at a time.
 *
 * `size` is written from the bytes actually found, not from the metadata row,
 * so the file never claims a length it doesn't carry. A row whose bytes have
 * gone (hard-deleted between the metadata query and here) is left out
 * entirely: an empty attachment is a row a restore would skip anyway, and
 * omitting it keeps the URL in the restored content pointing at whatever it
 * pointed at before.
 */
export async function* snapshotChunksOf(
  snapshot: Snapshot,
  bytes: AttachmentBytes
): AsyncGenerator<string> {
  yield "{";
  yield `"format":${JSON.stringify(snapshot.format)},`;
  yield `"version":${JSON.stringify(snapshot.version)},`;
  yield `"exportedAt":${JSON.stringify(snapshot.exportedAt)},`;
  yield `"workspace":${JSON.stringify(snapshot.workspace)},`;
  yield* jsonArraySection("pages", snapshot.pages);
  yield ",";
  yield* jsonArraySection("databases", snapshot.databases);
  yield ",";
  yield* jsonArraySection("properties", snapshot.properties);
  yield ",";
  yield* jsonArraySection("records", snapshot.records);
  yield ",";
  yield* jsonArraySection("values", snapshot.values);
  if (snapshot.views) {
    yield ",";
    yield* jsonArraySection("views", snapshot.views);
  }
  if (snapshot.attachments) {
    yield ',"attachments":[';
    let first = true;
    for (const a of snapshot.attachments) {
      const buf = a.data !== undefined ? Buffer.from(a.data, "base64") : await bytes.read(a.id);
      if (buf.length === 0) continue;
      if (!first) yield ",";
      first = false;
      yield (
        `{"id":${JSON.stringify(a.id)},"pageId":${JSON.stringify(a.pageId)},` +
        `"name":${JSON.stringify(a.name)},"mime":${JSON.stringify(a.mime)},` +
        `"size":${buf.length},"data":"`
      );
      // 3-byte-aligned slices: base64 of a 3-byte multiple has no padding, so
      // the concatenation of the slices' base64 IS the base64 of the whole
      // buffer. Without the alignment each slice would end in "=" and the file
      // would decode to garbage.
      const SLICE = 3 * 1024 * 1024;
      for (let i = 0; i < buf.length; i += SLICE) {
        yield buf.subarray(i, Math.min(i + SLICE, buf.length)).toString("base64");
      }
      yield '"}';
    }
    yield "]";
  }
  yield "}";
}

/**
 * The byte source that pairs with a snapshotWorkspace() result: the live rows
 * its attachment ids name. Exported for the export route, which needs the
 * snapshot object (for the audit detail) and the stream separately.
 */
export function liveExportBytes(): AttachmentBytes {
  return liveAttachmentBytes(prisma);
}

/** Snapshot a workspace (or subtree) straight to a stream of JSON chunks. */
export async function* snapshotChunks(
  workspaceId: string,
  rootPageId?: string
): AsyncGenerator<string> {
  const snapshot = await snapshotWorkspace(workspaceId, rootPageId);
  yield* snapshotChunksOf(snapshot, liveAttachmentBytes(prisma));
}

/**
 * Encrypt a stream of JSON chunks into a v2 envelope, incrementally.
 *
 * The envelope is still ordinary JSON - the same fields a v1 envelope has -
 * with one deliberate difference: `tag` is written AFTER `data`, because a
 * streaming writer only learns the GCM authentication tag once the last byte
 * has gone through the cipher. JSON objects are unordered, so JSON.parse reads
 * a v2 envelope exactly as it reads a v1 one, and the reader below accepts the
 * tag from either position.
 *
 * The honest cost of keeping the envelope as JSON: the ciphertext is base64,
 * so an encrypted backup is 16/9 of the workspace's attachment bytes (4/3 for
 * the snapshot's own base64, 4/3 again here). That is what
 * maxBackupUploadBytes() is derived from. A binary container would avoid the
 * second inflation at the cost of a file type nothing else can read; a backup
 * you can still open with a JSON parser ten years from now is worth more than
 * the bytes.
 */
export async function* encryptedChunks(
  plain: AsyncIterable<string>,
  passphrase: string
): AsyncGenerator<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(passphrase, salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const header: Omit<EncryptedEnvelope, "tag" | "data"> = {
    format: "keel-backup-encrypted",
    version: 2,
    kdf: { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT },
    iv: iv.toString("base64"),
  };
  const head = JSON.stringify(header);
  yield `${head.slice(0, -1)},"data":"`;

  // Same 3-byte alignment rule as above, applied to the ciphertext: carry the
  // 0-2 bytes that don't complete a base64 group over to the next chunk.
  let carry = Buffer.alloc(0);
  const emit = (buf: Buffer, final: boolean): string => {
    const all = carry.length ? Buffer.concat([carry, buf]) : buf;
    if (final) {
      carry = Buffer.alloc(0);
      return all.toString("base64");
    }
    const n = all.length - (all.length % 3);
    carry = Buffer.from(all.subarray(n));
    return n > 0 ? all.subarray(0, n).toString("base64") : "";
  };

  for await (const chunk of plain) {
    const out = emit(cipher.update(Buffer.from(chunk, "utf8")), false);
    if (out) yield out;
  }
  const tail = emit(cipher.final(), true);
  if (tail) yield tail;
  yield `","tag":${JSON.stringify(cipher.getAuthTag().toString("base64"))}}`;
}

/** Collect a chunk stream into one string, refusing to hit V8's ceiling. */
async function collect(chunks: AsyncIterable<string>, what: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > MAX_STRING) {
      throw new Error(
        `${what} is too large to hold in memory (over ${Math.floor(MAX_STRING / 1024 / 1024)} MB). ` +
          `Use the streaming path (runBackup writes straight to disk).`
      );
    }
    parts.push(chunk);
  }
  return parts.join("");
}

/**
 * Encrypt a snapshot into a single envelope string.
 *
 * A convenience for callers that genuinely want the whole thing in memory
 * (tests, and any small in-process snapshot). It buffers, so it carries the
 * string ceiling with it - and now says so with a real message instead of a
 * RangeError. Backups and exports use encryptedChunks() directly and have no
 * ceiling at all.
 */
export async function encryptBackup(snapshot: Snapshot, passphrase: string): Promise<string> {
  return collect(
    encryptedChunks(snapshotChunksOf(snapshot, liveAttachmentBytes(prisma)), passphrase),
    "This encrypted backup"
  );
}

/**
 * THE TRUST BOUNDARY FOR ENCRYPTION.
 *
 * A file does not get to decide how it is authenticated. It used to: both
 * readers derived "is this encrypted?" from the file's own `format` header and
 * only checked one direction of the answer, so an ENCRYPTED file with no
 * passphrase was refused while a PLAINTEXT file WITH a passphrase was accepted
 * and the passphrase silently dropped. Stripping the envelope was therefore a
 * complete bypass of the AES-GCM tag: everything below decryptStream - the
 * bounded KDF, setAuthTag, final(), the `authenticated` flag readBackupStream
 * asserts - is simply not on the code path a plaintext header selects.
 *
 * That mattered because backups are encrypted precisely when their store is
 * untrusted: a OneDrive/Dropbox-synced backup folder (backupDirFor supports
 * one deliberately) or a connected cloud backup account. Anyone who can write
 * there could replace a .keelbak's bytes with a
 * plaintext snapshot of their own authorship, leave the name alone, and watch
 * the UI show the padlock, prompt for the passphrase, and report a clean
 * restore of attacker-authored pages. To be accurate about the damage: a
 * restore is additive and remaps every id, so nothing existing is overwritten
 * and nothing about the account is escalated - this is content INJECTION into
 * the workspace, and a lie about what was authenticated, not data loss.
 *
 * So the direction of trust is inverted. The CALLER states what the file must
 * be, before a byte of it is read, and the file must match:
 *
 *   passphrase supplied     -> the file MUST be an encrypted envelope, and it
 *                              must authenticate under that passphrase.
 *   file is an envelope     -> a passphrase is required (the older half of the
 *                              rule, kept).
 *   name says encrypted     -> the file MUST be an encrypted envelope, even if
 *                              the caller never asked for a passphrase. This is
 *                              what closes isEncryptedBackupName: the UI's
 *                              padlock and passphrase prompt are filename tests,
 *                              and until now nothing re-derived them from the
 *                              content. backupFileStream registers the
 *                              expectation its filename implies (below), so the
 *                              server checks the claim the UI made.
 *
 * `expectEncrypted` lets a caller that knows the name but not the bytes say so
 * outright (the import route has the upload's filename). Every source of the
 * expectation is OR-ed: an assertion of encryption can only be added, never
 * argued away, so neither a stale argument nor the file itself can relax it.
 */
function refuseUnencrypted(): never {
  throw new Error(
    "This backup is not encrypted, but it was opened as an encrypted backup. Nothing in it " +
      "could be authenticated, so nothing was restored - if the file came from a synced or " +
      "shared folder, treat it as replaced."
  );
}

/**
 * Name-derived expectations for the streams this module hands out.
 *
 * A WeakMap rather than a field on the stream: the value must come from the
 * code that opened the file, never from anything the file could set. Only
 * backupFileStream() writes here, and readBackupStream() only ever reads it as
 * an additional reason to demand encryption.
 */
const sourceExpectsEncrypted = new WeakMap<object, boolean>();

/**
 * Parse a backup file already held as one string.
 *
 * Kept for callers that legitimately have the whole file in memory, including
 * compatibility tests. It inherits the string ceiling from its own argument.
 * Import, on-disk restore, and cloud restore use readBackupStream() instead.
 *
 * `expectEncrypted` is the caller's assertion, as described above; supplying a
 * passphrase is the same assertion by another name.
 */
export async function parseBackup(
  raw: string,
  passphrase?: string,
  expectEncrypted?: boolean
): Promise<Snapshot> {
  const mustBeEncrypted = expectEncrypted === true || passphrase !== undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Not a valid Keel backup file.");
  }
  // Both names are accepted forever. The app was called Keel, and a rename
  // that makes your existing backups unreadable is not a rename, it is data
  // loss. New backups are written as "keel-backup".
  const obj = parsed as { format?: string };
  if (obj.format === "keel-backup" || obj.format === "nopin-backup") {
    // The downgrade check, before the shape check: a file claiming to be
    // plaintext when the caller opened it as encrypted is refused whatever its
    // contents turn out to be.
    if (mustBeEncrypted) refuseUnencrypted();
    // Shape-check before returning so a truncated or hand-edited file is
    // refused here, with a clear message, rather than surprising the restore.
    assertSnapshotShape(parsed);
    applyFileLimits(parsed);
    return parsed;
  }
  if (obj.format === "keel-backup-encrypted" || obj.format === "nopin-backup-encrypted") {
    if (!passphrase) throw new Error("This backup is encrypted - a passphrase is required.");
    const env = parsed as EncryptedEnvelope;
    // Same bounds as the streaming path: the cost parameters come from the
    // file on both, so a check on only one of them is not a check. The salt is
    // validated by scryptSaltFrom rather than fed straight to Buffer.from,
    // which threw a raw TypeError for a non-string salt - an envelope problem
    // reported as a Node internal.
    const key = await scryptAsync(
      passphrase,
      scryptSaltFrom(env.kdf),
      32,
      scryptOptionsFrom(env.kdf)
    );
    if (typeof env.iv !== "string" || typeof env.data !== "string") {
      badEnvelope("the encrypted header is malformed");
    }
    if (typeof env.tag !== "string") {
      badEnvelope("the encrypted backup carries no authentication tag");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(env.iv, "base64")
    );
    // setAuthTag + final() before a single byte of the plaintext is used: on
    // this path the whole ciphertext is in hand, so authentication is simply
    // complete before parsing starts.
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    let json: string;
    try {
      json = Buffer.concat([
        decipher.update(Buffer.from(env.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Wrong passphrase (or corrupted backup).");
    }
    let decrypted: unknown;
    try {
      decrypted = JSON.parse(json);
    } catch {
      throw new Error("Wrong passphrase (or corrupted backup).");
    }
    assertSnapshotShape(decrypted);
    applyFileLimits(decrypted);
    return decrypted;
  }
  throw new Error("Not a valid Keel backup file.");
}

/* ---------- Reading a backup file as a stream ---------- */

const ARRAY_SECTIONS = new Set(Object.keys(SECTION_CAPS));

function badFile(what: string): never {
  throw new Error(`Not a valid Keel backup file (${what}).`);
}

/**
 * Where a streaming read puts attachment bytes as it finds them.
 *
 * open()/write()/close() bracket one row's `data` value. close() gets the rest
 * of the row afterwards, because a hand-written file may put `data` before the
 * id it belongs to.
 */
interface AttachmentSpool {
  open(): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  close(row: Record<string, unknown>, bytes: number, opened: boolean): Promise<void>;
}

/**
 * Scan JSON as it arrives, one top-level key and one array element at a time.
 *
 * This is the read-side counterpart to snapshotChunksOf. JSON.parse needs the
 * whole document as a string, which for an attachment-carrying backup is the
 * ~400 MB ceiling all over again - so the document is walked structurally
 * instead: find the extent of the next value by tracking brace depth and
 * string state, hand that one substring to JSON.parse, drop it, continue.
 *
 * Attachment rows get one extra step. Their `data` value is the only thing in
 * a backup that is individually enormous, so it is never held: the base64 is
 * decoded in 4-character groups as it streams past and written straight to the
 * spool. That is what keeps the working set at chunk size rather than at the
 * largest attachment - and it is why the reader is not simply "JSON.parse each
 * element". (Decoding in groups also means a `data` value containing junk
 * outside the base64 alphabet decodes slightly differently from one whole
 * Buffer.from - both produce garbage from garbage, and the restore's
 * "an empty decode is skipped" rule catches the case that matters.)
 *
 * Deliberately not a general-purpose JSON parser. It validates structure only
 * as far as it needs to find boundaries; every value it hands back goes
 * through JSON.parse, which is the real parser, and the result then goes
 * through assertSnapshotShape exactly like a JSON.parse'd file would.
 *
 * Two properties this scanner owes its caller, both learned the hard way:
 *
 *   it reads to the END of the input, always. Returning at the document's
 *   closing brace left the source generator suspended mid-yield - which on the
 *   encrypted path meant decryptStream's setAuthTag/final(), the only place the
 *   GCM tag is ever checked, simply never ran whenever the last fill happened
 *   to land on that brace. A forged tag was accepted; a targeted ciphertext
 *   bit-flip changed a restored page's title. Draining to end-of-input is what
 *   forces that check to happen, and it is why nothing may follow the snapshot
 *   but whitespace.
 *
 *   it enforces SECTION_CAPS as rows arrive. The caps used to run in
 *   assertSnapshotShape, on the finished object - so the file they existed to
 *   refuse was already in the heap by the time they got to refuse it.
 */
async function scanSnapshot(
  chunks: AsyncIterable<Uint8Array | string>,
  spool: AttachmentSpool | null
): Promise<Snapshot> {
  const { StringDecoder } = await import("node:string_decoder");
  const decoder = new StringDecoder("utf8");
  const it = chunks[Symbol.asyncIterator]();
  let buf = "";
  let pos = 0;
  let ended = false;

  // Pull several source chunks per top-up. `buf += chunk` builds a rope that
  // the next character access flattens, so filling 64 KB at a time turns
  // reading one value into O(n^2) copying - measurably minutes and gigabytes
  // on a real backup. One megabyte per top-up makes that linear again.
  const FILL_TARGET = 1024 * 1024;
  const fill = async (): Promise<boolean> => {
    if (ended) return false;
    const parts: string[] = [];
    let got = 0;
    while (got < FILL_TARGET) {
      const next = await it.next();
      if (next.done) {
        ended = true;
        parts.push(decoder.end());
        break;
      }
      const value = next.value;
      const text = typeof value === "string" ? value : decoder.write(Buffer.from(value));
      got += text.length;
      parts.push(text);
    }
    const text = parts.join("");
    buf += text;
    return text.length > 0;
  };
  const peek = async (): Promise<string> => {
    while (pos >= buf.length) if (!(await fill())) badFile("the file ends early");
    return buf[pos];
  };
  const skipWs = async () => {
    for (;;) {
      while (pos < buf.length && (buf[pos] === " " || buf[pos] === "\n" || buf[pos] === "\r" || buf[pos] === "\t")) pos++;
      if (pos < buf.length) return;
      if (!(await fill())) return;
    }
  };
  // Only ever called when nothing is holding an index into `buf`.
  const compact = () => {
    if (pos > 0) {
      buf = buf.slice(pos);
      pos = 0;
    }
  };
  const guard = (start: number, limit: number, what: string) => {
    if (pos - start > limit) badFile(`${what} is larger than this build can read`);
  };
  const isWs = (ch: string) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t";

  /**
   * Read the input to exhaustion once the snapshot object is complete.
   *
   * Not tidiness - correctness. The source generator only runs its epilogue
   * when the consumer pulls past its last yield, and on the encrypted path
   * that epilogue is the authentication tag check. Stopping at the closing
   * brace left it unexecuted, so a tampered file restored silently; stopping
   * at the closing brace on the plain path likewise left the fs read stream
   * open. Pulling until `done` fixes both, and it is the only reason a
   * backup's trailing bytes are looked at at all.
   *
   * Nothing but whitespace may follow, and only a little of it: a file with
   * megabytes of trailing text is not a backup this wrote, and continuing to
   * decrypt it just to reach the tag is work an attacker gets to choose.
   */
  const TRAILING_LIMIT = 64 * 1024;
  const drainToEnd = async () => {
    let trailing = 0;
    for (;;) {
      for (let i = pos; i < buf.length; i++) {
        if (!isWs(buf[i])) badFile("the file continues past the end of the snapshot");
      }
      trailing += buf.length - pos;
      if (trailing > TRAILING_LIMIT) badFile("the file continues past the end of the snapshot");
      pos = buf.length;
      compact();
      if (!(await fill())) return;
    }
  };

  /** The raw text of the next JSON value, whatever kind it is. */
  const scanValue = async (limit: number, what: string): Promise<string> => {
    await skipWs();
    const lead = await peek();
    const start = pos;
    if (lead === "{" || lead === "[") {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (;;) {
        while (pos < buf.length) {
          const ch = buf[pos++];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === "{" || ch === "[") depth++;
          else if (ch === "}" || ch === "]") {
            if (--depth === 0) return buf.slice(start, pos);
          }
        }
        guard(start, limit, what);
        if (!(await fill())) badFile("the file ends early");
      }
    }
    if (lead === '"') {
      pos++;
      let esc = false;
      for (;;) {
        while (pos < buf.length) {
          const ch = buf[pos++];
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') return buf.slice(start, pos);
        }
        guard(start, limit, what);
        if (!(await fill())) badFile("the file ends early");
      }
    }
    // A number, true, false or null: ends at the first structural character.
    for (;;) {
      while (pos < buf.length) {
        const ch = buf[pos];
        if (ch === "," || ch === "}" || ch === "]" || ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
          return buf.slice(start, pos);
        }
        pos++;
      }
      guard(start, limit, what);
      if (!(await fill())) return buf.slice(start, pos);
    }
  };

  const parseValue = (text: string, what: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return badFile(what);
    }
  };

  /** One attachment row, streaming its `data` value straight to the spool. */
  const scanAttachmentRow = async (): Promise<Record<string, unknown>> => {
    await skipWs();
    if ((await peek()) !== "{") badFile("an attachment row is malformed");
    pos++;
    const row: Record<string, unknown> = {};
    let bytes = 0;
    let opened = false;
    await skipWs();
    if ((await peek()) === "}") pos++;
    else
      for (;;) {
        compact();
        await skipWs();
        if ((await peek()) !== '"') badFile("an attachment row is malformed");
        const key = parseValue(
          await scanValue(4096, "an attachment row"),
          "an attachment row is malformed"
        ) as string;
        await skipWs();
        if ((await peek()) !== ":") badFile("an attachment row is malformed");
        pos++;
        await skipWs();
        if (key === "data" && (await peek()) === '"' && !opened) {
          pos++; // opening quote
          if (spool) {
            await spool.open();
            opened = true;
          }
          let carry = "";
          for (;;) {
            let end = -1;
            for (let i = pos; i < buf.length; i++) {
              const ch = buf[i];
              if (ch === '"') {
                end = i;
                break;
              }
              // Base64 needs no escapes, and honouring them here would mean
              // holding the value to unescape it. Refuse rather than pretend.
              if (ch === "\\") badFile("an attachment row's data is not plain base64");
            }
            const stop = end === -1 ? buf.length : end;
            if (stop > pos) {
              const text = carry + buf.slice(pos, stop);
              const whole = text.length - (text.length % 4);
              if (whole > 0) {
                const decoded = Buffer.from(text.slice(0, whole), "base64");
                bytes += decoded.length;
                if (spool) await spool.write(decoded);
              }
              carry = text.slice(whole);
              pos = stop;
            }
            if (end !== -1) {
              pos++; // closing quote
              if (carry.length > 0) {
                const decoded = Buffer.from(carry, "base64");
                bytes += decoded.length;
                if (spool) await spool.write(decoded);
              }
              break;
            }
            compact();
            if (!(await fill())) badFile("the file ends early");
          }
        } else {
          row[key] = parseValue(
            await scanValue(65_536, "an attachment row"),
            "an attachment row is malformed"
          );
        }
        await skipWs();
        const sep = await peek();
        pos++;
        if (sep === ",") continue;
        if (sep === "}") break;
        badFile("an attachment row is malformed");
      }
    if (spool) await spool.close(row, bytes, opened);
    return row;
  };

  const out: Record<string, unknown> = {};
  // The bound on one row's RAW TEXT - a different string from the one
  // applyFileLimits measures, and therefore deliberately a different number.
  // See MAX_RESTORED_ROW: sharing MAX_RESTORED_CONTENT with the file-limit pass
  // made this scanner the tighter of the two readers by the JSON-escaping
  // factor, so a page Keel itself can hold restored from cloud and was refused
  // by import. Attachment rows are exempt because their one large field never
  // lands in the buffer at all.
  const ROW_LIMIT = MAX_RESTORED_ROW;
  // A hand-built file can invent top-level keys the format has no use for, and
  // each one is another ROW_LIMIT-sized value retained in `out`. The format has
  // eleven; a hundred is room for every future field at once.
  const MAX_KEYS = 100;

  await skipWs();
  if ((await peek()) !== "{") badFile("not a snapshot object");
  pos++;
  await skipWs();
  if ((await peek()) === "}") {
    pos++;
    await drainToEnd();
    return out as unknown as Snapshot;
  }
  let keys = 0;
  for (;;) {
    compact();
    await skipWs();
    if ((await peek()) !== '"') badFile("a key is malformed");
    if (++keys > MAX_KEYS) badFile("the snapshot object has implausibly many fields");
    const key = parseValue(await scanValue(4096, "a key"), "a key is malformed") as string;
    await skipWs();
    if ((await peek()) !== ":") badFile("a key has no value");
    pos++;
    if (ARRAY_SECTIONS.has(key)) {
      const attachments = key === "attachments";
      // Enforced per row, not on the finished list: the whole point is to
      // refuse a row-heavy file before its rows are in the heap.
      const cap = SECTION_CAPS[key as keyof typeof SECTION_CAPS];
      const rows: unknown[] = [];
      await skipWs();
      if ((await peek()) !== "[") badFile(`${key} is not a list`);
      pos++;
      await skipWs();
      if ((await peek()) === "]") pos++;
      else
        for (;;) {
          compact();
          if (rows.length >= cap) badFile(`the ${key} section is implausibly large`);
          if (attachments) {
            rows.push(await scanAttachmentRow());
          } else {
            rows.push(parseValue(await scanValue(ROW_LIMIT, `a ${key} row`), `a ${key} row is malformed`));
          }
          await skipWs();
          const sep = await peek();
          pos++;
          if (sep === ",") continue;
          if (sep === "]") break;
          badFile(`the ${key} list is malformed`);
        }
      // A repeated section would otherwise drop the first copy's rows on the
      // floor after paying for them, and hand assertSnapshotShape a list that
      // was never checked against the cap as it grew.
      if (out[key] !== undefined) badFile(`the ${key} section appears twice`);
      out[key] = rows;
    } else {
      out[key] = parseValue(await scanValue(ROW_LIMIT, `the ${key} field`), `the ${key} field is malformed`);
    }
    await skipWs();
    const sep = await peek();
    pos++;
    if (sep === ",") continue;
    if (sep === "}") break;
    badFile("the snapshot object is malformed");
  }
  // Read the rest of the input BEFORE handing the snapshot back - see the note
  // on drainToEnd. Nothing downstream may see this object until the source has
  // been driven to completion.
  await drainToEnd();
  return out as unknown as Snapshot;
}

/**
 * Decrypt an envelope as it arrives.
 *
 * Works on both envelope versions by finding `"data":"` and treating what
 * precedes it as the header (kdf, iv, and - in v1 - the tag) and what follows
 * the closing quote as the trailer (in v2, the tag). Base64 is ASCII with no
 * escapes, so the ciphertext can be located and decoded by a plain scan; only
 * the header and trailer, both a few hundred bytes, are ever parsed as JSON.
 *
 * `state.authenticated` is how a consumer knows whether the plaintext it just
 * read was ever authenticated. A generator cannot force anyone to pull it to
 * completion, and the tag check necessarily lives at the end - so "we reached
 * the end" has to be an observable fact rather than an assumption about how
 * the consumer behaves. readBackupStream refuses to return a snapshot without
 * it; that is the whole authentication guarantee, and it is deliberately not
 * expressed as trust in scanSnapshot's loop conditions, because the previous
 * version of exactly that trust is what let a forged tag through.
 */
async function* decryptStream(
  chunks: AsyncIterable<Uint8Array | string>,
  passphrase: string,
  state: { authenticated: boolean }
): AsyncGenerator<Buffer> {
  const it = chunks[Symbol.asyncIterator]();
  let s = "";
  const pull = async (): Promise<boolean> => {
    const next = await it.next();
    if (next.done) return false;
    const value = next.value;
    s += typeof value === "string" ? value : Buffer.from(value).toString("latin1");
    return true;
  };

  const MARK = '"data":"';
  let at = -1;
  while ((at = s.indexOf(MARK)) === -1) {
    if (s.length > 65_536) badEnvelope("the encrypted header is malformed");
    if (!(await pull())) badEnvelope("the file ends early");
  }
  let head = s.slice(0, at).trimEnd();
  if (head.endsWith(",")) head = head.slice(0, -1);
  let env: Partial<EncryptedEnvelope>;
  try {
    env = JSON.parse(`${head}}`);
  } catch {
    return badEnvelope("the encrypted header is malformed");
  }
  if (!env.kdf || typeof env.iv !== "string") badEnvelope("the encrypted header is malformed");
  s = s.slice(at + MARK.length);

  // Bounded before it runs, not after: N, r and p come out of the file, and
  // scrypt's cost is their product. See scryptOptionsFrom. The salt goes
  // through scryptSaltFrom for the same reason - it is part of the header, and
  // a malformed header must be reported as one.
  const key = await scryptAsync(
    passphrase,
    scryptSaltFrom(env.kdf),
    32,
    scryptOptionsFrom(env.kdf)
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));

  for (;;) {
    const quote = s.indexOf('"');
    if (quote !== -1) {
      if (quote > 0) yield decipher.update(Buffer.from(s.slice(0, quote), "base64"));
      s = s.slice(quote + 1);
      break;
    }
    // Only whole 4-character groups: base64 decodes 4 chars to 3 bytes, and a
    // split group would silently drop bytes.
    const n = s.length - (s.length % 4);
    if (n > 0) {
      yield decipher.update(Buffer.from(s.slice(0, n), "base64"));
      s = s.slice(n);
    }
    if (!(await pull())) badEnvelope("the file ends early");
  }

  while (s.indexOf("}") === -1 && (await pull())) {
    if (s.length > 65_536) badEnvelope("the encrypted trailer is malformed");
  }
  let tag = env.tag;
  const trailer = s.trimStart().replace(/^,/, "");
  if (!tag) {
    try {
      tag = (JSON.parse(`{${trailer}`) as { tag?: string }).tag;
    } catch {
      tag = undefined;
    }
  }
  if (!tag) badEnvelope("the encrypted backup carries no authentication tag");
  // The authentication check. final() throws if the tag does not match the
  // ciphertext that went through update() - a forged tag, a flipped ciphertext
  // byte, or a truncated file all land here. The flag is set BEFORE the yield,
  // because a consumer that takes this last chunk and then walks away would
  // otherwise leave the generator suspended with the check already passed but
  // unrecorded.
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const last = decipher.final();
  state.authenticated = true;
  yield last;
}

/**
 * Read a backup file from a stream: plain snapshot JSON or an encrypted
 * envelope, of any size.
 *
 * Attachment bytes are decoded and spooled to a temp directory as they go, so
 * the peak is one attachment rather than all of them. The caller MUST call
 * dispose() when the restore is finished (or has failed) - the spool is real
 * disk space.
 *
 * THE AUTHENTICATION GUARANTEE. For an encrypted file, this function returns
 * only if the AES-GCM tag over the ENTIRE ciphertext verified. Not "usually",
 * not "for files of the right size": the plaintext generator is driven to
 * exhaustion by scanSnapshot's drainToEnd, which is what executes
 * decipher.final(), and the flag decryptStream sets there is then checked
 * before anything is handed back. Callers restore what this returns, so
 * verification is strictly before the first row is written - a tampered file
 * cannot land a single row and fail afterwards.
 *
 * The two ways to get this wrong, both of which have been shipped here:
 * verifying at end-of-stream but letting the consumer stop early (a forged tag
 * was accepted whenever the reader's fill landed on the document's last brace,
 * and a targeted ciphertext flip rewrote a restored page's title), and
 * verifying at end-of-stream while the restore writes rows as they arrive
 * (tampered data in the database before the check fails). The snapshot is
 * therefore fully read AND fully authenticated before this returns.
 *
 * And a third, which the guarantee above cannot see on its own: letting the
 * FILE decide that none of it applies, by presenting a plaintext header. See
 * the trust-boundary note above parseBackup - whether this file must be
 * encrypted is settled here, from what the caller knows, before the header is
 * looked at.
 */
export async function readBackupStream(
  source: AsyncIterable<Uint8Array | string>,
  passphrase?: string,
  expectEncrypted?: boolean
): Promise<{ snapshot: Snapshot; attachmentBytes: AttachmentBytes; dispose: () => Promise<void> }> {
  // Every reason to demand encryption, OR-ed: the caller's explicit assertion,
  // the name the stream was opened under (backupFileStream registers it), and
  // the presence of a passphrase. A file cannot subtract from this.
  const mustBeEncrypted =
    expectEncrypted === true ||
    sourceExpectsEncrypted.get(source) === true ||
    passphrase !== undefined;
  // Buffer just enough of the head to read the `format` field, then put it
  // back in front of the stream.
  const it = source[Symbol.asyncIterator]();
  const head: (Uint8Array | string)[] = [];
  let headText = "";
  while (headText.length < 4096) {
    const next = await it.next();
    if (next.done) break;
    head.push(next.value);
    headText += typeof next.value === "string"
      ? next.value
      : Buffer.from(next.value).toString("latin1");
  }
  async function* rejoined(): AsyncGenerator<Uint8Array | string> {
    for (const chunk of head) yield chunk;
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      yield next.value;
    }
  }

  const format = /"format"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(headText)?.[1];
  if (format !== undefined && !/^(keel|nopin)-backup(-encrypted)?$/.test(format)) {
    badFile("unknown format");
  }
  const encrypted = format?.endsWith("-encrypted") ?? false;
  // Both directions, and the downgrade one FIRST - a file that answers "not
  // encrypted" when the caller opened it as encrypted is refused here, before
  // the spool directory exists and long before a row is written. Nothing
  // downstream would catch it: with `encrypted` false the whole GCM path,
  // including the authentication assert below, is skipped by construction.
  if (mustBeEncrypted && !encrypted) refuseUnencrypted();
  if (encrypted && !passphrase) {
    throw new Error("This backup is encrypted - a passphrase is required.");
  }

  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "keel-restore-"));
  const files = new Map<string, { file: string | null; bytes: number }>();

  const perFileCap = maxAttachmentBytes();
  let index = 0;
  let current: { file: string; handle: fs.FileHandle } | null = null;
  let written = 0;

  /**
   * Close the descriptor an in-flight attachment row is holding.
   *
   * spool.close() does this on the happy path, but it is reached only if the
   * row finishes. Every throw between spool.open() and spool.close() - a
   * backslash inside `data`, a truncated file, any parse error in the rest of
   * the row - used to unwind straight past it, and dispose()'s fs.rm unlinks
   * the file without closing the handle. On Node >= 24 the GC then raises
   * ERR_INVALID_STATE for the FileHandle it collects, which is fatal to the
   * process; below that it is a permanently leaked fd per failed import, i.e.
   * EMFILE after enough of them. Idempotent, so the finally below can call it
   * whatever else happened.
   */
  const closeCurrent = async () => {
    const open = current;
    current = null;
    if (open) await open.handle.close().catch(() => {});
  };
  // dispose() is also the caller's cleanup hook, so it closes too: a consumer
  // that abandons the read after a failure gets its descriptors back by doing
  // the one thing the contract already requires of it.
  const dispose = async () => {
    await closeCurrent();
    await fs.rm(spoolDir, { recursive: true, force: true }).catch(() => {});
  };
  const spool: AttachmentSpool = {
    async open() {
      const file = path.join(spoolDir, `${index++}.bin`);
      current = { file, handle: await fs.open(file, "w") };
      written = 0;
    },
    async write(bytes) {
      if (!current) return;
      // Stop writing once the row is clearly past the per-file cap. The
      // scanner keeps counting, so the restore can report how big it actually
      // was - but a hand-built file must not be able to fill the disk with an
      // attachment that was always going to be refused.
      if (written >= perFileCap) return;
      written += bytes.length;
      await current.handle.write(bytes);
    },
    async close(row, bytes, opened) {
      const open = current;
      current = null;
      if (open) await open.handle.close();
      const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
      if (!opened || !id || files.has(id)) {
        // No usable id, no data value, or a duplicate id (first row wins, as
        // in the restore) - nothing to keep.
        if (open) await fs.rm(open.file, { force: true }).catch(() => {});
        return;
      }
      if (bytes > 0 && bytes <= perFileCap) {
        files.set(id, { file: open!.file, bytes });
        return;
      }
      // Empty or over the cap: remember the size so the restore's plan can
      // classify it, but keep no bytes.
      if (open) await fs.rm(open.file, { force: true }).catch(() => {});
      files.set(id, { file: null, bytes });
    },
  };

  const auth = { authenticated: false };
  try {
    const plain = encrypted ? decryptStream(rejoined(), passphrase!, auth) : rejoined();
    let snapshot: Snapshot;
    try {
      snapshot = await scanSnapshot(plain, spool);
    } catch (err) {
      // A wrong passphrase produces plausible-looking garbage, so the failure
      // surfaces here rather than at the authentication tag. Say the useful
      // thing instead of "not valid JSON" - but not for a complaint about the
      // envelope itself (a hostile KDF block, a missing tag), which is a fact
      // about the file and not a guess about the passphrase.
      if (encrypted && !(err instanceof EnvelopeError)) {
        throw new Error("Wrong passphrase (or corrupted backup).");
      }
      throw err;
    }
    // scanSnapshot drains its input, so this is already true by construction.
    // It is asserted anyway because the guarantee must not rest on a loop
    // condition several hundred lines away: if any future change lets the scan
    // stop early again, this refuses the file instead of silently restoring
    // unauthenticated plaintext.
    if (encrypted && !auth.authenticated) {
      throw new Error("Wrong passphrase (or corrupted backup).");
    }
    const fmt = (snapshot as { format?: string }).format;
    if (fmt !== "keel-backup" && fmt !== "nopin-backup") badFile("unknown format");
    assertSnapshotShape(snapshot);
    applyFileLimits(snapshot);
    return { snapshot, attachmentBytes: spooledAttachmentBytes(files), dispose };
  } catch (err) {
    await dispose();
    throw err;
  } finally {
    // Close the source on EVERY exit, success included. It is an fs read stream
    // on both restore routes, and only the failure path used to close it - but
    // a successful ENCRYPTED read is exactly where it stays open: decryptStream
    // stops pulling the moment the trailer's closing brace is in hand, so
    // `rejoined()` is left suspended one next() short of done and nothing ever
    // drives this iterator to completion. (The plain path closed itself only
    // incidentally, because scanSnapshot's drainToEnd reads to end-of-input.)
    // The cost was one descriptor per successful encrypted restore, permanently
    // - and on the import route that descriptor pins the multi-gigabyte upload
    // spool the route has already unlinked, so the disk space does not come
    // back until the process does.
    await it.return?.().catch(() => {});
    await closeCurrent();
  }
}

/**
 * One of the workspace's backup files, as a stream of chunks.
 *
 * The name is basenamed and must carry this workspace's backup prefix, so a
 * caller cannot read arbitrary files by passing a path. Streamed rather than
 * read into a string (as this used to be) because a backup of a workspace
 * anywhere near its attachment quota is larger than a string can be, and its
 * own restore route refusing to read it would be absurd.
 *
 * The stream also carries what its NAME claims about encryption, so
 * readBackupStream can hold the file to it. That claim is the one the UI has
 * already made to the operator - the padlock in the backup list and the
 * passphrase prompt are both isEncryptedBackupName() - and nothing used to
 * re-derive it from the bytes, which is how a .keelbak whose contents had been
 * swapped for plaintext restored as a clean encrypted restore. The expectation
 * travels beside the stream rather than in it: it comes from the directory
 * entry, never from anything the file can say about itself.
 */
export function backupFileStream(
  workspace: { id: string; backupDir: string | null },
  filename: string
): AsyncIterable<Buffer> {
  const safe = path.basename(filename);
  if (!backupPrefixes(workspace.id).some((p) => safe.startsWith(p))) {
    throw new Error("Unknown backup file.");
  }
  const stream = createReadStream(path.join(backupDirFor(workspace), safe));
  sourceExpectsEncrypted.set(stream, isEncryptedBackupName(safe));
  return stream;
}

/* ---------- Backup files on disk ---------- */

/** The directory Keel owns for backups. Everything else needs permission. */
export function backupRoot(): string {
  return (
    keelEnv("BACKUP_DIR") ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "backups")
  );
}

/** Whether `dir` resolves inside the backup root (no `..` escapes). */
export function isInsideBackupRoot(dir: string): boolean {
  const root = backupRoot();
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Validate a custom backup directory before storing it.
 *
 * A custom path is a genuine feature - pointing the folder at a OneDrive or
 * Dropbox sync directory is how off-site backups work without OAuth. But it is
 * also an arbitrary-write primitive: runBackup() mkdir -p's the target and
 * writes files there, and prunes matching files out of it. So arbitrary paths
 * are restricted to the person who runs the server, who already has that power.
 * Everyone else is confined to the backup root.
 */
export function assertBackupDirAllowed(dir: string | null, opts: { isInstanceOwner: boolean }) {
  if (!dir) return;
  const trimmed = dir.trim();
  if (!trimmed) return;
  if (trimmed.includes("\0")) throw new Error("That backup folder path isn't valid.");
  if (isInsideBackupRoot(trimmed)) return;
  if (opts.isInstanceOwner || keelFlag("ALLOW_ANY_BACKUP_DIR")) return;
  throw new Error(
    `Backups must stay inside ${backupRoot()}. Only the instance owner can point them elsewhere.`
  );
}

const warnedDirs = new Set<string>();

export function backupDirFor(workspace: { id: string; backupDir: string | null }): string {
  const custom = workspace.backupDir?.trim();
  if (custom) {
    // Stored values are honoured - silently relocating an operator's
    // OneDrive/Dropbox-synced backup folder would be worse than the residual
    // risk, and assertBackupDirAllowed() now guards the way in. But say so, so
    // an unexpected path is visible in the log rather than only in the schema.
    if (!isInsideBackupRoot(custom) && !warnedDirs.has(custom)) {
      warnedDirs.add(custom);
      console.warn(
        `[keel] workspace ${workspace.id} backs up outside ${backupRoot()}: ${custom}`
      );
    }
    return path.resolve(custom);
  }
  // The desktop app points KEEL_BACKUP_DIR at the user's data directory.
  return path.resolve(backupRoot(), workspace.id);
}

/**
 * Tighten backups created by older Keel versions. Only the per-workspace
 * directory Keel chose itself is changed. An operator-supplied custom folder
 * may have deliberate shared-folder permissions and is left untouched.
 */
async function hardenOwnedBackupDirectory(
  workspace: { id: string; backupDir: string | null },
  dir: string
): Promise<void> {
  if (workspace.backupDir?.trim()) return;
  await fs.chmod(dir, 0o700).catch(() => {});
  const prefixes = backupPrefixes(workspace.id);
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!prefixes.some((prefix) => name.startsWith(prefix)) || !isBackupName(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) await fs.chmod(file, 0o600);
    } catch {}
  }
}

/** Prefix for newly written backups. Reading accepts backupPrefixes(). */
function backupPrefix(workspaceId: string) {
  return backupPrefixes(workspaceId)[0];
}



export async function configuredBackupPassphrase(): Promise<string | undefined> {
  return resolveScheduledBackupPassphrase();
}

/**
 * Retry backoff for workspaces whose scheduled backup keeps failing.
 *
 * A failed backup must NOT advance lastBackupAt - that would make Settings
 * claim a backup happened. But the scheduler's due-check reads only
 * lastBackupAt, so a workspace that cannot back up stayed permanently due and
 * was retried on every five-minute tick, forever: for an attachment-heavy
 * workspace, the entire workspace re-read twelve times an hour to reach the
 * same error.
 *
 * So failures are tracked here instead: the base interval, then double, then
 * double again, until the retry cadence reaches the workspace's own backup
 * interval - which is the fastest a *successful* backup would ever run, and
 * therefore the slowest this should ever get. A success clears the entry.
 *
 * Deliberately in-process rather than a column: this is scheduling state, not
 * user data, and a restart is a configuration change often enough that
 * retrying promptly after one is the right behaviour.
 */
export const backupBackoff = (() => {
  const state = new Map<string, { failures: number; nextAt: number }>();
  return {
    ready(id: string): boolean {
      const entry = state.get(id);
      return !entry || Date.now() >= entry.nextAt;
    },
    /** Record a failure; returns the wait until the next attempt. */
    fail(id: string, baseMs: number, capMs: number): number {
      const failures = (state.get(id)?.failures ?? 0) + 1;
      // 2 ** 40 is Infinity-adjacent nonsense; Math.min keeps it honest, and
      // the exponent is clamped so a long-broken workspace can't overflow it.
      const grown = baseMs * 2 ** Math.min(failures - 1, 30);
      const wait = Math.min(grown, Math.max(baseMs, capMs));
      state.set(id, { failures, nextAt: Date.now() + wait });
      return wait;
    },
    clear(id: string): void {
      state.delete(id);
    },
    /** Tests only. */
    reset(): void {
      state.clear();
    },
  };
})();

const backupRuntime = globalThis as unknown as {
  __keelBackupRuns?: Set<string>;
};
const backupRuns = (backupRuntime.__keelBackupRuns ??= new Set<string>());

export class BackupInProgressError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super("A backup for this workspace is already running. Try again after it finishes.");
    this.name = "BackupInProgressError";
    this.workspaceId = workspaceId;
  }
}

/** Process-wide per-workspace lease. Different workspaces remain independent,
 * while manual and scheduled runs for the same workspace cannot interleave. */
export const backupLease = {
  acquire(workspaceId: string): boolean {
    if (backupRuns.has(workspaceId)) return false;
    backupRuns.add(workspaceId);
    return true;
  },
  release(workspaceId: string): void {
    backupRuns.delete(workspaceId);
  },
  /** Tests only. */
  reset(): void {
    backupRuns.clear();
  },
};

/** Write a backup file for the workspace, upload to cloud storage when
 *  connected, and prune old local copies. */
export async function runBackup(
  workspace: {
    id: string;
    backupDir: string | null;
    backupKeep: number;
    backupEncrypt: boolean;
    cloudProvider?: string | null;
    cloudRefreshToken?: string | null;
    cloudFolderId?: string | null;
  },
  passphrase?: string
): Promise<{ file: string; cloud?: string }> {
  if (!backupLease.acquire(workspace.id)) {
    throw new BackupInProgressError(workspace.id);
  }
  try {
    return await runBackupExclusive(workspace, passphrase);
  } finally {
    backupLease.release(workspace.id);
  }
}

async function runBackupExclusive(
  workspace: {
    id: string;
    backupDir: string | null;
    backupKeep: number;
    backupEncrypt: boolean;
    cloudProvider?: string | null;
    cloudRefreshToken?: string | null;
    cloudFolderId?: string | null;
  },
  passphrase?: string
): Promise<{ file: string; cloud?: string }> {
  // Resolve the key FIRST. Snapshotting a workspace is the expensive part of
  // this function, and discovering afterwards that it can't be encrypted threw
  // all of it away - which, on a scheduler that retried every five minutes,
  // meant re-reading the whole workspace forever to reach the same throw.
  let key: string | undefined;
  if (workspace.backupEncrypt) {
    key = passphrase ?? (await configuredBackupPassphrase());
    if (!key) {
      throw new Error(
        "Backup encryption is enabled but no passphrase is available. Configure the scheduled-backup secret in Settings or the host environment."
      );
    }
  }

  const dir = backupDirFor(workspace);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await hardenOwnedBackupDirectory(workspace, dir);

  const ext = key ? ENCRYPTED_EXTENSION : ".json";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = crypto.randomBytes(4).toString("hex");
  const file = path.join(dir, `${backupPrefix(workspace.id)}${stamp}-${nonce}${ext}`);
  const tmp = file + ".tmp";

  // Straight to disk, chunk by chunk. The whole file is never a string and
  // never a Buffer - the peak is one attachment's bytes plus a base64 slice,
  // whatever the workspace holds.
  const plain = snapshotChunks(workspace.id);
  const out = key ? encryptedChunks(plain, key) : plain;
  try {
    const { pipeline } = await import("node:stream/promises");
    await pipeline(
      out,
      createWriteStream(tmp, { encoding: "utf8", flags: "wx", mode: 0o600 })
    );
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await fs.rename(tmp, file); // atomic: never leaves a half-written backup

  // Off-site copy via Google Drive / OneDrive when connected. A cloud failure
  // never fails the backup itself - it's surfaced in Settings instead.
  let cloud: string | undefined;
  let cloudError: string | null = null;
  const cw = {
    id: workspace.id,
    cloudProvider: workspace.cloudProvider ?? null,
    cloudRefreshToken: workspace.cloudRefreshToken ?? null,
    cloudFolderId: workspace.cloudFolderId ?? null,
  };
  if (cloudConnected(cw)) {
    try {
      // Every provider reads bounded chunks from the completed local file.
      // The upload therefore has the same size ceiling as the on-disk backup,
      // not V8's much smaller maximum string length.
      await uploadBackupToCloud(cw, path.basename(file), file);
      cloud =
        workspace.cloudProvider === "google" ? "Google Drive" :
        workspace.cloudProvider === "onedrive" ? "OneDrive" :
        workspace.cloudProvider === "r2" ? "Cloudflare R2" :
        workspace.cloudProvider === "azure" ? "Azure Blob Storage" :
        "Cloud storage";
    } catch (err) {
      cloudError = `Backup saved locally, but the cloud upload failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { lastBackupAt: new Date(), lastBackupError: cloudError },
  });

  // Prune old backups beyond backupKeep.
  const keep = Math.max(1, workspace.backupKeep);
  const entries = await listBackups(workspace);
  for (const old of entries.slice(keep)) {
    await fs.unlink(path.join(dir, old.name)).catch(() => {});
  }

  return { file, cloud };
}

export async function listBackups(workspace: {
  id: string;
  backupDir: string | null;
}): Promise<{ name: string; size: number; modifiedAt: string }[]> {
  const dir = backupDirFor(workspace);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  await hardenOwnedBackupDirectory(workspace, dir);
  const prefixes = backupPrefixes(workspace.id);
  const out: { name: string; size: number; modifiedAt: string }[] = [];
  for (const name of names) {
    // Pre-rename files are still this workspace's backups and must stay listed.
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    if (!isBackupName(name)) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      out.push({ name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
