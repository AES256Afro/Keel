#!/usr/bin/env node
// Owner-managed public-site and scheduled-backup setting regressions.
//
// This suite uses an isolated SQLite database and an explicit host key. It
// proves per-field env precedence, write-only encrypted storage, safe URL
// validation, fail-closed key damage, and redaction of effective host state.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDatabase, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "keel-operator-settings-"));
const databasePath = path.join(scratch, "operator.db");
const databaseUrl = `file:${databasePath.split(path.sep).join("/")}`;
const managedPassphrase = "correct horse battery staple";
const environmentPassphrase = "environment-owned-backup-secret";
const hostKey = Buffer.alloc(32, 19).toString("base64url");

const environmentNames = [
  "KEEL_SITE_NAME",
  "KEEL_SITE_TAGLINE",
  "KEEL_NOTES_URL",
  "KEEL_BACKUP_PASSPHRASE",
  "KEEL_SERVER_SECRET_KEY",
  "NOPIN_SITE_NAME",
  "NOPIN_SITE_TAGLINE",
  "NOPIN_NOTES_URL",
  "NOPIN_BACKUP_PASSPHRASE",
  "NOPIN_SERVER_SECRET_KEY",
  "KEEL_BACKUP_DIR",
  "KEEL_PUBLIC_URL",
  "KEEL_WEBAUTHN_RP_ID",
  "KEEL_WEBAUTHN_ORIGIN",
  "HOST",
  "HOSTNAME",
];

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

function clearEnvironment() {
  for (const name of environmentNames) delete process.env[name];
}

clearEnvironment();
process.env.DATABASE_URL = databaseUrl;
process.env.KEEL_SERVER_SECRET_KEY = hostKey;
prepareDatabase(root, databaseUrl);
register("./ts-loader.mjs", import.meta.url);

const settings = await import(pathToFileURL(path.join(root, "src/lib/instance-settings.ts")).href);
const effective = await import(pathToFileURL(path.join(root, "src/lib/effective-config.ts")).href);
const secrets = await import(pathToFileURL(path.join(root, "src/lib/server-secrets.ts")).href);
const prisma = await testPrisma(root, databaseUrl);

async function expectSettingsError(name, operation, status) {
  try {
    await operation();
    check(name, false, "operation unexpectedly succeeded");
  } catch (error) {
    check(
      name,
      error instanceof settings.InstanceSettingsError && error.status === status,
      String(error)
    );
  }
}

try {
  console.log("\nPublic-site settings\n");
  let site = await settings.getSiteSettingsStatus();
  check(
    "defaults are editable and safe",
    site.name.value === "My projects" &&
      site.tagline.source === "default" &&
      site.notesUrl.value === "/" &&
      !site.notesUrl.locked
  );

  site = await settings.saveSiteSettings({
    name: "Chris Projects",
    tagline: "Notes and experiments.",
    notesUrl: "https://notes.example.test/notebook",
  });
  check(
    "the owner can save all public-site fields",
    site.name.value === "Chris Projects" &&
      site.tagline.value === "Notes and experiments." &&
      site.notesUrl.value === "https://notes.example.test/notebook" &&
      Object.values(site).every((field) => field.source === "managed")
  );

  process.env.KEEL_SITE_NAME = "Environment Name";
  process.env.KEEL_SITE_TAGLINE = "   ";
  site = await settings.getSiteSettingsStatus();
  check(
    "nonempty env values override and lock only their field",
    site.name.value === "Environment Name" &&
      site.name.locked &&
      site.name.source === "environment" &&
      site.tagline.value === "Notes and experiments." &&
      !site.tagline.locked
  );
  await settings.saveSiteSettings({ tagline: "Still editable." });
  await expectSettingsError(
    "an env-locked site field cannot be saved",
    () => settings.saveSiteSettings({ name: "Browser override" }),
    409
  );
  delete process.env.KEEL_SITE_NAME;
  delete process.env.KEEL_SITE_TAGLINE;
  check(
    "removing an env override reveals the managed value",
    (await settings.getSiteSettingsStatus()).name.value === "Chris Projects"
  );
  await expectSettingsError(
    "unsafe Notes schemes are rejected",
    () => settings.saveSiteSettings({ notesUrl: "javascript:alert(1)" }),
    400
  );
  await expectSettingsError(
    "backslash-based protocol-relative Notes URLs are rejected",
    () => settings.saveSiteSettings({ notesUrl: "/\\evil.example.test" }),
    400
  );
  process.env.KEEL_NOTES_URL = "javascript:alert(1)";
  site = await settings.getSiteSettingsStatus();
  check(
    "an unsafe env Notes URL is locked but replaced by a safe fallback",
    site.notesUrl.locked && site.notesUrl.value === "/" && Boolean(site.notesUrl.warning)
  );
  delete process.env.KEEL_NOTES_URL;
  await expectSettingsError(
    "credential-bearing Notes URLs are rejected",
    () => settings.saveSiteSettings({ notesUrl: "https://user:pass@example.test/" }),
    400
  );
  await expectSettingsError(
    "unknown public-site fields are rejected",
    () => settings.saveSiteSettings({ unknown: "value" }),
    400
  );

  console.log("\nWrite-only scheduled-backup secret\n");
  let backup = await settings.getBackupPassphraseStatus();
  check(
    "an empty instance reports no backup passphrase",
    !backup.configured && backup.source === "none" && backup.available
  );
  backup = await settings.saveBackupPassphrase(managedPassphrase);
  check(
    "a saved passphrase reports only managed presence",
    backup.configured && backup.source === "managed" && backup.available && !backup.locked
  );
  check(
    "runtime backup resolution can use the managed passphrase",
    (await settings.resolveScheduledBackupPassphrase()) === managedPassphrase
  );
  const settingKey = secrets.serverSecretSettingKey("backup.scheduledPassphrase");
  let row = await prisma.appSetting.findUnique({ where: { key: settingKey } });
  check("the passphrase is stored as an encrypted server secret", Boolean(row?.value.includes('"alg":"A256GCM"')));
  check(
    "neither status nor ciphertext contains the plaintext passphrase",
    !JSON.stringify(backup).includes(managedPassphrase) && !String(row?.value).includes(managedPassphrase)
  );

  process.env.KEEL_BACKUP_PASSPHRASE = ` ${environmentPassphrase} `;
  backup = await settings.getBackupPassphraseStatus();
  check(
    "a nonempty env passphrase overrides and locks the managed value",
      backup.configured &&
      backup.source === "environment" &&
      backup.locked &&
      (await settings.resolveScheduledBackupPassphrase()) === ` ${environmentPassphrase} `
  );
  await expectSettingsError(
    "the env override locks managed saves",
    () => settings.saveBackupPassphrase("another managed passphrase"),
    409
  );
  await expectSettingsError(
    "the env override locks managed clears",
    () => settings.clearBackupPassphrase(),
    409
  );
  process.env.KEEL_BACKUP_PASSPHRASE = "   ";
  backup = await settings.getBackupPassphraseStatus();
  check(
    "a blank env value does not lock or replace the managed secret",
    backup.source === "managed" &&
      !backup.locked &&
      (await settings.resolveScheduledBackupPassphrase()) === managedPassphrase
  );
  delete process.env.KEEL_BACKUP_PASSPHRASE;

  row = await prisma.appSetting.update({
    where: { key: settingKey },
    data: { value: '{"v":1,"alg":"A256GCM","iv":"broken"}' },
  });
  backup = await settings.getBackupPassphraseStatus();
  check(
    "damaged ciphertext fails closed without exposing a value",
    backup.source === "managed" &&
      !backup.configured &&
      !backup.available &&
      (await settings.resolveScheduledBackupPassphrase()) === undefined
  );
  backup = await settings.clearBackupPassphrase();
  check("the owner can clear a damaged managed secret", backup.source === "none" && backup.available);
  await expectSettingsError(
    "short backup passphrases are rejected",
    () => settings.saveBackupPassphrase("too short"),
    400
  );

  console.log("\nRedacted effective configuration\n");
  process.env.DATABASE_URL =
    "postgresql://private-user:private-password@secret-db.internal/private-database";
  process.env.HOST = "private-bind.internal";
  process.env.KEEL_BACKUP_DIR = "/srv/keel/private-backups";
  process.env.KEEL_BACKUP_PASSPHRASE = environmentPassphrase;
  process.env.KEEL_PUBLIC_URL = "https://notes.example.test/private-path?token=hidden";
  const summary = effective.effectiveConfiguration();
  const serialized = JSON.stringify(summary);
  check("the effective summary reports only the database dialect", summary.database.dialect === "PostgreSQL");
  check("the effective summary reduces a custom bind address to a label", summary.network.bind === "custom");
  check(
    "the effective summary strips public URL paths and query values",
    summary.publicOrigin.value === "https://notes.example.test"
  );
  check(
    "the effective summary omits credentials, hostnames, paths, and passphrases",
    !serialized.includes("private-user") &&
      !serialized.includes("private-password") &&
      !serialized.includes("secret-db.internal") &&
      !serialized.includes("private-bind.internal") &&
      !serialized.includes("/srv/keel/private-backups") &&
      !serialized.includes(environmentPassphrase) &&
      !serialized.includes("token=hidden")
  );

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
    process.exitCode = 1;
  }
} finally {
  clearEnvironment();
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
}
