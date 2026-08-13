import { NextResponse } from "next/server";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { isInstanceOwner } from "@/lib/instance";
import { clientIp, rateLimit, UNIDENTIFIED_IP } from "@/lib/rate-limit";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireContext() {
  const ctx = await getCurrentContext();
  if (!ctx) throw new ApiError(401, "Not signed in");
  return ctx;
}

/** Like requireContext, but rejects members with view-only access. */
export async function requireEditor() {
  const ctx = await requireContext();
  if (ctx.role !== "owner" && ctx.role !== "editor") {
    throw new ApiError(403, "You have view-only access to this workspace");
  }
  return ctx;
}

/**
 * Only the owner of the ACTIVE WORKSPACE passes. Use for workspace-scoped
 * settings: members, invites, backup configuration, cloud connections.
 *
 * NOT sufficient for instance-wide powers - every account owns its own
 * workspace, so this is true for literally everyone. Use requireInstanceOwner.
 */
export async function requireOwner() {
  const ctx = await requireContext();
  if (ctx.role !== "owner") {
    throw new ApiError(403, "Only the workspace owner can do this");
  }
  return ctx;
}

/**
 * Only the person who runs this server passes. Use for instance-wide powers:
 * the public-site CMS, the sign-in allowlist, the tunnel. See src/lib/instance.ts.
 */
export async function requireInstanceOwner() {
  const ctx = await requireContext();
  if (!(await isInstanceOwner(ctx.user))) {
    throw new ApiError(403, "This is restricted to the instance owner");
  }
  return ctx;
}

export async function requirePage(pageId: string, workspaceId: string) {
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page || page.workspaceId !== workspaceId) throw new ApiError(404, "Page not found");
  return page;
}

export async function requireDatabase(databaseId: string, workspaceId: string) {
  const db = await prisma.database.findUnique({ where: { id: databaseId } });
  if (!db || db.workspaceId !== workspaceId) throw new ApiError(404, "Database not found");
  return db;
}

/**
 * Apply a request budget to an endpoint, throwing 429 when it's exceeded.
 *
 * Keyed on the caller's identity when we have one (a signed-in user shouldn't
 * be throttled by someone else behind the same NAT) and on IP otherwise.
 */
export async function enforceLimit(
  action: string,
  opts: { limit: number; windowMs: number; blockMs?: number; userId?: string }
) {
  let who: string;
  if (opts.userId) {
    who = `u:${opts.userId}`;
  } else {
    const ip = await clientIp();
    // Unknowable address (no trusted proxy): skip rather than throttle every
    // anonymous caller through one shared bucket, which an attacker could
    // exhaust to lock everyone out. See UNIDENTIFIED_IP in rate-limit.ts.
    if (ip === UNIDENTIFIED_IP) return;
    who = `ip:${ip}`;
  }
  const result = rateLimit(`${action}:${who}`, opts.limit, opts.windowMs, opts.blockMs);
  if (!result.ok) {
    throw new ApiError(429, `Too many requests - try again in ${result.retryAfter}s.`);
  }
}

/** Prisma's unique-constraint error (P2002), without importing the error class. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

export function handleApiError(err: unknown) {
  if (err instanceof ApiError) {
    const headers =
      err.status === 429
        ? { "Retry-After": String(/(\d+)s/.exec(err.message)?.[1] ?? 60) }
        : undefined;
    return NextResponse.json({ error: err.message }, { status: err.status, headers });
  }
  console.error(err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/**
 * IDs of a page and all its descendants, parents before children.
 *
 * Used by trash, restore, hard delete and every page move. It used to load
 * EVERY page in the workspace to build a parent map, which made dragging one
 * page in the sidebar an O(workspace) query. This walks level by level instead:
 * one query per depth, each an index lookup on (workspaceId, parentPageId), so
 * the cost follows the subtree rather than the workspace.
 *
 * Bounded by depth and total rows so a parent cycle in the data cannot spin.
 *
 * When the result gates a write (a move's inside-itself check), the walk must
 * run on the SAME transaction as the write - two concurrent moves that each
 * pass a pre-write check can jointly commit a cycle. `db` takes the tx client.
 */
export async function collectSubtreeIds(
  rootId: string,
  workspaceId: string,
  db: Prisma.TransactionClient = prisma
) {
  const ids: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];

  for (let depth = 0; frontier.length > 0 && depth < 100; depth++) {
    const children: { id: string }[] = await db.page.findMany({
      where: { workspaceId, parentPageId: { in: frontier } },
      select: { id: true },
    });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) continue; // defensive: a cycle must terminate
      seen.add(child.id);
      ids.push(child.id);
      frontier.push(child.id);
    }
    if (ids.length > 50_000) break; // a subtree this large is a runaway
  }
  return ids;
}
