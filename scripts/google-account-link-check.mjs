#!/usr/bin/env node
// Security invariants for explicitly adding Google to an existing account.
// Core state/linking checks run directly against a scratch database. Source
// assertions cover the thin Next routes so a future refactor cannot quietly
// turn this into a sign-in callback that replaces the active session.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  cleanDatabase,
  prepareDatabase,
  testDatabaseUrl,
  testPrisma,
} from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "google-account-link-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

cleanDatabase(root, DB_NAME);
prepareDatabase(root, DB_URL);
process.env.DATABASE_URL = DB_URL;
register("./ts-loader.mjs", import.meta.url);

const linkModule = await import(
  pathToFileURL(path.join(root, "src/lib/google-account-link.ts")).href
);
const {
  GOOGLE_ACCOUNT_LINK_TTL_MS,
  consumeGoogleAccountLinkState,
  issueGoogleAccountLinkState,
  linkGoogleIdentityToUser,
  pruneExpiredGoogleAccountLinkStates,
} = linkModule;
const prisma = await testPrisma(root, DB_URL);

async function makeUser(email, opts = {}) {
  const user = await prisma.user.create({
    data: {
      email,
      name: email.split("@")[0],
      username: `${email.split("@")[0]}-${Math.random().toString(16).slice(2, 8)}`,
      passwordHash: opts.passwordHash ?? "password-hash-kept",
      googleId: opts.googleId ?? null,
    },
  });
  const session = await prisma.session.create({
    data: {
      token: `session-${Math.random().toString(16).slice(2)}-${Date.now()}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { user, session };
}

try {
  console.log("\nSession-bound one-time state\n");
  const account = await makeUser("owner@example.test");
  const secondSession = await prisma.session.create({
    data: {
      token: "owner-other-browser-session",
      userId: account.user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const startAt = Date.now();
  const issued = await issueGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    account.user.email,
    startAt
  );
  check(
    "link state expires after exactly five minutes",
    GOOGLE_ACCOUNT_LINK_TTL_MS === 5 * 60 * 1000 &&
      issued.expiresAt.getTime() === startAt + GOOGLE_ACCOUNT_LINK_TTL_MS
  );
  const stateRows = await prisma.appSetting.findMany({
    where: { key: { startsWith: "oauth.account-link.google." } },
  });
  check(
    "the database never stores raw OAuth state",
    stateRows.length === 1 && !JSON.stringify(stateRows).includes(issued.state)
  );

  const wrongSession = await consumeGoogleAccountLinkState(
    { id: secondSession.id, userId: account.user.id },
    issued.state,
    startAt + 1
  );
  check("state is bound to the initiating browser session", !wrongSession.ok);
  const wrongState = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    "A".repeat(43),
    startAt + 2
  );
  check("a state mismatch is rejected", !wrongState.ok);
  const consumed = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    issued.state,
    startAt + 3
  );
  check(
    "the correct state returns only the expected account email",
    consumed.ok && consumed.expectedEmail === account.user.email
  );
  const replay = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    issued.state,
    startAt + 4
  );
  check("a consumed state cannot be replayed", !replay.ok && replay.reason === "invalid");

  const concurrentStarts = await Promise.all([
    issueGoogleAccountLinkState(
      { id: account.session.id, userId: account.user.id },
      account.user.email,
      startAt + 10
    ),
    issueGoogleAccountLinkState(
      { id: account.session.id, userId: account.user.id },
      account.user.email,
      startAt + 11
    ),
  ]);
  const concurrentRows = await prisma.appSetting.findMany({
    where: { key: { startsWith: `oauth.account-link.google.${account.session.id}` } },
  });
  const concurrentResults = await Promise.all(
    concurrentStarts.map((item) =>
      consumeGoogleAccountLinkState(
        { id: account.session.id, userId: account.user.id },
        item.state,
        startAt + 12
      )
    )
  );
  check("concurrent starts leave one deterministic state row", concurrentRows.length === 1);
  check(
    "only one concurrently-issued state can be consumed",
    concurrentResults.filter((result) => result.ok).length === 1
  );

  const expiring = await issueGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    account.user.email,
    startAt
  );
  const expired = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    expiring.state,
    startAt + GOOGLE_ACCOUNT_LINK_TTL_MS
  );
  check("an expired state is rejected and consumed", !expired.ok && expired.reason === "expired");
  const expiredReplay = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    expiring.state,
    startAt + GOOGLE_ACCOUNT_LINK_TTL_MS + 1
  );
  check("an expired state cannot be retried", !expiredReplay.ok);

  const abandoned = await issueGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    account.user.email,
    startAt
  );
  const swept = await pruneExpiredGoogleAccountLinkStates(
    startAt + GOOGLE_ACCOUNT_LINK_TTL_MS,
    20
  );
  check("maintenance deterministically removes abandoned expired state", swept === 1);
  const afterSweep = await consumeGoogleAccountLinkState(
    { id: account.session.id, userId: account.user.id },
    abandoned.state,
    startAt + GOOGLE_ACCOUNT_LINK_TTL_MS + 1
  );
  check("maintenance-pruned state cannot be consumed", !afterSweep.ok);

  const bulkRows = Array.from({ length: 520 }, (_, index) => ({
    key: `oauth.account-link.google.bulk-${String(index).padStart(4, "0")}`,
    value: JSON.stringify({
      version: 1,
      userId: account.user.id,
      expectedEmail: account.user.email,
      stateHash: "a".repeat(64),
      // Interleave live and expired values across the 500-row page boundary.
      expiresAt:
        index % 2 === 0
          ? startAt - 1
          : startAt + GOOGLE_ACCOUNT_LINK_TTL_MS,
    }),
  }));
  await prisma.appSetting.createMany({ data: bulkRows });
  const bulkSwept = await pruneExpiredGoogleAccountLinkStates(startAt, 20);
  const bulkRemaining = await prisma.appSetting.findMany({
    where: { key: { startsWith: "oauth.account-link.google.bulk-" } },
    select: { value: true },
  });
  check(
    "maintenance scans beyond 500 rows even when live and expired states are interleaved",
    bulkSwept === 260 &&
      bulkRemaining.length === 260 &&
      bulkRemaining.every((row) => JSON.parse(row.value).expiresAt > startAt)
  );
  await prisma.appSetting.deleteMany({
    where: { key: { startsWith: "oauth.account-link.google.bulk-" } },
  });

  console.log("\nExplicit link preserves existing access\n");
  const credential = await prisma.credential.create({
    data: {
      userId: account.user.id,
      credentialId: "existing-passkey-id",
      publicKey: "existing-passkey-public-key",
      counter: 7,
      name: "Existing key",
    },
  });
  const sessionsBefore = await prisma.session.findMany({
    where: { userId: account.user.id },
    orderBy: { id: "asc" },
    select: { id: true, token: true, expiresAt: true },
  });
  const linked = await linkGoogleIdentityToUser(account.user.id, {
    id: "google-owner-subject",
    email: account.user.email,
    name: "Owner",
  });
  const userAfter = await prisma.user.findUnique({ where: { id: account.user.id } });
  const sessionsAfter = await prisma.session.findMany({
    where: { userId: account.user.id },
    orderBy: { id: "asc" },
    select: { id: true, token: true, expiresAt: true },
  });
  check("a verified matching identity links successfully", linked.ok && !linked.alreadyLinked);
  check("only googleId is added to the account", userAfter?.googleId === "google-owner-subject");
  check("password access is preserved", userAfter?.passwordHash === "password-hash-kept");
  check(
    "WebAuthn access is preserved",
    Boolean(await prisma.credential.findUnique({ where: { id: credential.id } }))
  );
  check(
    "the active session is neither replaced nor duplicated",
    JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore)
  );
  const idempotent = await linkGoogleIdentityToUser(account.user.id, {
    id: "google-owner-subject",
    email: account.user.email,
  });
  check("reconfirming the same link is idempotent", idempotent.ok && idempotent.alreadyLinked);

  console.log("\nIdentity conflicts and email policy\n");
  const mismatch = await makeUser("mismatch@example.test");
  const mismatchResult = await linkGoogleIdentityToUser(mismatch.user.id, {
    id: "google-mismatch-subject",
    email: "different@example.test",
  });
  check(
    "a verified but different Google email is rejected by policy",
    !mismatchResult.ok && mismatchResult.reason === "email-mismatch"
  );
  check(
    "email mismatch leaves the account unlinked",
    (await prisma.user.findUnique({ where: { id: mismatch.user.id } }))?.googleId === null
  );

  await makeUser("already-linked@example.test", {
    googleId: "google-conflicting-subject",
  });
  const subjectTarget = await makeUser("subject-target@example.test");
  const subjectConflict = await linkGoogleIdentityToUser(subjectTarget.user.id, {
    id: "google-conflicting-subject",
    email: subjectTarget.user.email,
  });
  check(
    "a Google subject linked to another user is rejected",
    !subjectConflict.ok && subjectConflict.reason === "subject-conflict"
  );
  check(
    "subject conflict never changes the target user",
    (await prisma.user.findUnique({ where: { id: subjectTarget.user.id } }))?.googleId === null
  );

  const otherIdentity = await linkGoogleIdentityToUser(account.user.id, {
    id: "another-google-subject",
    email: account.user.email,
  });
  check(
    "a different Google identity cannot replace an existing link",
    !otherIdentity.ok && otherIdentity.reason === "account-conflict"
  );

  console.log("\nAccount-self authorization scope\n");
  await prisma.appSetting.upsert({
    where: { key: "instance.ownerUserId" },
    update: { value: account.user.id },
    create: { key: "instance.ownerUserId", value: account.user.id },
  });
  const ordinaryUser = await makeUser("ordinary@example.test");
  const ordinaryLink = await linkGoogleIdentityToUser(ordinaryUser.user.id, {
    id: "google-ordinary-subject",
    email: ordinaryUser.user.email,
  });
  check(
    "a non-owner may link only their own authenticated account",
    ordinaryLink.ok &&
      (await prisma.user.findUnique({ where: { id: ordinaryUser.user.id } }))?.googleId ===
        "google-ordinary-subject" &&
      (await prisma.user.findUnique({ where: { id: account.user.id } }))?.googleId ===
        "google-owner-subject"
  );

  console.log("\nRoute and UI guardrails\n");
  const startRoute = readFileSync(
    path.join(root, "src/app/api/account/google/link/route.ts"),
    "utf8"
  );
  const callbackRoute = readFileSync(
    path.join(root, "src/app/api/account/google/callback/route.ts"),
    "utf8"
  );
  const settings = readFileSync(path.join(root, "src/components/SettingsClient.tsx"), "utf8");
  const oauthSettingsRoute = readFileSync(
    path.join(root, "src/app/api/instance/oauth-settings/route.ts"),
    "utf8"
  );
  const maintenance = readFileSync(path.join(root, "src/lib/maintenance.ts"), "utf8");
  check(
    "initiation is an authenticated same-origin POST, not an owner-only action",
    /export async function POST/.test(startRoute) &&
      /requireContext\(\)/.test(startRoute) &&
      /requireSameOriginMutation\(req/.test(startRoute) &&
      !/requireInstanceOwner/.test(startRoute)
  );
  check(
    "initiation and callback are independently rate limited",
    /enforceLimit\("google-account-link-start"/.test(startRoute) &&
      /enforceLimit\("google-account-link-callback"/.test(callbackRoute)
  );
  check(
    "callback consumes state before exchanging the authorization code",
    callbackRoute.indexOf("consumeGoogleAccountLinkState") < callbackRoute.indexOf("exchangeCode(")
  );
  check(
    "callback requires Google's verified identity gate",
    /verifiedGoogleIdentity\(await googleUserInfo/.test(callbackRoute)
  );
  check(
    "account linking never creates, replaces, parks, or destroys a session",
    !/createSession|applySessionCookie|parkHandoff|destroySession|createPending/.test(callbackRoute)
  );
  check(
    "audit detail records outcomes without Google subject, email, code, or token",
    /audit\("account\.google\.link"/.test(callbackRoute) &&
      !/\b(?:googleId|email|identity|code|token)\s*:/.test(callbackRoute)
  );
  check(
    "Settings exposes the explicit link and explains exact-email and access preservation",
    settings.includes("Link Google sign-in") &&
      settings.includes("verified Google email must match this account exactly") &&
      settings.includes("neither your password nor your security-key requirement")
  );
  check(
    "the owner panel publishes the exact account-link callback",
    oauthSettingsRoute.includes("/api/account/google/callback")
  );
  check(
    "the hourly retention sweep prunes abandoned account-link state",
    maintenance.includes("pruneExpiredGoogleAccountLinkStates") &&
      maintenance.includes("googleLinkStates")
  );
} finally {
  await prisma.$disconnect();
  cleanDatabase(root, DB_NAME);
}

console.log(`\n${passed} account-link check(s) passed.`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
