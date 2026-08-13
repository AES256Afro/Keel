// Session handoff for the desktop app's Google sign-in.
//
// Google refuses OAuth inside embedded app windows ("this browser or app may
// not be secure"), so the desktop shell runs sign-in in the real system
// browser instead. That browser has its own cookie jar, so the resulting
// session can't simply be shared with the app window. Instead the callback
// parks the freshly minted session token here under a high-entropy id the app
// generated, and the app window redeems it (see /api/auth/desktop-claim) so
// the cookie lands in the app's own jar.
//
// In-memory is sufficient: the packaged app runs a single Node server process,
// and entries are short-lived and single-use.

type Entry = { token: string; expiresAt: Date; parkedAt: number };

const TTL_MS = 2 * 60 * 1000;

const g = globalThis as unknown as { __keelHandoffs?: Map<string, Entry> };
const store = (g.__keelHandoffs ??= new Map<string, Entry>());

function sweep() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.parkedAt > TTL_MS) store.delete(id);
  }
}

/** Park a session token for the app window to redeem. */
export function parkHandoff(id: string, token: string, expiresAt: Date) {
  sweep();
  store.set(id, { token, expiresAt, parkedAt: Date.now() });
}

/** Whether a handoff is ready to be claimed (does not consume it). */
export function handoffReady(id: string) {
  sweep();
  return store.has(id);
}

/** Redeem a handoff exactly once. */
export function takeHandoff(id: string): Entry | null {
  sweep();
  const entry = store.get(id);
  if (!entry) return null;
  store.delete(id);
  return entry;
}
