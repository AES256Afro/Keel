import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getInstanceClaimStatus,
  INSTANCE_OWNER_KEY,
  ownerUserIdOverrideConfigured,
  ownerBootstrapTokenAvailable,
} from "@/lib/instance";
import { keelEnv } from "@/lib/env";

export const INSTANCE_CLAIM_TOKEN_TTL_MS = 5 * 60 * 1000;
export const INSTANCE_CLAIM_TOKEN_PREFIX = "keel_claim_";

export class InstanceClaimError extends Error {}

function bootstrapTokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Claim a hosted/PostgreSQL instance using a high-entropy secret held in the
 * platform environment. The secret is compared as fixed-size digests, never
 * stored, returned, audited, or logged. */
export async function claimInstanceWithBootstrapToken(
  user: { id: string; email: string; username?: string | null },
  suppliedToken: string
): Promise<{ status: "claimed" | "already-claimed" }> {
  if (ownerUserIdOverrideConfigured()) {
    throw new InstanceClaimError(
      "This server uses KEEL_OWNER_USER_ID and cannot be claimed from the browser."
    );
  }
  const expected = keelEnv("OWNER_BOOTSTRAP_TOKEN")?.trim() ?? "";
  const configured = ownerBootstrapTokenAvailable();
  const supplied = String(suppliedToken ?? "").trim();
  // Take the same digest/compare path when the host has no usable token. The
  // strict request budget then prevents the endpoint from becoming a useful
  // configured-state timing oracle, while still keeping comparisons fixed-size.
  const matches = timingSafeEqual(
    bootstrapTokenDigest(configured ? expected : "0".repeat(64)),
    bootstrapTokenDigest(supplied)
  );
  if (!configured || !matches) {
    throw new InstanceClaimError(
      "The hosted owner bootstrap token is invalid or unavailable."
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.appSetting.findUnique({
        where: { key: INSTANCE_OWNER_KEY },
        select: { value: true },
      });
      if (current) {
        if (current.value === user.id) return { status: "already-claimed" } as const;
        throw new InstanceClaimError(
          "This server is already claimed by a different account; claims cannot be replaced."
        );
      }
      await tx.appSetting.create({
        data: { key: INSTANCE_OWNER_KEY, value: user.id },
      });
      await tx.instanceClaimToken.deleteMany({});
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          actor: user.username ?? user.email,
          action: "instance.claim",
          target: user.email,
          detail: JSON.stringify({ confirmation: "host-bootstrap" }),
          ip: null,
        },
      });
      return { status: "claimed" } as const;
    });
  } catch (error) {
    if (error instanceof InstanceClaimError) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2002"
    ) {
      const current = await prisma.appSetting.findUnique({
        where: { key: INSTANCE_OWNER_KEY },
        select: { value: true },
      });
      if (current?.value === user.id) return { status: "already-claimed" };
      if (current) {
        throw new InstanceClaimError(
          "This server was claimed by a different account; claims cannot be replaced."
        );
      }
    }
    throw error;
  }
}

export function hashInstanceClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newPlaintextToken(): string {
  return INSTANCE_CLAIM_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Mint a one-use claim token bound to the signed-in account.
 *
 * The plaintext exists only in this return value. The database gets its hash.
 * A transaction keeps the "still unclaimed" check and per-user replacement
 * together. The claim command performs the inverse operation atomically when
 * it consumes the token after OS authorization.
 */
export async function issueInstanceClaimToken(
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const status = await getInstanceClaimStatus();
  if (status.claimed) throw new InstanceClaimError("This Keel server is already claimed.");

  // A SHA-256 collision is not realistic, but the unique database index is the
  // final arbiter and retrying keeps even that path friendly.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newPlaintextToken();
    const tokenHash = hashInstanceClaimToken(token);
    const expiresAt = new Date(Date.now() + INSTANCE_CLAIM_TOKEN_TTL_MS);
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.appSetting.findUnique({
          where: { key: INSTANCE_OWNER_KEY },
          select: { value: true },
        });
        if (claimed) throw new InstanceClaimError("This Keel server was claimed while the token was being created.");

        await tx.instanceClaimToken.deleteMany({ where: { expiresAt: { lte: new Date() } } });
        await tx.instanceClaimToken.upsert({
          where: { userId },
          create: { userId, tokenHash, expiresAt },
          update: { tokenHash, expiresAt, createdAt: new Date() },
        });
      });
      return { token, expiresAt };
    } catch (error) {
      if (error instanceof InstanceClaimError) throw error;
      const code = (error as Prisma.PrismaClientKnownRequestError)?.code;
      if (code !== "P2002" || attempt === 2) throw error;
    }
  }
  throw new InstanceClaimError("Could not create a claim token.");
}
