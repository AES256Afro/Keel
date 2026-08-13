import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type OAuthConnectionProvider = "google" | "onedrive";
export type OAuthConnectionPurpose = "cloud" | "onenote";

export type OAuthConnectionSession = {
  id: string;
  userId: string;
};

type StoredConnectionState = {
  v: 1;
  sessionId: string;
  userId: string;
  workspaceId: string;
  provider: OAuthConnectionProvider;
  purpose: OAuthConnectionPurpose;
  stateHash: string;
  expiresAt: number;
};

export const OAUTH_CONNECTION_STATE_TTL_MS = 10 * 60 * 1000;
const PREFIX = "oauth.connection-state";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function keyFor(sessionId: string, purpose: OAuthConnectionPurpose): string {
  return `${PREFIX}.${purpose}.${sessionId}`;
}

function parse(value: string): StoredConnectionState | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredConnectionState>;
    if (
      parsed.v !== 1 ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId ||
      typeof parsed.userId !== "string" ||
      !parsed.userId ||
      typeof parsed.workspaceId !== "string" ||
      !parsed.workspaceId ||
      (parsed.provider !== "google" && parsed.provider !== "onedrive") ||
      (parsed.purpose !== "cloud" && parsed.purpose !== "onenote") ||
      typeof parsed.stateHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.stateHash) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed as StoredConnectionState;
  } catch {
    return null;
  }
}

export async function issueOAuthConnectionState(opts: {
  session: OAuthConnectionSession;
  workspaceId: string;
  provider: OAuthConnectionProvider;
  purpose: OAuthConnectionPurpose;
  now?: number;
}): Promise<{ state: string; expiresAt: Date }> {
  const now = opts.now ?? Date.now();
  const state = randomBytes(32).toString("base64url");
  const expiresAt = now + OAUTH_CONNECTION_STATE_TTL_MS;
  const key = keyFor(opts.session.id, opts.purpose);
  const value = JSON.stringify({
    v: 1,
    sessionId: opts.session.id,
    userId: opts.session.userId,
    workspaceId: opts.workspaceId,
    provider: opts.provider,
    purpose: opts.purpose,
    stateHash: digest(state),
    expiresAt,
  } satisfies StoredConnectionState);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  return { state, expiresAt: new Date(expiresAt) };
}

export type ConsumedOAuthConnectionState =
  | { ok: true; workspaceId: string }
  | {
      ok: false;
      reason: "invalid" | "expired" | "session-mismatch" | "provider-mismatch";
    };

/** Consume the current purpose-specific state for this exact session. The
 * caller separately confirms the session remains active and still belongs to
 * the same user before calling this function. */
export async function consumeOAuthConnectionState(opts: {
  session: OAuthConnectionSession;
  provider: OAuthConnectionProvider;
  purpose: OAuthConnectionPurpose;
  state: string;
  now?: number;
}): Promise<ConsumedOAuthConnectionState> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(opts.state)) {
    return { ok: false, reason: "invalid" };
  }
  const now = opts.now ?? Date.now();
  const key = keyFor(opts.session.id, opts.purpose);
  return prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) return { ok: false, reason: "invalid" } as const;
    const stored = parse(row.value);
    if (!stored || stored.stateHash !== digest(opts.state)) {
      return { ok: false, reason: "invalid" } as const;
    }
    if (stored.sessionId !== opts.session.id || stored.userId !== opts.session.userId) {
      return { ok: false, reason: "session-mismatch" } as const;
    }
    if (stored.provider !== opts.provider || stored.purpose !== opts.purpose) {
      return { ok: false, reason: "provider-mismatch" } as const;
    }
    const removed = await tx.appSetting.deleteMany({ where: { key, value: row.value } });
    if (removed.count !== 1) return { ok: false, reason: "invalid" } as const;
    if (stored.expiresAt <= now) return { ok: false, reason: "expired" } as const;
    return { ok: true, workspaceId: stored.workspaceId } as const;
  });
}

export async function pruneExpiredOAuthConnectionStates(
  now = Date.now(),
  maxBatches = 20
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  for (let batch = 0; batch < Math.max(1, maxBatches); batch++) {
    const rows = await prisma.appSetting.findMany({
      where: {
        key: {
          startsWith: `${PREFIX}.`,
          ...(cursor ? { gt: cursor } : {}),
        },
      },
      select: { key: true, value: true },
      orderBy: { key: "asc" },
      take: 500,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].key;
    const expired = rows
      .filter((row) => {
        const stored = parse(row.value);
        return !stored || stored.expiresAt <= now;
      })
      .map((row) => row.key);
    if (expired.length) {
      deleted += (
        await prisma.appSetting.deleteMany({ where: { key: { in: expired } } })
      ).count;
    }
    if (rows.length < 500) break;
  }
  return deleted;
}
