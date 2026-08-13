"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "@/lib/auth";
import { provisionUser } from "@/lib/signup";
import { emailAllowed, signupAllowed } from "@/lib/access";
import { userHasCredentials } from "@/lib/webauthn";
import { createPending, PENDING_COOKIE } from "@/lib/pending-2fa";
import {
  clearLoginFailures,
  limitByIp,
  limitRegistration,
  loginLockout,
  recordLoginFailure,
  withAuthWorkSlot,
  ServerBusyError,
} from "@/lib/rate-limit";

/** One message for every credential failure - see the account-enumeration note. */
const BAD_CREDENTIALS = "Invalid email or password.";

function waitMessage(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return seconds < 90
    ? `Too many attempts. Try again in ${seconds} seconds.`
    : `Too many attempts. Try again in ${minutes} minutes.`;
}

/** Begin the second-factor step: park a pending record and send to /2fa. */
async function beginSecondFactor(userId: string): Promise<never> {
  const token = createPending(userId);
  (await cookies()).set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 300,
    path: "/",
  });
  redirect("/2fa");
}

export async function register(
  _prev: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  // Registration creates rows and runs bcrypt; cap it per IP when the IP is
  // knowable. The instance-wide ceiling further down holds either way.
  const limit = await limitByIp("register", 5, 60 * 60 * 1000);
  if (!limit.ok) return { error: waitMessage(limit.retryAfter) };

  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(formData.get("password") ?? "");
  if (!name || !email || password.length < 8) {
    return { error: "Name, email and a password of at least 8 characters are required." };
  }
  if (password.length > 512) {
    // bcrypt truncates past 72 bytes anyway; refuse absurd input rather than
    // spending CPU hashing it.
    return { error: "That password is too long." };
  }

  // Check the instance policy BEFORE revealing whether the email is known, so a
  // locked-down instance discloses nothing about who has an account.
  if (!(await signupAllowed(email))) {
    return { error: "New sign-ups are disabled on this instance." };
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { error: "An account with that email already exists." };

  // The per-IP cap above is a no-op when the address is unknowable, so this
  // fixed instance-wide ceiling is the bound that always holds (see
  // limitRegistration). Last of the gates: allowlist and duplicate-email
  // refusals must never spend it.
  const ceiling = limitRegistration();
  if (!ceiling.ok) return { error: waitMessage(ceiling.retryAfter) };

  let passwordHash: string;
  try {
    passwordHash = await withAuthWorkSlot(() => hashPassword(password));
  } catch (err) {
    if (err instanceof ServerBusyError) return { error: err.message };
    throw err;
  }
  let user;
  try {
    // A password proves knowledge of a secret chosen in this request, not
    // control of the claimed mailbox. Never consume email-address invites.
    user = await provisionUser({ name, email, passwordHash, emailVerified: false });
  } catch (err) {
    // The lookup above is deliberately only an early, friendly fast path. The
    // unique email constraint is the real arbiter when two registrations race.
    // Never return the winning user here: a second password request must not
    // receive a session for an account created by the first request.
    const raceWinner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (raceWinner) return { error: "An account with that email already exists." };
    throw err;
  }
  await createSession(user.id);
  redirect("/");
}

export async function login(
  _prev: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(formData.get("password") ?? "");

  // Two independent budgets: one per source address (stops a single host
  // hammering many accounts), one per account (stops a distributed attack on
  // one account). The per-account one is database-backed, so it survives a
  // restart - an attacker can't reset it by crashing the process.
  const ipLimit = await limitByIp("login", 20, 15 * 60 * 1000);
  if (!ipLimit.ok) return { error: waitMessage(ipLimit.retryAfter) };

  if (email) {
    const locked = await loginLockout(email);
    if (locked > 0) return { error: waitMessage(locked) };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Always spend one bcrypt comparison, even when there is no account or it is
  // Google-only. Otherwise the fast (no-bcrypt) path leaks - by response
  // latency alone - which emails have local password accounts, defeating the
  // deliberately-identical error message below. The dummy compare always fails.
  // Under a global concurrency gate: bcrypt is ~250ms of single-threaded CPU
  // and this path is unauthenticated, so without a ceiling a few requests per
  // second starve the event loop and the whole instance stops answering.
  let ok: boolean;
  try {
    ok = await withAuthWorkSlot(() =>
      verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
    );
  } catch (err) {
    if (err instanceof ServerBusyError) return { error: err.message };
    throw err;
  }
  if (!user || !user.passwordHash || !ok) {
    if (email) await recordLoginFailure(email);
    // Deliberately identical for "no such account", "wrong password" and
    // "this is a Google-only account": distinguishing them lets anyone
    // enumerate who has an account here.
    return { error: BAD_CREDENTIALS };
  }
  if (!(await emailAllowed(email))) {
    await recordLoginFailure(email);
    return { error: "This account isn't permitted to sign in on this private instance." };
  }

  await clearLoginFailures(email);
  if (await userHasCredentials(user.id)) await beginSecondFactor(user.id);
  await createSession(user.id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
