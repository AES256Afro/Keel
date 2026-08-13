// Instance ownership - deliberately NOT the same thing as workspace ownership.
//
// Every account gets its own workspace and is `owner` of it (see
// src/lib/signup.ts), so a workspace role can never gate instance-wide powers:
// the public-site CMS at /admin, the sign-in allowlist, the Cloudflare tunnel.
// Those belong to the person who runs the server, and to nobody else.
//
// Who that is, in order:
//   1. KEEL_OWNER_EMAIL - explicit, and the only option that survives a
//      database restore into someone else's hands. Set this in production.
//   2. Otherwise: whoever registered first (owner of the oldest workspace).
//      Right for a personal deployment that never configured anything.
//
// Deliberately no in-app way to grant instance ownership. Widening it must
// require access to the server, not to a session.

import { prisma } from "@/lib/prisma";
import { keelEnv } from "@/lib/env";

export function configuredOwnerEmails(): string[] {
  return (keelEnv("OWNER_EMAIL") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** Cached per process - the answer only changes on redeploy or first signup. */
const g = globalThis as unknown as { __keelFirstOwnerId?: string | null };

async function firstRegisteredUserId(): Promise<string | null> {
  if (g.__keelFirstOwnerId !== undefined) return g.__keelFirstOwnerId;
  const first = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { ownerId: true },
  });
  // Only memoize a real answer; an empty instance must re-check on next call.
  if (first) g.__keelFirstOwnerId = first.ownerId;
  return first?.ownerId ?? null;
}

export async function isInstanceOwner(user: { id: string; email: string }): Promise<boolean> {
  const configured = configuredOwnerEmails();
  if (configured.length > 0) return configured.includes(user.email.toLowerCase());
  return (await firstRegisteredUserId()) === user.id;
}

/** True when instance ownership is pinned by the environment (shown in Settings). */
export function instanceOwnerIsPinned(): boolean {
  return configuredOwnerEmails().length > 0;
}
