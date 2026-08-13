// Audit trail for privileged actions.
//
// After the instance-owner bug there was no way to answer "what did they
// change?" - not who rewrote the allowlist, not who started a tunnel, not who
// connected cloud storage. This is that record.
//
// Two rules it lives by:
//   • Never block the action. A failed audit write is logged and swallowed; a
//     database hiccup must not stop someone locking their instance down.
//   • Never store a credential. Callers pass a small detail object; anything
//     that looks like a secret is dropped rather than trusted not to be one.

import { prisma } from "@/lib/prisma";
import { clientIp, UNIDENTIFIED_IP } from "@/lib/rate-limit";

export type AuditAction =
  // Instance-wide
  | "instance.claim"
  | "access.update"
  | "oauth.settings"
  | "operator.settings"
  | "tunnel.start"
  | "tunnel.stop"
  | "server.restart"
  | "site.project.create"
  | "site.project.update"
  | "site.project.delete"
  | "site.project.import"
  | "site.news.create"
  | "site.news.update"
  | "site.news.delete"
  // Workspace
  | "member.invite"
  | "member.role"
  | "member.remove"
  | "invite.revoke"
  | "workspace.settings"
  | "cloud.connect"
  | "cloud.disconnect"
  | "backup.run"
  | "backup.restore"
  | "workspace.import"
  | "workspace.export"
  // Account
  | "account.password"
  | "account.google.link"
  | "account.session.revoke"
  | "account.sessions.revokeAll"
  | "credential.register"
  | "credential.remove";

/** Keys whose values are never written, whatever a caller passes. */
const REDACT = /pass|secret|token|key|credential|authorization|cookie/i;

function safeDetail(detail: Record<string, unknown> | undefined): string | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (REDACT.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value == null || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, 200);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((v) => String(v).slice(0, 100));
    } else {
      out[key] = "[object]";
    }
  }
  const json = JSON.stringify(out);
  return json.length > 2000 ? json.slice(0, 2000) : json;
}

export async function audit(
  action: AuditAction,
  actor: { id: string; email: string; username?: string | null },
  opts: { target?: string; detail?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: actor.id,
        // Denormalised: the event has to still read correctly after the account
        // is deleted, which is precisely when you want to read it.
        actor: actor.username ?? actor.email,
        action,
        target: opts.target?.slice(0, 200) ?? null,
        detail: safeDetail(opts.detail),
        // Null, not a placeholder: on an unproxied instance the address is
        // genuinely unknown, and writing a sentinel would make the log look
        // like it recorded something it did not.
        ip: await clientIp()
          .then((v) => (v === UNIDENTIFIED_IP ? null : v))
          .catch(() => null),
      },
    });
  } catch (err) {
    // Auditing must never be the reason an action fails.
    console.error(`[keel] audit write failed for ${action}`, err);
  }
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

export async function listAuditEvents(limit = 100, before?: string): Promise<AuditEntry[]> {
  const rows = await prisma.auditEvent.findMany({
    where: before ? { createdAt: { lt: new Date(before) } } : undefined,
    orderBy: { createdAt: "desc" },
    take: Math.min(500, Math.max(1, limit)),
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    ip: r.ip,
  }));
}

/** Drop events older than the retention window. Called from the hourly sweep. */
export async function pruneAuditEvents(days = 365): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.auditEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}
