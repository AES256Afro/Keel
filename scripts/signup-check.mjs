#!/usr/bin/env node
// Account provisioning invariants, including concurrent registration and
// rollback after a late failure. Runs against SQLite locally and PostgreSQL
// when DATABASE_URL points at the CI service.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  cleanDatabase,
  isPostgres,
  prepareDatabase,
  testDatabaseUrl,
  testPrisma,
} from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "signup-check";
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

const { provisionUser } = await import(
  pathToFileURL(path.join(root, "src/lib/signup.ts")).href
);
const { linkGoogleAccount, resolveGoogleAccount } = await import(
  pathToFileURL(path.join(root, "src/app/api/auth/google/callback/account.ts")).href
);
const { verifiedGoogleIdentity } = await import(
  pathToFileURL(path.join(root, "src/lib/oauth.ts")).href
);
const { prisma: appPrisma } = await import(
  pathToFileURL(path.join(root, "src/lib/prisma.ts")).href
);
const prisma = await testPrisma(root, DB_URL);

async function reset() {
  await prisma.page.deleteMany();
  await prisma.workspaceInvite.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
}

async function seedWorkspace(email = "host@example.test") {
  const user = await prisma.user.create({
    data: { email, name: "Host", username: email.split("@")[0] },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Host workspace",
      ownerId: user.id,
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  return { user, workspace };
}

async function installInviteDeleteFailure() {
  if (isPostgres(DB_URL)) {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION signup_fail_invite_delete_fn()
      RETURNS trigger AS $$
      BEGIN
        IF OLD."email" = 'rollback@example.test' THEN
          RAISE EXCEPTION 'forced late provisioning failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER signup_fail_invite_delete
      BEFORE DELETE ON "WorkspaceInvite"
      FOR EACH ROW EXECUTE FUNCTION signup_fail_invite_delete_fn()
    `);
  } else {
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER signup_fail_invite_delete
      BEFORE DELETE ON "WorkspaceInvite"
      WHEN OLD."email" = 'rollback@example.test'
      BEGIN
        SELECT RAISE(ABORT, 'forced late provisioning failure');
      END
    `);
  }
}

async function removeInviteDeleteFailure() {
  if (isPostgres(DB_URL)) {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS signup_fail_invite_delete ON "WorkspaceInvite"'
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS signup_fail_invite_delete_fn()');
  } else {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS signup_fail_invite_delete');
  }
}

try {
  console.log("\nConcurrent duplicate email\n");
  await reset();
  const duplicateResults = await Promise.allSettled([
    provisionUser({
      name: "First",
      email: "same@example.test",
      passwordHash: "hash-one",
      emailVerified: false,
    }),
    provisionUser({
      name: "Second",
      email: "same@example.test",
      passwordHash: "hash-two",
      emailVerified: false,
    }),
  ]);
  const duplicateSuccesses = duplicateResults.filter((result) => result.status === "fulfilled");
  const duplicateFailures = duplicateResults.filter((result) => result.status === "rejected");
  check("exactly one same-email registration commits", duplicateSuccesses.length === 1);
  check("the losing same-email registration fails", duplicateFailures.length === 1);

  const sameUser = await prisma.user.findUnique({ where: { email: "same@example.test" } });
  check("one user row remains", (await prisma.user.count()) === 1);
  check(
    "the winner has one owned workspace",
    Boolean(sameUser) && (await prisma.workspace.count({ where: { ownerId: sameUser.id } })) === 1
  );
  check(
    "the winner has one owner membership",
    Boolean(sameUser) &&
      (await prisma.workspaceMember.count({ where: { userId: sameUser.id, role: "owner" } })) === 1
  );
  check(
    "the winner has one welcome page",
    Boolean(sameUser) &&
      (await prisma.page.count({ where: { createdById: sameUser.id, title: "Getting started" } })) === 1
  );

  console.log("\nConcurrent username collision\n");
  await reset();
  const prefixResults = await Promise.allSettled([
    provisionUser({
      name: "Alpha",
      email: "crew@alpha.test",
      passwordHash: "hash-alpha",
      emailVerified: false,
    }),
    provisionUser({
      name: "Beta",
      email: "crew@beta.test",
      passwordHash: "hash-beta",
      emailVerified: false,
    }),
  ]);
  check(
    "both distinct-email registrations commit",
    prefixResults.every((result) => result.status === "fulfilled"),
    prefixResults
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason))
      .join("; ")
  );
  const prefixUsers = await prisma.user.findMany({ orderBy: { email: "asc" } });
  check("both users have distinct usernames", new Set(prefixUsers.map((user) => user.username)).size === 2);
  check("each user has a workspace", (await prisma.workspace.count()) === 2);
  check("each user has an owner membership", (await prisma.workspaceMember.count()) === 2);
  check("each user has a welcome page", (await prisma.page.count()) === 2);

  console.log("\nPassword registration cannot claim an email invite\n");
  await reset();
  const { workspace: passwordInviteWorkspace } = await seedWorkspace();
  await prisma.workspaceInvite.create({
    data: {
      workspaceId: passwordInviteWorkspace.id,
      email: "password-invite@example.test",
      role: "editor",
    },
  });
  const passwordInviteUser = await provisionUser({
    name: "Password invite claimant",
    email: "password-invite@example.test",
    passwordHash: "hash-password-invite",
    emailVerified: false,
  });
  check(
    "password registration grants no invited membership",
    (await prisma.workspaceMember.count({
      where: {
        workspaceId: passwordInviteWorkspace.id,
        userId: passwordInviteUser.id,
      },
    })) === 0
  );
  check(
    "password registration leaves the invite pending",
    (await prisma.workspaceInvite.count({
      where: {
        workspaceId: passwordInviteWorkspace.id,
        email: "password-invite@example.test",
      },
    })) === 1
  );
  check(
    "password registration still provisions its personal workspace",
    (await prisma.workspace.count({ where: { ownerId: passwordInviteUser.id } })) === 1 &&
      (await prisma.page.count({
        where: { createdById: passwordInviteUser.id, title: "Getting started" },
      })) === 1
  );

  console.log("\nLate verified-identity failure rolls back the complete account\n");
  await reset();
  const { workspace } = await seedWorkspace();
  await prisma.workspaceInvite.create({
    data: {
      workspaceId: workspace.id,
      email: "rollback@example.test",
      role: "editor",
    },
  });
  await installInviteDeleteFailure();
  let rolledBack = false;
  try {
    await provisionUser({
      name: "Rollback",
      email: "rollback@example.test",
      googleId: "google-rollback-subject",
      emailVerified: true,
    });
  } catch {
    rolledBack = true;
  } finally {
    await removeInviteDeleteFailure();
  }
  check("a forced late failure is surfaced", rolledBack);
  check(
    "the failed user is absent",
    (await prisma.user.findUnique({ where: { email: "rollback@example.test" } })) === null
  );
  check("no personal workspace leaked", (await prisma.workspace.count()) === 1);
  check("no owner membership leaked", (await prisma.workspaceMember.count()) === 1);
  check("no welcome page leaked", (await prisma.page.count()) === 0);
  check(
    "the pending invite remains after rollback",
    (await prisma.workspaceInvite.count({ where: { email: "rollback@example.test" } })) === 1
  );

  console.log("\nVerified Google invite conversion commits atomically\n");
  const invited = await provisionUser({
    name: "Invited",
    email: "rollback@example.test",
    googleId: "google-invited-subject",
    emailVerified: true,
  });
  check(
    "verified Google signup creates the invited membership",
    (await prisma.workspaceMember.count({
      where: { workspaceId: workspace.id, userId: invited.id, role: "editor" },
    })) === 1
  );
  check(
    "verified Google signup removes the converted invite",
    (await prisma.workspaceInvite.count({ where: { email: "rollback@example.test" } })) === 0
  );
  check(
    "the invited user also has a complete personal workspace",
    (await prisma.workspace.count({ where: { ownerId: invited.id } })) === 1 &&
      (await prisma.page.count({ where: { createdById: invited.id, title: "Getting started" } })) === 1
  );

  console.log("\nGoogle userinfo verification gate\n");
  check(
    "an unverified Google email is rejected",
    verifiedGoogleIdentity({
      id: "google-unverified-subject",
      email: "invite@example.test",
      verified_email: false,
    }) === null
  );
  check(
    "a missing Google verification attestation is rejected",
    verifiedGoogleIdentity({
      id: "google-missing-attestation",
      email: "invite@example.test",
    }) === null
  );
  const verifiedIdentity = verifiedGoogleIdentity({
    id: " google-verified-subject ",
    email: " VERIFIED@EXAMPLE.TEST ",
    name: " Verified Person ",
    verified_email: true,
  });
  check(
    "a verified Google identity is accepted and normalized",
    verifiedIdentity?.id === "google-verified-subject" &&
      verifiedIdentity.email === "verified@example.test" &&
      verifiedIdentity.name === "Verified Person"
  );

  console.log("\nConcurrent Google identity linking\n");
  await reset();
  const sameAccount = await prisma.user.create({
    data: { email: "same-google@example.test", name: "Same", username: "same-google" },
  });
  const sameLinkResults = await Promise.all([
    linkGoogleAccount(sameAccount, "google-subject-same", sameAccount.email),
    linkGoogleAccount(sameAccount, "google-subject-same", sameAccount.email),
  ]);
  check(
    "two callbacks can idempotently link the same account",
    sameLinkResults.every(
      (result) => !result.conflict && result.user?.googleId === "google-subject-same"
    )
  );
  check(
    "the same-account race leaves one Google link",
    (await prisma.user.count({ where: { googleId: "google-subject-same" } })) === 1
  );

  const firstAccount = await prisma.user.create({
    data: { email: "first-google@example.test", name: "First", username: "first-google" },
  });
  const secondAccount = await prisma.user.create({
    data: { email: "second-google@example.test", name: "Second", username: "second-google" },
  });
  const competingLinks = await Promise.all([
    linkGoogleAccount(firstAccount, "google-subject-race", firstAccount.email),
    linkGoogleAccount(secondAccount, "google-subject-race", secondAccount.email),
  ]);
  check(
    "one of two accounts wins a concurrent Google subject link",
    competingLinks.filter((result) => !result.conflict && result.user).length === 1
  );
  check(
    "the competing account fails closed with an identity conflict",
    competingLinks.filter((result) => Boolean(result.conflict)).length === 1
  );
  check(
    "the database keeps one account per Google subject",
    (await prisma.user.count({ where: { googleId: "google-subject-race" } })) === 1
  );

  const passwordOnly = await prisma.user.create({
    data: {
      email: "password-only@example.test",
      name: "Password only",
      username: "password-only",
      passwordHash: "not-a-real-hash",
    },
  });
  const preHijack = await resolveGoogleAccount(
    "new-google-subject",
    passwordOnly.email
  );
  check(
    "Google cannot auto-link an unverified password account by email alone",
    Boolean(preHijack.conflict) && preHijack.user === null
  );

  console.log("\nLegacy duplicate Google identity fails closed\n");
  await reset();
  // Recreate the pre-1.2.2 shape to prove runtime auth remains safe if the
  // uniqueness migration reports duplicates and leaves the old rows intact.
  if (!isPostgres(DB_URL)) {
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "User_googleId_key"');
    await prisma.user.createMany({
      data: [
        { email: "legacy-first@example.test", name: "First", username: "legacy-first", googleId: "legacy-duplicate-subject" },
        { email: "legacy-second@example.test", name: "Second", username: "legacy-second", googleId: "legacy-duplicate-subject" },
      ],
    });
    const ambiguous = await resolveGoogleAccount(
      "legacy-duplicate-subject",
      "legacy-first@example.test"
    );
    check(
      "duplicate legacy Google links are rejected instead of choosing a row",
      Boolean(ambiguous.conflict) && ambiguous.user === null
    );
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId")').catch(() => {});
  } else {
    check("legacy duplicate runtime check is covered by the SQLite job", true);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} signup check(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${passed} signup checks passed.`);
  }
} finally {
  await removeInviteDeleteFailure().catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
  cleanDatabase(root, DB_NAME);
}
