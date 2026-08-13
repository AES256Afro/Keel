// Rate limiting and auth throttling.
//
// ============================================================================
// THE FIVE INVARIANTS - read this before changing anything in this file.
// ============================================================================
//
// Sign-in throttling has to hold five properties AT ONCE. They pull against
// each other, and satisfying any one of them naively breaks another. Four
// consecutive review rounds each "fixed" this code by pinning one property and
// silently trading away a different one, so they are written down here, and
// scripts/auth-invariants-check.mjs asserts them TOGETHER rather than one at a time.
//
//   I1. Don't trust a forgeable identity.
//       X-Forwarded-For is client-supplied. Only honour it when an operator
//       confirms a proxy sets it (KEEL_TRUST_PROXY), and then read the entry
//       the proxy appended (from the RIGHT), not the one the client sent.
//       Violated by: reading parts[0]. Cost: every per-IP limit bypassable.
//
//   I2. A stranger must never be able to deny service to a real user.
//       No shared bucket with a durable block. When callers cannot be told
//       apart, a per-IP budget is not a limit - it is one global kill switch.
//       Violated by: keying every request to one bucket with blockedUntil.
//       Cost: 20 bad logins locked out every user for 15 minutes.
//
//   I3. Expensive unauthenticated work must be bounded.
//       bcrypt is ~250ms of single-threaded CPU and anonymous callers reach it.
//       Violated by: dropping the limit entirely to satisfy I2.
//       Cost: a few requests/second starve the event loop; the server stops
//       answering at all. Held by the concurrency gate below (shed, don't queue,
//       don't block) - which satisfies I2 and I3 simultaneously, the thing
//       neither a bucket nor no-limit could do.
//
//   I4. Responses must not reveal which accounts exist.
//       Every address gets the same messages on the same schedule: the dummy
//       bcrypt compare in login(), one shared error string, and failure records
//       written for EVERY address, real or not.
//       Violated by: skipping records for unknown accounts to satisfy I5.
//       Cost: the 6th attempt answered differently for a real address.
//
//   I5. An anonymous caller must not be able to grow the database WITHOUT
//       BOUND - but this invariant is subordinate to I2 and to per-account
//       isolation, and two attempts to strengthen it broke something worse:
//       refusing rows at a cap disabled the lockout for accounts without one,
//       and a shared hashed bucket allowed both a lockout BYPASS (a colliding
//       sign-in clears your counter) and mass lockout of accounts whose
//       addresses the attacker never knew.
//       So: per-address keys, capped key length, and growth bounded by
//       expiry + the hourly sweep. Junk rows that expire are a housekeeping
//       problem; a bypass of the only per-account sign-in defence is not.
//       The lesson worth keeping: storage pressure must never be relieved by
//       making accounts share security state.
//
// If you change this file, run `npm run test:auth-invariants` - it exists to catch
// exactly the trade you are about to make.
//
// ----------------------------------------------------------------------------
// Structure: a sliding-window counter in memory for per-endpoint budgets (cheap,
// correct for the single Node process Keel runs as), and a database-backed
// per-account failed-login counter so a restart cannot clear a lockout and an
// attacker cannot reset it by crashing the process. Multi-process deployments
// would need the first layer moved to the database too; Keel is deliberately
// single-process (see src/lib/pending-2fa.ts).

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { keelEnv, keelFlag } from "@/lib/env";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the caller may retry. Only meaningful when !ok. */
  retryAfter: number;
  remaining: number;
}

interface Window {
  hits: number[];
  /** Set when a lockout is active; ms epoch. */
  blockedUntil?: number;
}

const g = globalThis as unknown as { __keelRateBuckets?: Map<string, Window> };
const buckets = (g.__keelRateBuckets ??= new Map<string, Window>());

let lastSweep = 0;
function sweep(now: number) {
  // Amortised cleanup - at most once a minute, regardless of traffic.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, w] of buckets) {
    const stale = w.hits.length === 0 || now - w.hits[w.hits.length - 1] > 3_600_000;
    if (stale && (!w.blockedUntil || w.blockedUntil < now)) buckets.delete(key);
  }
}

/**
 * Sliding-window limiter. Returns whether this hit is allowed and records it.
 *
 * @param key      identifies the caller + endpoint, e.g. `login:1.2.3.4`
 * @param limit    permitted hits per window
 * @param windowMs window length
 * @param blockMs  how long to lock out after exceeding (defaults to windowMs)
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  blockMs = windowMs
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const w = buckets.get(key) ?? { hits: [] };
  buckets.set(key, w);

  if (w.blockedUntil && w.blockedUntil > now) {
    return { ok: false, retryAfter: Math.ceil((w.blockedUntil - now) / 1000), remaining: 0 };
  }
  w.blockedUntil = undefined;

  const cutoff = now - windowMs;
  // Hits are appended in order, so dropping the expired prefix is enough.
  let i = 0;
  while (i < w.hits.length && w.hits[i] <= cutoff) i++;
  if (i > 0) w.hits.splice(0, i);

  if (w.hits.length >= limit) {
    w.blockedUntil = now + blockMs;
    return { ok: false, retryAfter: Math.ceil(blockMs / 1000), remaining: 0 };
  }

  w.hits.push(now);
  return { ok: true, retryAfter: 0, remaining: limit - w.hits.length };
}

/** Forget a key - call after a success so a legitimate user isn't punished. */
export function rateLimitReset(key: string) {
  buckets.delete(key);
}

/* ---------- Global ceiling on unauthenticated expensive work ---------- */
//
// bcrypt at cost 12 is ~250ms of CPU, and bcryptjs is pure JavaScript - it runs
// on the single Node thread Keel deliberately is. Unauthenticated callers can
// reach it (login, register), so without a ceiling a few requests per second
// starve the event loop and the whole instance stops answering.
//
// Two earlier attempts got this wrong in opposite directions, so the shape here
// is deliberate:
//   • Keying a per-IP bucket on an unidentifiable caller made ONE shared bucket
//     whose blockedUntil locked every user out for 15 minutes. A kill switch.
//   • Skipping the limit entirely removed the only ceiling and traded a bounded
//     lockout for an indefinite CPU-exhaustion outage.
//
// So: a concurrency gate, not a lockout. It bounds how much expensive work is
// in flight at once and sheds the excess immediately, with NO durable block  -
// the moment a flood stops, the next caller succeeds. A legitimate user racing
// an attacker may be asked to retry, which is recoverable; being locked out for
// fifteen minutes, or having the server stop responding, is not.

const MAX_CONCURRENT_AUTH_WORK = 4;
let authWorkInFlight = 0;

export class ServerBusyError extends Error {
  constructor() {
    super("The server is busy verifying sign-ins. Please try again in a moment.");
  }
}

/**
 * Run expensive unauthenticated auth work (bcrypt) under a global concurrency
 * cap. Throws ServerBusyError instead of queueing, so load is shed rather than
 * accumulated - a queue would just move the starvation instead of bounding it.
 */
export async function withAuthWorkSlot<T>(work: () => Promise<T>): Promise<T> {
  if (authWorkInFlight >= MAX_CONCURRENT_AUTH_WORK) throw new ServerBusyError();
  authWorkInFlight++;
  try {
    return await work();
  } finally {
    authWorkInFlight--;
  }
}

/**
 * The caller's IP.
 *
 * Behind Caddy (docker-compose.prod.yml) or Tailscale Serve, the socket address
 * is the proxy, so X-Forwarded-For is the only signal available - but it is
 * client-controlled, so it is only trusted when the operator says a proxy is in
 * front. Otherwise every request shares one bucket, which throttles more
 * aggressively rather than less: the safe direction to fail.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  // Trust X-Forwarded-For ONLY when an operator explicitly says a proxy is in
  // front (KEEL_TRUST_PROXY=1). Keying off NODE_ENV=production was wrong: a
  // packaged/`docker compose` instance exposed directly on a public port is
  // production but has NO proxy appending the real peer IP, so the header is
  // fully attacker-controlled - reading any entry (even the right-most) hands
  // the attacker a spoofable per-request IP that defeats every per-IP limit and
  // forges the audit source. Unset, we fall through to the single "local"
  // bucket, which over-throttles rather than under: the safe direction. The
  // proxied deployment configs (Caddy, Cloudflare Tunnel, a home server) set the flag.
  const trustProxy = keelFlag("TRUST_PROXY");
  if (trustProxy) {
    const xff = h.get("x-forwarded-for");
    if (xff) {
      // Read from the RIGHT, not the left. A client can send any
      // X-Forwarded-For it likes; the trusted proxy in front (Caddy, Cloudflare
      // Tunnel, Tailscale Serve) APPENDS the real client IP to the right of
      // whatever arrived. So the left-most entry is attacker-controlled - taking
      // it let anyone spoof a fresh IP per request and slip every per-IP rate
      // limit, and forge the audit log's source IP. The real client sits
      // `hops` entries from the right, where `hops` is how many trusted proxies
      // are chained in front (1 for a single Caddy/Tunnel; set
      // KEEL_TRUSTED_PROXY_HOPS=2 for Cloudflare → Caddy, etc.).
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) {
        const hops = Math.max(1, Number(keelEnv("TRUSTED_PROXY_HOPS") ?? "1") || 1);
        const ip = parts[Math.max(0, parts.length - hops)];
        if (ip) return ip;
      }
    }
    // x-real-ip is set (overwritten, not appended) by the proxy, so it is
    // trustworthy when present - used as a fallback for proxies that send it.
    const real = h.get("x-real-ip");
    if (real) return real.trim();
  }
  // No trustworthy source of the caller's address. Next 16 does not expose the
  // socket peer address to route handlers, and inventing one from a spoofable
  // header is exactly the bug above. See UNIDENTIFIED_IP for what callers do
  // with this - critically, they must NOT treat it as one client.
  return UNIDENTIFIED_IP;
}

/**
 * Sentinel for "the caller's address is unknowable here".
 *
 * Every request on an unproxied instance maps to this one value, so a per-IP
 * budget keyed on it is not a per-client limit at all - it is a single global
 * bucket. Enforcing it would hand any unauthenticated visitor a trivial
 * denial-of-service: 20 failed logins would lock *everyone* out for 15 minutes,
 * including someone typing the correct password, because the IP check runs
 * before any credential logic. So IP-keyed limits SKIP this value (see
 * limitByIp) and the defences that are actually per-actor carry the weight:
 * the database-backed per-email login lockout, and per-user limits elsewhere.
 */
export const UNIDENTIFIED_IP = "unidentified";

/**
 * Limit by IP for a named action.
 *
 * When the address is unknowable (no trusted proxy - see UNIDENTIFIED_IP) the
 * limit is SKIPPED rather than applied to a bucket every visitor shares. A
 * shared bucket looks like a rate limit but behaves like a global kill switch:
 * one unauthenticated attacker spending the budget locks out every real user.
 * Skipping loses per-IP throttling on that deployment shape - which is why the
 * setup guide pushes operators to put a proxy in front and set
 * KEEL_TRUST_PROXY - but per-account protections (the database-backed login
 * lockout) still apply, and availability is not handed to a stranger.
 */
export async function limitByIp(
  action: string,
  limit: number,
  windowMs: number,
  blockMs?: number
): Promise<RateLimitResult> {
  const ip = await clientIp();
  if (ip === UNIDENTIFIED_IP) {
    return { ok: true, retryAfter: 0, remaining: limit };
  }
  return rateLimit(`${action}:${ip}`, limit, windowMs, blockMs);
}

/* ---------- Instance-wide registration ceiling ---------- */
//
// register() permanently grows the database (User + Workspace + member row +
// starter page - nothing expires or is swept), and its only per-caller
// throttle is limitByIp, which is a deliberate no-op when the address is
// unknowable. On an unproxied open-signup instance that left signup the one
// anonymous write with no bound at all - the I5 hole.
//
// The key is FIXED - derived from nothing the caller sends - so this IS a
// shared bucket, the shape I2 forbids for sign-in. The difference that makes
// it safe here: a full bucket denies a stranger a NEW account, not any real
// user their existing one. Sign-in never consults this bucket, so locking
// REGISTRATION instance-wide for up to an hour is acceptable collateral where
// a sign-in lockout was not. Callers must keep the allowlist/duplicate-email
// refusals ahead of this check, so on a locked-down instance strangers are
// refused without ever spending the budget.
//
// 20/hour is far beyond any human rate for a self-hosted instance while
// capping a scripted flood at ~480 permanent accounts a day.
const MAX_REGISTRATIONS_PER_HOUR = 20;

export function limitRegistration(): RateLimitResult {
  return rateLimit("register:instance", MAX_REGISTRATIONS_PER_HOUR, 60 * 60_000);
}

/* ---------- Persistent failed-login tracking ---------- */
//
// Counted per email so a distributed guessing attack against one account is
// still throttled, and stored in AppSetting so it survives a restart. Kept
// deliberately small: a JSON blob per email, swept when it expires.

// The email becomes an AppSetting PRIMARY KEY, and an unauthenticated caller
// supplies it. Cap the length so a flood of megabyte-long "emails" cannot be
// written into the database as unbounded keys, and normalise so the same
// address never splits across rows.
/**
 * Counters are keyed per address, NOT by a shared bucket.
 *
 * A 1024-way hashed bucket was tried to bound storage by construction. It made
 * things worse in two ways a shared key makes unavoidable, because a bucket is
 * shared state between accounts that must not affect each other:
 *   • clearLoginFailures deletes the row, so a successful sign-in to ANY
 *     colliding address wiped the victim's counter - an attacker who registers
 *     one address colliding with yours (cheap: the hash is public and
 *     unseeded) can reset your lockout forever and guess passwords without
 *     limit. A lockout bypass.
 *   • It created a capability nobody had: locking accounts WITHOUT knowing
 *     their address. ~5,000 anonymous requests cover all 1024 buckets and lock
 *     every account on the instance, including a private instance's only
 *     owner. That is exactly the shape I2 forbids.
 *
 * Per-address keys keep accounts isolated: your failures are yours, and
 * clearing them clears only yours. Storage is bounded the honest way - records
 * expire after FAILURE_WINDOW_MS and pruneLoginFailures sweeps them hourly  -
 * which is a housekeeping concern with a known ceiling, not a security control
 * an attacker can aim at. That trade is the right way round: a bounded amount
 * of junk in one table beats a bypass of the only per-account sign-in defence.
 */
const MAX_EMAIL_KEY = 254; // RFC 5321 maximum address length
const FAILED_KEY = (email: string) =>
  `auth.failed:${email.toLowerCase().slice(0, MAX_EMAIL_KEY)}`;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** 1st lockout 1 min, then 2, 4, 8 … capped at an hour. */
const lockoutMs = (strikes: number) =>
  Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, strikes - MAX_FAILURES));

interface FailureRecord {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

async function readFailures(email: string): Promise<FailureRecord | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: FAILED_KEY(email) } });
    return row ? (JSON.parse(row.value) as FailureRecord) : null;
  } catch {
    return null; // never let bookkeeping break sign-in
  }
}

async function writeFailures(email: string, rec: FailureRecord | null) {
  const key = FAILED_KEY(email);
  try {
    if (!rec) {
      await prisma.appSetting.deleteMany({ where: { key } });
      return;
    }
    const value = JSON.stringify(rec);
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch {
    /* ignore */
  }
}

/** Seconds remaining on an account lockout, or 0 when sign-in may proceed. */
export async function loginLockout(email: string): Promise<number> {
  const rec = await readFailures(email);
  if (!rec?.lockedUntil) return 0;
  const remaining = rec.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Failures are recorded for EVERY address, real or not (I4): the response
 * schedule must not differ between an address that exists and one that does
 * not. Keys are per-address (truncated to MAX_EMAIL_KEY), so storage grows
 * with the number of distinct addresses attempted inside FAILURE_WINDOW_MS and
 * is reclaimed by expiry - the hourly pruneLoginFailures sweep deletes rows
 * whose window and lockout have passed. That growth is the deliberate trade
 * documented above (the fixed bucket keyspace was removed because shared
 * buckets broke account isolation): no cap is enforced here, and no path may
 * refuse to record.
 */
export async function recordLoginFailure(email: string): Promise<void> {
  const now = Date.now();
  const rec = await readFailures(email);
  // Outside the window, start counting again.
  const fresh = !rec || now - rec.firstAt > FAILURE_WINDOW_MS;
  const next: FailureRecord = fresh
    ? { count: 1, firstAt: now }
    : { count: rec.count + 1, firstAt: rec.firstAt };
  if (next.count >= MAX_FAILURES) next.lockedUntil = now + lockoutMs(next.count);
  await writeFailures(email, next);
}

export async function clearLoginFailures(email: string): Promise<void> {
  await writeFailures(email, null);
}

/** Drop expired lockout rows. Called from the server-init maintenance tick. */
export async function pruneLoginFailures(): Promise<number> {
  try {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "auth.failed:" } } });
    const now = Date.now();
    const dead = rows.filter((r) => {
      try {
        const rec = JSON.parse(r.value) as FailureRecord;
        return (!rec.lockedUntil || rec.lockedUntil < now) && now - rec.firstAt > FAILURE_WINDOW_MS;
      } catch {
        return true;
      }
    });
    if (dead.length === 0) return 0;
    const { count } = await prisma.appSetting.deleteMany({
      where: { key: { in: dead.map((d) => d.key) } },
    });
    return count;
  } catch {
    return 0;
  }
}
