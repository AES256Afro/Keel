// Background retention. Three tables in Keel grow without bound:
//
//   • Session      - rows are checked for expiry at read time but never deleted.
//   • Notification - one row per mention/assignment, kept forever.
//   • RecentVisit  - one row per (user, page) forever, to render five entries.
//
// None of that matters at demo scale and all of it matters after a year. The
// sweep runs from the same tick as the backup scheduler (server-init.ts).

import { prisma } from "@/lib/prisma";
import { pruneLoginFailures } from "@/lib/rate-limit";
import { pruneAuditEvents } from "@/lib/audit";

/** Read notifications older than this are dropped. Unread ones are kept. */
const NOTIFICATION_TTL_DAYS = 90;
/** The sidebar shows five; keep enough for a future "recently visited" page. */
const KEEP_VISITS_PER_USER = 50;

/** Audit events are kept for a year - long enough to investigate, bounded. */
const AUDIT_TTL_DAYS = 365;

export interface SweepResult {
  sessions: number;
  notifications: number;
  visits: number;
  loginFailures: number;
  auditEvents: number;
}

export async function runMaintenance(): Promise<SweepResult> {
  const result: SweepResult = {
    sessions: 0,
    notifications: 0,
    visits: 0,
    loginFailures: 0,
    auditEvents: 0,
  };

  try {
    const { count } = await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    result.sessions = count;
  } catch (err) {
    console.error("[keel] session sweep failed", err);
  }

  try {
    const cutoff = new Date(Date.now() - NOTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff }, readAt: { not: null } },
    });
    result.notifications = count;
  } catch (err) {
    console.error("[keel] notification sweep failed", err);
  }

  try {
    result.visits = await pruneRecentVisits();
  } catch (err) {
    console.error("[keel] recent-visit sweep failed", err);
  }

  result.loginFailures = await pruneLoginFailures();

  try {
    result.auditEvents = await pruneAuditEvents(AUDIT_TTL_DAYS);
  } catch (err) {
    console.error("[keel] audit sweep failed", err);
  }

  return result;
}

/**
 * Keep only the newest KEEP_VISITS_PER_USER rows per user.
 *
 * Done per user rather than with one window-function query so it works
 * identically on SQLite and PostgreSQL, and only touches users who are actually
 * over the limit.
 */
async function pruneRecentVisits(): Promise<number> {
  const overflowing = await prisma.recentVisit.groupBy({
    by: ["userId"],
    _count: { _all: true },
    having: { userId: { _count: { gt: KEEP_VISITS_PER_USER } } },
  });

  let deleted = 0;
  for (const { userId } of overflowing) {
    const keep = await prisma.recentVisit.findMany({
      where: { userId },
      orderBy: { visitedAt: "desc" },
      take: KEEP_VISITS_PER_USER,
      select: { id: true },
    });
    const { count } = await prisma.recentVisit.deleteMany({
      where: { userId, id: { notIn: keep.map((k) => k.id) } },
    });
    deleted += count;
  }
  return deleted;
}
