// Intermediate state between the first factor (password / Google) and the
// second factor (security key). After the first factor succeeds we DON'T create
// a full session  -  we park a short-lived pending record and send the browser to
// /2fa to tap its key. Only after that do we mint the real session.
//
// In-memory is fine: a single Node server process, entries are short-lived and
// single-use. The pending token lives in the `keel_2fa` cookie.
import { randomBytes } from "crypto";

export const PENDING_COOKIE = "keel_2fa";
const TTL_MS = 5 * 60 * 1000;

interface Pending {
  userId: string;
  desktopId?: string; // carry the desktop OAuth handoff id across 2FA
  expiresAt: number;
}

const g = globalThis as unknown as { __keelPending2fa?: Map<string, Pending> };
const store = (g.__keelPending2fa ??= new Map<string, Pending>());

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}

export function createPending(userId: string, desktopId?: string): string {
  sweep();
  const token = randomBytes(32).toString("hex");
  store.set(token, { userId, desktopId, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** Peek without consuming (used while generating auth options). */
export function getPending(token: string | undefined): Pending | null {
  if (!token) return null;
  sweep();
  return store.get(token) ?? null;
}

/** Redeem exactly once (on successful key verification). */
export function consumePending(token: string | undefined): Pending | null {
  if (!token) return null;
  sweep();
  const p = store.get(token);
  if (p) store.delete(token);
  return p ?? null;
}
