import { cache } from "react";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { initServerOnce } from "@/lib/server-init";
import { emailAllowed } from "@/lib/access";
import { keelEnv } from "@/lib/env";

export const SESSION_COOKIE = "keel_session";
/** The pre-rename cookie. Read so a live session survives the upgrade. */
export const LEGACY_SESSION_COOKIE = "nopin_session";

/**
 * The session token from either cookie name.
 *
 * Renaming the cookie would sign everyone out on deploy. Reading both means the
 * rename is invisible: the next sign-in writes the new name, and the old one is
 * cleared on sign-out.
 */
export function readSessionToken(store: {
  get: (name: string) => { value: string } | undefined;
}): string | undefined {
  return store.get(SESSION_COOKIE)?.value ?? store.get(LEGACY_SESSION_COOKIE)?.value;
}
const SESSION_DAYS = 30;

/**
 * Cost 12, not 10.
 *
 * OWASP's floor is 10; 12 is the current practical recommendation and roughly
 * quadruples the work an offline cracker has to do per guess. It also costs
 * ~250ms per sign-in on this hardware, which is why the login path is rate
 * limited - otherwise raising this would hand an attacker a cheaper DoS.
 *
 * Existing hashes carry their own cost and keep verifying; they are re-hashed
 * on the next password change.
 */
const BCRYPT_COST = 12;

export async function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

/**
 * A bcrypt hash of a fixed dummy value, at the login cost, used to spend the
 * SAME ~250ms whether or not an account exists - so login latency stops
 * leaking which emails have local password accounts. (bcrypt.compare against a
 * real hash of a known-wrong password always returns false.) Computed once.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "keel-timing-equalizer-not-a-real-password",
  BCRYPT_COST
);

/** Create a session row and return its token, without touching cookies. */
export async function createSessionToken(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

// Sharing the session across subdomains (for example, example.com and
// notes.example.com) makes "My Notes" seamless. Set a parent cookie domain
// only when every sibling hostname is controlled by the same operator.
// Unset locally/on the desktop, so the cookie stays host-only there.
function cookieDomain(): string | undefined {
  return keelEnv("COOKIE_DOMAIN") || undefined;
}

function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
    domain: cookieDomain(),
  };
}

export async function createSession(userId: string) {
  const { token, expiresAt } = await createSessionToken(userId);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

/** Attach a session cookie to a response (used by the desktop handoff claim,
 *  where the cookie must land on the redirect the app window follows). */
export function applySessionCookie<T extends { cookies: { set: (n: string, v: string, o: object) => void } }>(
  res: T,
  token: string,
  expiresAt: Date
): T {
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
  return res;
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = readSessionToken(cookieStore);
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
  }
  // Clear the pre-rename cookie too, or the browser keeps presenting it.
  cookieStore.set(LEGACY_SESSION_COOKIE, "", {
    ...sessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  // Delete with the same domain it was set on, or the browser keeps it.
  cookieStore.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
}

/**
 * Allowlist decisions are cached briefly per user.
 *
 * The allowlist is checked at sign-in, but a session lasts 30 days - so
 * removing someone from KEEL_ALLOWED_EMAILS used to leave them with access
 * for up to a month. Re-checking on every request would mean two extra queries
 * per page; a short cache makes revocation take effect in under a minute
 * without that cost.
 */
const ALLOW_CACHE_MS = 30_000;
const allowCache = (globalThis as unknown as {
  __keelAllowCache?: Map<string, { allowed: boolean; at: number }>;
}).__keelAllowCache ??= new Map();

async function stillAllowed(email: string): Promise<boolean> {
  const key = email.toLowerCase();
  const hit = allowCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ALLOW_CACHE_MS) return hit.allowed;
  const allowed = await emailAllowed(key);
  allowCache.set(key, { allowed, at: now });
  return allowed;
}

/**
 * Resolve the signed-in user.
 *
 * Wrapped in React's cache() below: the workspace layout and the page component
 * both call getCurrentContext() while rendering one request, and API routes on
 * the same navigation add more. Next dedupes fetch(), not Prisma, so without
 * this every navigation paid for the same two queries several times over.
 */
async function loadCurrentUser() {
  // One-time init (schema bootstrap, WAL mode, backup scheduler); instant
  // after the first request.
  await initServerOnce();
  const cookieStore = await cookies();
  const token = readSessionToken(cookieStore);
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    // Expired rows are swept hourly, but drop this one now rather than leave a
    // dead token readable until the sweep runs.
    await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // Access removed since sign-in ends the session rather than merely denying
  // this request - otherwise the token stays live for another 30 days.
  if (!(await stillAllowed(session.user.email))) {
    await prisma.session.deleteMany({ where: { userId: session.userId } }).catch(() => {});
    return null;
  }
  return session.user;
}

export const getCurrentUser = cache(loadCurrentUser);

const WORKSPACE_COOKIE = "keel-workspace";

/**
 * Current user plus their active workspace. Users own one workspace and can
 * be members of others (via sharing); the active one is chosen with the
 * workspace switcher and remembered in a cookie.
 */
async function loadCurrentContext() {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;
  const cookieStore = await cookies();
  const preferred = cookieStore.get(WORKSPACE_COOKIE)?.value;
  const active = memberships.find((m) => m.workspaceId === preferred) ?? memberships[0];
  return {
    user,
    workspace: active.workspace,
    role: active.role,
    memberships: memberships.map((m) => ({
      id: m.workspaceId,
      name: m.workspace.name,
      role: m.role,
    })),
  };
}

export const getCurrentContext = cache(loadCurrentContext);

/** Switch the active workspace (caller must verify membership first). */
export async function setActiveWorkspace(workspaceId: string) {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}
