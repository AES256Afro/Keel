// Instance ownership - deliberately NOT the same thing as workspace ownership.
//
// Every account gets its own workspace and is `owner` of it (see
// src/lib/signup.ts), so a workspace role can never gate instance-wide powers:
// the public-site CMS at /admin, the sign-in allowlist, the Cloudflare tunnel.
// Those belong to the person who runs the server, and to nobody else.
//
// Who that is, in order:
//   1. KEEL_OWNER_USER_ID - a stable operator-managed override.
//   2. The immutable user id written by `keel claim` after the machine
//      operator confirms through the operating system or a strong hosted
//      bootstrap token.
//
// KEEL_OWNER_EMAIL is retained only as a backward-compatible selector for a
// Google-verified account. A password registration does not prove mailbox
// control and therefore never receives instance powers from an email string.
// The first verified match is persisted as instance.ownerUserId; after that,
// changing the email environment variable cannot switch the owner.
//
// Deliberately no in-app way to grant instance ownership. Widening it must
// require access to the server, not to a session.

import { prisma } from "@/lib/prisma";
import { keelEnv, keelFlag } from "@/lib/env";

export const INSTANCE_OWNER_KEY = "instance.ownerUserId";

function ownerUserIdOverride(): { configured: boolean; value: string | null } {
  const raw = keelEnv("OWNER_USER_ID");
  if (raw == null || raw.trim() === "") return { configured: false, value: null };
  const value = raw.trim();
  return {
    configured: true,
    value: /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null,
  };
}

export function configuredOwnerUserId(): string | null {
  return ownerUserIdOverride().value;
}

/** True even for a malformed nonempty override. An operator typo must fail
 * closed rather than silently restoring authority to an older owner source. */
export function ownerUserIdOverrideConfigured(): boolean {
  return ownerUserIdOverride().configured;
}

export function configuredOwnerEmails(): string[] {
  return (keelEnv("OWNER_EMAIL") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

async function claimedOwnerId(): Promise<string | null> {
  const claimed = await prisma.appSetting
    .findUnique({ where: { key: INSTANCE_OWNER_KEY }, select: { value: true } })
    .catch(() => null);
  return claimed?.value ?? null;
}

async function bindLegacyVerifiedOwner(user: {
  id: string;
  email: string;
  googleId?: string | null;
}): Promise<string | null> {
  if (!user.googleId || !configuredOwnerEmails().includes(user.email.toLowerCase())) {
    return null;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.appSetting.findUnique({
        where: { key: INSTANCE_OWNER_KEY },
        select: { value: true },
      });
      if (current) return current.value;
      await tx.appSetting.create({
        data: { key: INSTANCE_OWNER_KEY, value: user.id },
      });
      return user.id;
    });
  } catch (error) {
    // Two matching requests can race on first load. The unique setting key is
    // the arbiter; re-read its immutable winner instead of guessing.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2002"
    ) {
      return claimedOwnerId();
    }
    throw error;
  }
}

async function desktopFirstOwnerId(): Promise<string | null> {
  // The desktop shell is a loopback-only single-user app and has no terminal
  // claim command on PATH. This marker is set only by Electron when it spawns
  // its bundled localhost server. Browser/source/installer deployments never
  // get this compatibility bootstrap and remain explicitly claimed.
  const bind = (process.env.HOSTNAME ?? process.env.HOST ?? "").trim().toLowerCase();
  if (
    !keelFlag("DESKTOP_HANDOFF") ||
    !(
      bind === "localhost" ||
      bind === "::1" ||
      bind === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(bind)
    )
  ) {
    return null;
  }
  const first = await prisma.workspace.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { ownerId: true },
  });
  return first?.ownerId ?? null;
}

export async function isInstanceOwner(user: {
  id: string;
  email: string;
  googleId?: string | null;
}): Promise<boolean> {
  const override = ownerUserIdOverride();
  if (override.configured) return override.value === user.id;

  // The claim stores the stable User.id, not an email address that can change
  // or be recycled. A legacy email can bind only an already Google-verified
  // account and cannot replace a persisted winner.
  const ownerId =
    (await claimedOwnerId()) ??
    (await bindLegacyVerifiedOwner(user)) ??
    (await desktopFirstOwnerId());
  return ownerId === user.id;
}

/** The installer marker is useful explanatory context, but authorization is
 * fail-closed on every unclaimed database whether this variable is set or not. */
export function instanceClaimRequiredByEnvironment(): boolean {
  return keelFlag("CLAIM_REQUIRED");
}

export async function getInstanceClaimStatus(
  user?: { id: string; email: string; googleId?: string | null } | null
): Promise<{
  claimed: boolean;
  required: boolean;
  isOwner: boolean;
}> {
  const override = ownerUserIdOverride();
  const ownerId = override.configured
    ? override.value
    : (await claimedOwnerId()) ??
      (user ? await bindLegacyVerifiedOwner(user) : null) ??
      (await desktopFirstOwnerId());
  // A malformed nonempty override is still an asserted host-side ownership
  // boundary. Treat it as claimed by nobody so browser claim paths stay shut.
  const claimed = override.configured || ownerId != null;
  return {
    claimed,
    required: !claimed,
    isOwner: Boolean(user && ownerId === user.id),
  };
}

/** True when instance ownership is pinned by the environment (shown in Settings). */
export function instanceOwnerIsPinned(): boolean {
  return ownerUserIdOverride().configured;
}

/** A hosted/PostgreSQL deployment can prove operator control with a random
 * environment secret. This internal check never returns the secret or its
 * configured status to a page. */
export function ownerBootstrapTokenAvailable(): boolean {
  const value = keelEnv("OWNER_BOOTSTRAP_TOKEN")?.trim() ?? "";
  return (
    /^[a-fA-F0-9]{64}$/.test(value) ||
    /^[A-Za-z0-9_-]{43,128}$/.test(value)
  );
}
