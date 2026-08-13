import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import type { VerifiedGoogleIdentity } from "@/lib/oauth";

const LINK_STATE_PREFIX = "oauth.account-link.google";
export const GOOGLE_ACCOUNT_LINK_TTL_MS = 5 * 60 * 1000;

type StoredLinkState = {
  version: 1;
  userId: string;
  expectedEmail: string;
  stateHash: string;
  expiresAt: number;
};

export type GoogleAccountLinkSession = {
  id: string;
  userId: string;
};

export type ConsumedGoogleAccountLinkState =
  | { ok: true; expectedEmail: string }
  | { ok: false; reason: "invalid" | "expired" };

export type GoogleAccountLinkResult =
  | { ok: true; alreadyLinked: boolean }
  | {
      ok: false;
      reason: "email-mismatch" | "subject-conflict" | "account-conflict" | "account-missing";
    };

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function stateDigest(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function sessionPrefix(sessionId: string): string {
  return `${LINK_STATE_PREFIX}.${sessionId}`;
}

function stateKey(sessionId: string): string {
  return sessionPrefix(sessionId);
}

function parseStoredState(value: string): StoredLinkState | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredLinkState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== "string" ||
      !parsed.userId ||
      typeof parsed.expectedEmail !== "string" ||
      !parsed.expectedEmail ||
      typeof parsed.stateHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.stateHash) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed as StoredLinkState;
  } catch {
    return null;
  }
}

/** Remove abandoned account-link requests in deterministic key-ordered
 * batches. The hourly maintenance sweep examines up to 10,000 rows; issuance
 * does one cheap batch as a backstop. Invalid rows are removed too. */
export async function pruneExpiredGoogleAccountLinkStates(
  now = Date.now(),
  maxBatches = 20
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  for (let batch = 0; batch < Math.max(1, maxBatches); batch++) {
    const rows = await prisma.appSetting.findMany({
      where: {
        key: {
          startsWith: `${LINK_STATE_PREFIX}.`,
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
        const value = parseStoredState(row.value);
        return !value || value.expiresAt <= now;
      })
      .map((row) => row.key);
    if (expired.length) {
      const result = await prisma.appSetting.deleteMany({ where: { key: { in: expired } } });
      deleted += result.count;
    }
    if (rows.length < 500) break;
  }
  return deleted;
}

/** Issue one short-lived request for this exact browser session.
 *
 * The raw random state leaves the server only in the Google authorization URL.
 * The database stores its SHA-256 digest, the signed-in user, and the email the
 * user must prove at Google. Reissuing replaces this session's earlier state.
 */
export async function issueGoogleAccountLinkState(
  session: GoogleAccountLinkSession,
  email: string,
  now = Date.now()
): Promise<{ state: string; expiresAt: Date }> {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = now + GOOGLE_ACCOUNT_LINK_TTL_MS;
  const value: StoredLinkState = {
    version: 1,
    userId: session.userId,
    expectedEmail: normalizedEmail(email),
    stateHash: stateDigest(state),
    expiresAt,
  };

  await pruneExpiredGoogleAccountLinkStates(now, 1);
  await prisma.appSetting.upsert({
    where: { key: stateKey(session.id) },
    create: { key: stateKey(session.id), value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });

  return { state, expiresAt: new Date(expiresAt) };
}

/** Atomically consume an account-link request.
 *
 * The session id is the database key and the digest must match its current
 * value, so a state copied from another signed-in browser is indistinguishable
 * from random input. deleteMany's count is the single-use arbiter when two
 * callbacks race.
 */
export async function consumeGoogleAccountLinkState(
  session: GoogleAccountLinkSession,
  state: string,
  now = Date.now()
): Promise<ConsumedGoogleAccountLinkState> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    return { ok: false, reason: "invalid" };
  }
  const key = stateKey(session.id);
  return prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) return { ok: false, reason: "invalid" } as const;

    const stored = parseStoredState(row.value);
    if (
      !stored ||
      stored.userId !== session.userId ||
      stored.stateHash !== stateDigest(state)
    ) {
      return { ok: false, reason: "invalid" } as const;
    }

    const removed = await tx.appSetting.deleteMany({
      where: { key, value: row.value },
    });
    if (removed.count !== 1) return { ok: false, reason: "invalid" } as const;

    if (stored.expiresAt <= now) {
      return { ok: false, reason: "expired" } as const;
    }
    return { ok: true, expectedEmail: stored.expectedEmail } as const;
  });
}

function uniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Explicitly add Google as another sign-in method to the current account.
 *
 * This never resolves a target by email. The already-authenticated user id is
 * the only update target, while exact email equality is a deliberate safety
 * policy that prevents confusing or unusable links. Only googleId changes, so
 * password and WebAuthn access remain intact.
 */
export async function linkGoogleIdentityToUser(
  userId: string,
  identity: VerifiedGoogleIdentity
): Promise<GoogleAccountLinkResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const [user, subjectUsers] = await Promise.all([
        tx.user.findUnique({ where: { id: userId } }),
        tx.user.findMany({ where: { googleId: identity.id }, select: { id: true }, take: 2 }),
      ]);
      if (!user) return { ok: false, reason: "account-missing" } as const;

      if (subjectUsers.length > 1 || subjectUsers.some((subject) => subject.id !== user.id)) {
        return { ok: false, reason: "subject-conflict" } as const;
      }
      if (user.googleId && user.googleId !== identity.id) {
        return { ok: false, reason: "account-conflict" } as const;
      }
      if (normalizedEmail(user.email) !== normalizedEmail(identity.email)) {
        return { ok: false, reason: "email-mismatch" } as const;
      }
      if (user.googleId === identity.id) {
        return { ok: true, alreadyLinked: true } as const;
      }

      const updated = await tx.user.updateMany({
        where: { id: user.id, googleId: null },
        data: { googleId: identity.id },
      });
      return updated.count === 1
        ? ({ ok: true, alreadyLinked: false } as const)
        : ({ ok: false, reason: "account-conflict" } as const);
    });
  } catch (error) {
    // The database's unique googleId index is the final arbiter if two accounts
    // race for one Google subject. Do not expose which account won.
    if (uniqueConstraintError(error)) {
      return { ok: false, reason: "subject-conflict" };
    }
    throw error;
  }
}
