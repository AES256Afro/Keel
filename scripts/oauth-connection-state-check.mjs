#!/usr/bin/env node
// Security regression checks for Google Drive, OneDrive, and OneNote connect
// callbacks. State belongs to one active browser session, user, workspace,
// provider, and purpose. It is short-lived, hashed at rest, and single-use.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanDatabase,
  prepareDatabase,
  testDatabaseUrl,
  testPrisma,
} from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "oauth-connection-state-check";
const databaseUrl = testDatabaseUrl(root, name);
let passed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

cleanDatabase(root, name);
prepareDatabase(root, databaseUrl);
process.env.DATABASE_URL = databaseUrl;
register("./ts-loader.mjs", import.meta.url);
const stateModule = await import(
  pathToFileURL(path.join(root, "src/lib/oauth-connection-state.ts")).href
);
const {
  OAUTH_CONNECTION_STATE_TTL_MS,
  consumeOAuthConnectionState,
  issueOAuthConnectionState,
  pruneExpiredOAuthConnectionStates,
} = stateModule;
const prisma = await testPrisma(root, databaseUrl);

try {
  const first = await prisma.user.create({
    data: { email: "oauth-first@example.test", name: "First", username: "oauth-first" },
  });
  const second = await prisma.user.create({
    data: { email: "oauth-second@example.test", name: "Second", username: "oauth-second" },
  });
  const firstWorkspace = await prisma.workspace.create({
    data: {
      name: "First workspace",
      ownerId: first.id,
      members: { create: { userId: first.id, role: "owner" } },
    },
  });
  const secondWorkspace = await prisma.workspace.create({
    data: {
      name: "Second workspace",
      ownerId: second.id,
      members: { create: { userId: second.id, role: "owner" } },
    },
  });
  const firstSession = await prisma.session.create({
    data: {
      token: "oauth-first-session",
      userId: first.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const otherSession = await prisma.session.create({
    data: {
      token: "oauth-other-session",
      userId: first.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const session = { id: firstSession.id, userId: first.id };
  const now = Date.now();

  console.log("\nSession, user, workspace, provider, and purpose binding\n");
  const issued = await issueOAuthConnectionState({
    session,
    workspaceId: firstWorkspace.id,
    provider: "google",
    purpose: "cloud",
    now,
  });
  check(
    "connection state expires after ten minutes",
    OAUTH_CONNECTION_STATE_TTL_MS === 10 * 60 * 1000 &&
      issued.expiresAt.getTime() === now + OAUTH_CONNECTION_STATE_TTL_MS
  );
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: "oauth.connection-state." } },
  });
  check(
    "only the state digest is persisted",
    rows.length === 1 && !JSON.stringify(rows).includes(issued.state)
  );
  const wrongSession = await consumeOAuthConnectionState({
    session: { id: otherSession.id, userId: first.id },
    provider: "google",
    purpose: "cloud",
    state: issued.state,
    now: now + 1,
  });
  check("another active session cannot consume the state", !wrongSession.ok);
  const wrongProvider = await consumeOAuthConnectionState({
    session,
    provider: "onedrive",
    purpose: "cloud",
    state: issued.state,
    now: now + 2,
  });
  check(
    "a provider-confused callback is rejected",
    !wrongProvider.ok && wrongProvider.reason === "provider-mismatch"
  );
  const wrongPurpose = await consumeOAuthConnectionState({
    session,
    provider: "google",
    purpose: "onenote",
    state: issued.state,
    now: now + 3,
  });
  check("a cloud state cannot finish a OneNote callback", !wrongPurpose.ok);
  const consumed = await consumeOAuthConnectionState({
    session,
    provider: "google",
    purpose: "cloud",
    state: issued.state,
    now: now + 4,
  });
  check(
    "the correct callback receives only its bound workspace id",
    consumed.ok && consumed.workspaceId === firstWorkspace.id && consumed.workspaceId !== secondWorkspace.id
  );
  const replay = await consumeOAuthConnectionState({
    session,
    provider: "google",
    purpose: "cloud",
    state: issued.state,
    now: now + 5,
  });
  check("a consumed connection state cannot be replayed", !replay.ok);

  console.log("\nReplacement, concurrency, expiry, and cleanup\n");
  const simultaneous = await Promise.all([
    issueOAuthConnectionState({
      session,
      workspaceId: firstWorkspace.id,
      provider: "google",
      purpose: "cloud",
      now: now + 10,
    }),
    issueOAuthConnectionState({
      session,
      workspaceId: firstWorkspace.id,
      provider: "google",
      purpose: "cloud",
      now: now + 11,
    }),
  ]);
  const results = await Promise.all(
    simultaneous.map(({ state }) =>
      consumeOAuthConnectionState({
        session,
        provider: "google",
        purpose: "cloud",
        state,
        now: now + 12,
      })
    )
  );
  check(
    "concurrent starts leave only one usable state",
    results.filter((result) => result.ok).length === 1
  );

  const expiring = await issueOAuthConnectionState({
    session,
    workspaceId: firstWorkspace.id,
    provider: "onedrive",
    purpose: "onenote",
    now,
  });
  const expired = await consumeOAuthConnectionState({
    session,
    provider: "onedrive",
    purpose: "onenote",
    state: expiring.state,
    now: now + OAUTH_CONNECTION_STATE_TTL_MS,
  });
  check("expired state is rejected and consumed", !expired.ok && expired.reason === "expired");
  const expiredReplay = await consumeOAuthConnectionState({
    session,
    provider: "onedrive",
    purpose: "onenote",
    state: expiring.state,
    now: now + OAUTH_CONNECTION_STATE_TTL_MS + 1,
  });
  check("expired state cannot be retried", !expiredReplay.ok);

  const abandoned = await issueOAuthConnectionState({
    session,
    workspaceId: firstWorkspace.id,
    provider: "google",
    purpose: "cloud",
    now,
  });
  const swept = await pruneExpiredOAuthConnectionStates(
    now + OAUTH_CONNECTION_STATE_TTL_MS,
    20
  );
  check("maintenance removes abandoned expired connection state", swept === 1);
  const sweptReplay = await consumeOAuthConnectionState({
    session,
    provider: "google",
    purpose: "cloud",
    state: abandoned.state,
    now: now + OAUTH_CONNECTION_STATE_TTL_MS + 1,
  });
  check("maintenance-pruned state is unusable", !sweptReplay.ok);

  const bulk = Array.from({ length: 520 }, (_, index) => ({
    key: `oauth.connection-state.cloud.bulk-${String(index).padStart(4, "0")}`,
    value: JSON.stringify({
      v: 1,
      sessionId: `bulk-${index}`,
      userId: first.id,
      workspaceId: firstWorkspace.id,
      provider: "google",
      purpose: "cloud",
      stateHash: "a".repeat(64),
      expiresAt: index % 2 === 0 ? now - 1 : now + OAUTH_CONNECTION_STATE_TTL_MS,
    }),
  }));
  await prisma.appSetting.createMany({ data: bulk });
  const bulkSwept = await pruneExpiredOAuthConnectionStates(now, 20);
  const bulkRemaining = await prisma.appSetting.findMany({
    where: { key: { startsWith: "oauth.connection-state.cloud.bulk-" } },
    select: { value: true },
  });
  check(
    "cleanup scans past 500 interleaved live and expired rows",
    bulkSwept === 260 &&
      bulkRemaining.length === 260 &&
      bulkRemaining.every((row) => JSON.parse(row.value).expiresAt > now)
  );

  console.log("\nRoute guardrails\n");
  const cloudStart = readFileSync(path.join(root, "src/app/api/cloud/connect/route.ts"), "utf8");
  const cloudCallback = readFileSync(
    path.join(root, "src/app/api/cloud/callback/[provider]/route.ts"),
    "utf8"
  );
  const oneNoteStart = readFileSync(
    path.join(root, "src/app/api/onenote/connect/route.ts"),
    "utf8"
  );
  const oneNoteCallback = readFileSync(
    path.join(root, "src/app/api/onenote/callback/route.ts"),
    "utf8"
  );
  const starts = cloudStart + oneNoteStart;
  const callbacks = cloudCallback + oneNoteCallback;
  check(
    "both starts issue server-bound state for the active request session",
    (starts.match(/issueOAuthConnectionState/g) ?? []).length >= 4 &&
      (starts.match(/activeRequestSession/g) ?? []).length >= 4
  );
  check(
    "legacy cookie-only state is gone",
    !/keel-oauth-state|nopin-onenote-state/.test(starts + callbacks)
  );
  check(
    "callbacks consume state before exchanging authorization codes",
    cloudCallback.indexOf("consumeOAuthConnectionState") < cloudCallback.indexOf("exchangeCode(") &&
      oneNoteCallback.indexOf("consumeOAuthConnectionState") < oneNoteCallback.indexOf("exchangeCode(")
  );
  check(
    "callbacks require the initiating workspace to remain active",
    (callbacks.match(/consumed\.workspaceId !== workspace\.id/g) ?? []).length === 2
  );
  check(
    "credential writes re-check the bound workspace owner",
    (callbacks.match(/ownerId: user\.id/g) ?? []).length === 2 &&
      (callbacks.match(/updateMany/g) ?? []).length >= 2
  );
  check(
    "connection initiation and callbacks are rate-limited",
    (starts.match(/enforceLimit/g) ?? []).length >= 4 &&
      (callbacks.match(/enforceLimit/g) ?? []).length >= 4
  );
} finally {
  await prisma.$disconnect();
  cleanDatabase(root, name);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
  process.exitCode = 1;
}
