// The record tree: the edges the mind map draws.
//
// Records in one database form a forest via parentRecordId. Two invariants
// matter and both are enforced here rather than in the UI:
//
//   1. No cycles. A node reparented under its own descendant would create a
//      ring that every tree walk in the app loops on forever.
//   2. No cross-database edges. A parent must live in the same database.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export interface TreeNode<T> {
  record: T;
  children: TreeNode<T>[];
  depth: number;
}

/**
 * Build a forest from a flat record list.
 *
 * Records whose parent is missing (deleted, filtered out, in another database)
 * surface as roots rather than disappearing - the same rule getPageTree uses
 * for orphaned pages.
 */
export function buildForest<T extends { id: string; parentRecordId: string | null; sortOrder: number }>(
  records: T[]
): TreeNode<T>[] {
  const present = new Set(records.map((r) => r.id));
  const byParent = new Map<string | null, T[]>();
  for (const r of records) {
    const key = r.parentRecordId && present.has(r.parentRecordId) ? r.parentRecordId : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(r);
    else byParent.set(key, [r]);
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  // Iterative, not recursive: a deep tree shouldn't be able to blow the stack,
  // and a cycle that slipped past validation must terminate rather than hang.
  const seen = new Set<string>();
  const build = (parentId: string | null, depth: number): TreeNode<T>[] =>
    (byParent.get(parentId) ?? [])
      .filter((r) => !seen.has(r.id) && (seen.add(r.id), true))
      .map((record) => ({ record, children: build(record.id, depth + 1), depth }));

  return build(null, 0);
}

/** Every descendant id of `rootId`, inclusive. */
export function collectDescendants<T extends { id: string; parentRecordId: string | null }>(
  records: T[],
  rootId: string
): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const r of records) {
    if (!r.parentRecordId) continue;
    const bucket = byParent.get(r.parentRecordId);
    if (bucket) bucket.push(r.id);
    else byParent.set(r.parentRecordId, [r.id]);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()!) ?? []) {
      if (out.has(child)) continue; // defensive: a pre-existing cycle must terminate
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

export class TreeError extends Error {}

/**
 * Validate a reparent before writing it.
 *
 * Walks up from the proposed parent looking for `recordId`. Bounded by the
 * number of records, so a cycle already in the data can't spin forever.
 *
 * The walk is only a guarantee when it sees the same tree the write lands in:
 * two concurrent reparents (A under B, B under A) each pass a pre-write check
 * and jointly commit a cycle. Callers that write must run this on the SAME
 * transaction as the write - `db` takes the tx client for that.
 */
export async function assertCanReparent(
  recordId: string,
  parentRecordId: string | null,
  db: Prisma.TransactionClient = prisma
) {
  if (!parentRecordId) return;
  if (parentRecordId === recordId) throw new TreeError("A record can't be its own parent.");

  const record = await db.databaseRecord.findUnique({
    where: { id: recordId },
    select: { databaseId: true },
  });
  const parent = await db.databaseRecord.findUnique({
    where: { id: parentRecordId },
    select: { databaseId: true },
  });
  if (!record || !parent) throw new TreeError("Record not found.");
  if (record.databaseId !== parent.databaseId) {
    throw new TreeError("A record's parent must be in the same database.");
  }

  const total = await db.databaseRecord.count({ where: { databaseId: record.databaseId } });
  let cursor: string | null = parentRecordId;
  for (let steps = 0; cursor && steps <= total; steps++) {
    if (cursor === recordId) throw new TreeError("That would put a record inside itself.");
    const next: { parentRecordId: string | null } | null = await db.databaseRecord.findUnique({
      where: { id: cursor },
      select: { parentRecordId: true },
    });
    cursor = next?.parentRecordId ?? null;
  }
}

/**
 * A sortOrder that places a record between two neighbours.
 *
 * Board columns and mind-map siblings both need "drop it here, not just in this
 * bucket". Midpoints keep it to a single-row update; when floats get too close
 * to split, the caller renumbers.
 */
export function sortOrderBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1;
  if (before == null) return after! - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

/** True when neighbouring sortOrders have collapsed and need renumbering. */
export function needsRenumber(before: number | null, after: number | null): boolean {
  if (before == null || after == null) return false;
  return Math.abs(after - before) < 1e-6;
}

/** Rewrite a group's sortOrders as 1, 2, 3 … when midpoints run out of room. */
export async function renumber(ids: string[]) {
  await prisma.$transaction(
    ids.map((id, i) =>
      prisma.databaseRecord.update({ where: { id }, data: { sortOrder: i + 1 } })
    )
  );
}
