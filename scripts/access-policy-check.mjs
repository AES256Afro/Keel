#!/usr/bin/env node
// Access-policy regression checks.
//
// A local installer once wrote an owner allowlist and KEEL_DISABLE_SIGNUP=1
// before the owner account existed. The configured owner could therefore
// never register. These checks keep the normal open-local policy, explicit
// lockdown and the unconditional hard signup stop separate. The installer,
// not the runtime policy, repairs the exact affected 1.2.1 local config.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "access-policy-check";
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

async function rejects(operation) {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

const ENV_KEYS = [
  "KEEL_OWNER_EMAIL",
  "KEEL_OWNER_USER_ID",
  "KEEL_OWNER_BOOTSTRAP_TOKEN",
  "KEEL_ALLOWED_EMAILS",
  "KEEL_DISABLE_SIGNUP",
  "NOPIN_OWNER_EMAIL",
  "NOPIN_OWNER_USER_ID",
  "NOPIN_OWNER_BOOTSTRAP_TOKEN",
  "NOPIN_ALLOWED_EMAILS",
  "NOPIN_DISABLE_SIGNUP",
  "KEEL_DESKTOP_HANDOFF",
  "HOSTNAME",
];

function clearPolicyEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

cleanDatabase(root, DB_NAME);
prepareDatabase(root, DB_URL);
process.env.DATABASE_URL = DB_URL;
register("./ts-loader.mjs", import.meta.url);

const { emailAllowed, getAccessSettings, signupAllowed, updateAccessSettings } = await import(
  pathToFileURL(path.join(root, "src/lib/access.ts")).href
);
const { getInstanceClaimStatus, isInstanceOwner } = await import(
  pathToFileURL(path.join(root, "src/lib/instance.ts")).href
);
const { claimInstanceWithBootstrapToken } = await import(
  pathToFileURL(path.join(root, "src/lib/instance-claim.ts")).href
);
const prisma = await testPrisma(root, DB_URL);

async function reset() {
  clearPolicyEnv();
  await prisma.appSetting.deleteMany();
  await prisma.user.deleteMany();
}

try {
  console.log("\nLocal registration defaults\n");
  await reset();
  check("an unconfigured local instance accepts registration", await signupAllowed("anyone@example.test"));
  let settings = await getAccessSettings();
  check(
    "an unconfigured local instance reports both controls editable",
    !settings.allowedEmailsLocked && !settings.signupLocked && !settings.envLocked
  );

  process.env.KEEL_OWNER_EMAIL = "owner@example.test";
  check("a legacy owner email does not close registration", await signupAllowed("other@example.test"));
  check("the legacy-selected address can register", await signupAllowed("OWNER@EXAMPLE.TEST"));

  console.log("\nOpt-in owner lockdown\n");
  process.env.KEEL_ALLOWED_EMAILS = "owner@example.test";
  check("the allowlisted owner can register", await signupAllowed("owner@example.test"));
  check("an address outside the allowlist cannot register", !(await signupAllowed("other@example.test")));

  settings = await getAccessSettings();
  check(
    "an environment allowlist locks only the allowlist field",
    settings.allowedEmailsLocked && !settings.signupLocked && settings.envLocked
  );
  await updateAccessSettings({
    allowedEmails: ["ignored@example.test"],
    signupDisabled: true,
    ownerEmail: "owner@example.test",
  });
  settings = await getAccessSettings();
  check(
    "registration remains editable beside an environment allowlist",
    settings.signupDisabled && settings.allowedEmails.join(",") === "owner@example.test"
  );

  console.log("\nHard signup stop\n");
  await reset();
  process.env.KEEL_DISABLE_SIGNUP = "1";
  check("a hard signup stop blocks an empty unconfigured instance", !(await signupAllowed("anyone@example.test")));

  process.env.KEEL_OWNER_EMAIL = "owner@example.test";
  check("a legacy owner email does not bypass a hard signup stop", !(await signupAllowed("owner@example.test")));
  settings = await getAccessSettings();
  check(
    "an environment signup policy locks only the registration field",
    !settings.allowedEmailsLocked && settings.signupLocked && settings.envLocked
  );
  await updateAccessSettings({
    allowedEmails: ["owner@example.test"],
    signupDisabled: false,
    ownerEmail: "owner@example.test",
  });
  settings = await getAccessSettings();
  check(
    "the allowlist remains editable beside an environment signup policy",
    settings.allowedEmails.join(",") === "owner@example.test" && settings.signupDisabled
  );

  console.log("\nHard stop with an owner allowlist\n");
  process.env.KEEL_ALLOWED_EMAILS = "owner@example.test";
  check("the hard stop still rejects the exact configured owner", !(await signupAllowed("OWNER@example.test")));
  check("the hard stop still rejects every other address", !(await signupAllowed("other@example.test")));

  await prisma.user.create({
    data: { email: "owner@example.test", name: "Owner", username: "owner" },
  });
  check("the hard stop remains closed after an account exists", !(await signupAllowed("owner@example.test")));
  check("the existing owner remains allowed to sign in", await emailAllowed("OWNER@example.test"));

  await reset();
  process.env.KEEL_OWNER_EMAIL = "owner@example.test";
  process.env.KEEL_ALLOWED_EMAILS = "owner@example.test, helper@example.test";
  process.env.KEEL_DISABLE_SIGNUP = "1";
  check("a broader allowlist never bypasses the hard signup stop", !(await signupAllowed("owner@example.test")));

  console.log("\nDatabase-managed and legacy policy\n");
  await reset();
  await prisma.appSetting.create({
    data: { key: "access.allowedEmails", value: JSON.stringify(["member@example.test"]) },
  });
  check("a database allowlist accepts a listed address", await signupAllowed("MEMBER@example.test"));
  check("a database allowlist rejects an unlisted address", !(await signupAllowed("other@example.test")));

  process.env.KEEL_ALLOWED_EMAILS = "owner@example.test";
  process.env.KEEL_DISABLE_SIGNUP = "0";
  check("environment access policy overrides database policy", await signupAllowed("owner@example.test"));
  check("the overridden database address is rejected", !(await signupAllowed("member@example.test")));

  console.log("\nMalformed database policy fails closed\n");
  await reset();
  await prisma.appSetting.createMany({
    data: [
      { key: "access.allowedEmails", value: "not-json" },
      { key: "access.signupDisabled", value: "false" },
    ],
  });
  check(
    "a malformed stored allowlist denies existing-account sign-in",
    !(await emailAllowed("member@example.test"))
  );
  check(
    "a malformed stored allowlist denies new registration",
    !(await signupAllowed("member@example.test"))
  );
  check(
    "a malformed stored allowlist is reported instead of interpreted as open",
    await rejects(() => getAccessSettings())
  );
  check(
    "a settings mutation cannot replace a malformed allowlist with an open policy",
    (await rejects(() =>
      updateAccessSettings({
        allowedEmails: [],
        signupDisabled: false,
        ownerEmail: "owner@example.test",
      })
    )) &&
      (await prisma.appSetting.findUnique({ where: { key: "access.allowedEmails" } }))?.value ===
        "not-json"
  );

  await reset();
  await prisma.appSetting.createMany({
    data: [
      { key: "access.allowedEmails", value: "[]" },
      { key: "access.signupDisabled", value: "sometimes" },
    ],
  });
  check(
    "a malformed stored signup switch denies existing-account sign-in",
    !(await emailAllowed("member@example.test"))
  );
  check(
    "a malformed stored signup switch denies new registration",
    !(await signupAllowed("member@example.test"))
  );
  check(
    "a malformed stored signup switch is reported instead of interpreted as open",
    await rejects(() => getAccessSettings())
  );

  console.log("\nAccess policy writes are atomic\n");
  await reset();
  await prisma.appSetting.createMany({
    data: [
      { key: "access.allowedEmails", value: '["member@example.test"]' },
      { key: "access.signupDisabled", value: "false" },
    ],
  });
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "reject_access_signup_update"
    BEFORE UPDATE OF "value" ON "AppSetting"
    WHEN NEW."key" = 'access.signupDisabled'
    BEGIN
      SELECT RAISE(ABORT, 'simulated access policy write failure');
    END
  `);
  const partialSaveRejected = await rejects(() =>
    updateAccessSettings({
      allowedEmails: ["owner@example.test"],
      signupDisabled: true,
      ownerEmail: "owner@example.test",
    })
  );
  const rolledBackAllowed = await prisma.appSetting.findUnique({
    where: { key: "access.allowedEmails" },
  });
  const rolledBackSignup = await prisma.appSetting.findUnique({
    where: { key: "access.signupDisabled" },
  });
  check(
    "a failed second policy write rolls back the first write",
    partialSaveRejected &&
      rolledBackAllowed?.value === '["member@example.test"]' &&
      rolledBackSignup?.value === "false"
  );
  await prisma.$executeRawUnsafe('DROP TRIGGER "reject_access_signup_update"');

  console.log("\nMalformed environment policy fails closed\n");
  await reset();
  process.env.KEEL_ALLOWED_EMAILS = "owner.example.test";
  settings = await getAccessSettings();
  check(
    "a malformed nonempty allowlist is locked and denies every sign-in",
    settings.allowedEmailsLocked &&
      settings.allowedEmails.length === 0 &&
      !(await emailAllowed("owner@example.test")) &&
      !(await signupAllowed("owner@example.test"))
  );
  delete process.env.KEEL_ALLOWED_EMAILS;
  process.env.KEEL_DISABLE_SIGNUP = "truee";
  settings = await getAccessSettings();
  check(
    "a malformed nonempty signup switch is locked and fails closed",
    settings.signupLocked && settings.signupDisabled && !(await signupAllowed("owner@example.test"))
  );
  process.env.KEEL_DISABLE_SIGNUP = "false";
  check("an exact false environment switch explicitly keeps registration open", await signupAllowed("owner@example.test"));

  await reset();
  process.env.NOPIN_ALLOWED_EMAILS = "not-an-email";
  process.env.NOPIN_DISABLE_SIGNUP = "sometimes";
  settings = await getAccessSettings();
  check(
    "malformed legacy-prefixed controls also fail closed",
    settings.allowedEmailsLocked && settings.signupLocked && settings.signupDisabled &&
      !(await emailAllowed("anyone@example.test"))
  );

  await reset();
  process.env.NOPIN_OWNER_EMAIL = "legacy@example.test";
  process.env.NOPIN_ALLOWED_EMAILS = "legacy@example.test";
  process.env.NOPIN_DISABLE_SIGNUP = "1";
  check("legacy-prefixed hard stops remain unconditional", !(await signupAllowed("legacy@example.test")));

  console.log("\nInstance ownership is separate from registration\n");
  await reset();
  const first = await prisma.user.create({
    data: { email: "first@example.test", name: "First", username: "first" },
  });
  await prisma.workspace.create({
    data: { name: "First", ownerId: first.id, members: { create: { userId: first.id, role: "owner" } } },
  });
  check("registering first does not claim a server", !(await isInstanceOwner(first)));
  let claim = await getInstanceClaimStatus(first);
  check("an unclaimed server reports an actionable required claim", !claim.claimed && claim.required && !claim.isOwner);

  await prisma.appSetting.create({ data: { key: "instance.ownerUserId", value: first.id } });
  check("the immutable claimed user id grants instance ownership", await isInstanceOwner(first));
  claim = await getInstanceClaimStatus(first);
  check("an explicit claim reports claimed ownership", claim.claimed && !claim.required && claim.isOwner);

  await prisma.appSetting.delete({ where: { key: "instance.ownerUserId" } });

  console.log("\nEnvironment ownership cannot be claimed by an email string\n");
  process.env.KEEL_OWNER_EMAIL = first.email;
  check(
    "a password account matching KEEL_OWNER_EMAIL gets no instance power",
    !(await isInstanceOwner(first))
  );
  await prisma.user.update({
    where: { id: first.id },
    data: { googleId: "verified-google-first" },
  });
  const verifiedFirst = { ...first, googleId: "verified-google-first" };
  check(
    "a matching Google-verified legacy owner is bound once to its stable id",
    await isInstanceOwner(verifiedFirst)
  );
  check(
    "the verified legacy binding is persisted",
    (await prisma.appSetting.findUnique({ where: { key: "instance.ownerUserId" } }))?.value ===
      first.id
  );
  const other = await prisma.user.create({
    data: {
      email: "other-owner@example.test",
      name: "Other",
      username: "other-owner",
      googleId: "verified-google-other",
    },
  });
  process.env.KEEL_OWNER_EMAIL = other.email;
  check(
    "changing the legacy owner email cannot replace the persisted owner",
    !(await isInstanceOwner(other)) && (await isInstanceOwner(verifiedFirst))
  );

  await prisma.appSetting.delete({ where: { key: "instance.ownerUserId" } });
  delete process.env.KEEL_OWNER_EMAIL;
  process.env.KEEL_OWNER_USER_ID = first.id;
  check(
    "KEEL_OWNER_USER_ID directly authorizes only the stable configured id",
    (await isInstanceOwner(first)) && !(await isInstanceOwner(other))
  );
  process.env.KEEL_OWNER_USER_ID = "invalid owner id";
  claim = await getInstanceClaimStatus(first);
  check(
    "a malformed nonempty KEEL_OWNER_USER_ID fails closed without owner fallback",
    !(await isInstanceOwner(first)) && !(await isInstanceOwner(other)) && claim.claimed && !claim.isOwner
  );
  delete process.env.KEEL_OWNER_USER_ID;

  console.log("\nHosted bootstrap writes a stable owner without storing its secret\n");
  const bootstrap = "b".repeat(64);
  process.env.KEEL_OWNER_BOOTSTRAP_TOKEN = bootstrap;
  claim = await getInstanceClaimStatus(first);
  check(
    "an unclaimed hosted instance does not disclose whether a token is configured",
    !claim.claimed && !("bootstrapAvailable" in claim)
  );
  delete process.env.KEEL_OWNER_BOOTSTRAP_TOKEN;
  let unavailableMessage = "";
  try {
    await claimInstanceWithBootstrapToken(first, "wrong-token");
  } catch (error) {
    unavailableMessage = error instanceof Error ? error.message : String(error);
  }
  process.env.KEEL_OWNER_BOOTSTRAP_TOKEN = bootstrap;
  let invalidMessage = "";
  try {
    await claimInstanceWithBootstrapToken(first, "wrong-token");
  } catch (error) {
    invalidMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "invalid and unavailable hosted tokens fail with the same response",
    Boolean(invalidMessage) && invalidMessage === unavailableMessage
  );
  await prisma.instanceClaimToken.createMany({
    data: [
      {
        userId: first.id,
        tokenHash: "1".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        userId: other.id,
        tokenHash: "2".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ],
  });
  const race = await Promise.allSettled([
    claimInstanceWithBootstrapToken(first, bootstrap),
    claimInstanceWithBootstrapToken(other, bootstrap),
  ]);
  const winnerId = race[0].status === "fulfilled" ? first.id : other.id;
  check(
    "concurrent valid hosted claims persist exactly one immutable winner",
    race.filter((result) => result.status === "fulfilled").length === 1 &&
      (await prisma.appSetting.findUnique({ where: { key: "instance.ownerUserId" } }))
        ?.value === winnerId
  );
  check(
    "a hosted claim neutralizes every outstanding local claim token",
    (await prisma.instanceClaimToken.count()) === 0
  );
  const allSettings = await prisma.appSetting.findMany();
  const claimAudits = await prisma.auditEvent.findMany({ where: { action: "instance.claim" } });
  check(
    "the bootstrap secret is absent from settings and audit",
    !JSON.stringify(allSettings).includes(bootstrap) &&
      !JSON.stringify(claimAudits).includes(bootstrap)
  );
  let replacementRefused = false;
  const loser = winnerId === first.id ? other : first;
  try {
    await claimInstanceWithBootstrapToken(loser, bootstrap);
  } catch {
    replacementRefused = true;
  }
  check("a hosted bootstrap cannot replace an existing owner", replacementRefused);

  await prisma.appSetting.delete({ where: { key: "instance.ownerUserId" } });
  delete process.env.KEEL_OWNER_BOOTSTRAP_TOKEN;
  process.env.KEEL_DESKTOP_HANDOFF = "1";
  process.env.HOSTNAME = "0.0.0.0";
  check("a network-bound server cannot use the desktop ownership fallback", !(await isInstanceOwner(first)));
  process.env.HOSTNAME = "localhost";
  check("the Electron localhost handoff preserves single-user desktop ownership", await isInstanceOwner(first));
  delete process.env.KEEL_DESKTOP_HANDOFF;

  console.log("\nAccess policy database failures fail closed\n");
  clearPolicyEnv();
  await prisma.$executeRawUnsafe('DROP TABLE "AppSetting"');
  check(
    "an AppSetting read failure denies existing-account sign-in",
    !(await emailAllowed("member@example.test"))
  );
  check(
    "an AppSetting read failure denies new registration",
    !(await signupAllowed("member@example.test"))
  );
  check(
    "an AppSetting read failure propagates through policy inspection",
    await rejects(() => getAccessSettings())
  );
  check(
    "an AppSetting read failure prevents policy mutation",
    await rejects(() =>
      updateAccessSettings({
        allowedEmails: [],
        signupDisabled: false,
        ownerEmail: "owner@example.test",
      })
    )
  );

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
    process.exitCode = 1;
  }
} finally {
  clearPolicyEnv();
  await prisma.$disconnect();
  cleanDatabase(root, DB_NAME);
}
