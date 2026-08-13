// Session management for the account owner.
//
// Sessions last 30 days. Before this, there was no way to end one early: a
// token copied off a shared laptop stayed valid for a month, a password change
// was impossible, and nothing pruned expired rows. Being able to see where you
// are signed in and cut one off is the minimum a self-hosted app owes its user.

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";

export interface SessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** This is the session making the request. */
  current: boolean;
}

export async function listSessions(userId: string, currentToken?: string): Promise<SessionSummary[]> {
  const rows = await prisma.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, token: true, createdAt: true, expiresAt: true },
  });
  return rows.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    current: Boolean(currentToken) && s.token === currentToken,
  }));
}

/** Revoke one session. Returns false when it isn't this user's. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const { count } = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
  return count > 0;
}

/**
 * End every session except the one making the request.
 *
 * Called on its own ("sign out everywhere") and automatically after a password
 * change - a password change that leaves old sessions alive doesn't lock out
 * whoever you changed it because of.
 */
export async function revokeOtherSessions(userId: string, keepToken?: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { userId, ...(keepToken ? { token: { not: keepToken } } : {}) },
  });
  return count;
}

/**
 * A stable, non-reversible label for a session token.
 *
 * Shown so you can tell one row from another without the response ever
 * carrying a usable credential. Truncated: it identifies, it doesn't
 * authenticate.
 */
export function sessionFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
