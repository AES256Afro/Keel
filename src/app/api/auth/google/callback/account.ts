import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

export type GoogleAccountResolution = { user: User | null; conflict?: string };

function isUniqueConstraintError(err: unknown) {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/** Resolve the stable Google subject and the current email together. Email can
 * change over time, so a disagreement must fail closed instead of silently
 * signing one Google identity into another account. */
export async function resolveGoogleAccount(
  googleId: string,
  email: string
): Promise<GoogleAccountResolution> {
  // Do not rely only on the schema's unique declaration here. If an upgrade
  // discovers legacy duplicate links, SQLite self-migration deliberately
  // leaves those rows untouched and reports the blocked constraint. Query two
  // rows so authentication still fails closed while the owner repairs them.
  const [subjectUsers, emailUser] = await Promise.all([
    prisma.user.findMany({ where: { googleId }, take: 2 }),
    prisma.user.findUnique({ where: { email } }),
  ]);
  if (subjectUsers.length > 1) {
    return { user: null, conflict: "Google identity is linked to multiple accounts" };
  }
  const subjectUser = subjectUsers[0] ?? null;
  if (subjectUser && emailUser && subjectUser.id !== emailUser.id) {
    return { user: null, conflict: "Google identity and email resolve to different accounts" };
  }

  // Password registration does not verify mailbox ownership. Linking a Google
  // identity to an unlinked row solely because its email matches would let an
  // attacker pre-register a victim's address and retain password access after
  // the victim signs in with Google. Linking must happen only from a future
  // authenticated account-settings flow that proves control of both accounts.
  if (!subjectUser && emailUser && !emailUser.googleId) {
    return { user: null, conflict: "Existing password account must be signed in before linking Google" };
  }

  const user = subjectUser ?? emailUser;
  if (user?.googleId && user.googleId !== googleId) {
    return { user: null, conflict: "Email is already linked to a different Google identity" };
  }
  return { user };
}

/** Link a password-only account without overwriting a concurrent link.
 *
 * The update is a compare-and-set on googleId = null. The unique index is the
 * final arbiter when two different accounts race to claim one Google subject;
 * after either a lost compare-and-set or P2002, resolve both subject and email
 * again and continue only when they still identify the same account. */
export async function linkGoogleAccount(
  user: User,
  googleId: string,
  email: string
): Promise<GoogleAccountResolution> {
  if (user.googleId) {
    return user.googleId === googleId
      ? { user }
      : { user: null, conflict: "Email is already linked to a different Google identity" };
  }

  try {
    const linked = await prisma.user.updateMany({
      where: { id: user.id, googleId: null },
      data: { googleId },
    });
    if (linked.count === 1) return { user: { ...user, googleId } };
  } catch (err) {
    // A concurrent callback may have claimed this subject for another account.
    // P2002 is expected in that race; every other database error remains loud.
    if (!isUniqueConstraintError(err)) throw err;
  }

  const resolution = await resolveGoogleAccount(googleId, email);
  if (resolution.conflict) return resolution;
  return resolution.user
    ? resolution
    : { user: null, conflict: "Account disappeared while linking Google" };
}
