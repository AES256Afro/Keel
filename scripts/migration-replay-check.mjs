#!/usr/bin/env node
// Migration replay must never destroy data.
//
// Keel self-migrates on boot for installs with no Prisma CLI. The danger is
// not a migration that fails - that rolls back and is loud. It is a migration
// that *succeeds against a database it was never meant to run on*: SQLite has
// no ADD COLUMN for a foreign key, so Prisma rebuilds the table and copies
// only the columns that existed when the migration was authored. Replay it on
// a database that already has the newer columns and every statement returns
// success while the copy quietly drops the data it doesn't name.
//
// That is exactly what erased the record tree and every mind-map node
// position: the tree survived being written, then vanished on the next boot.
//
//   node --experimental-strip-types --no-warnings scripts/migration-replay-check.mjs
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { register } from "node:module";
import {
  cleanDatabase,
  ensureSqliteDatabaseFile,
  prepareDatabase,
  testDatabaseUrl,
} from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "migration-replay-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const FILE = DB_URL.replace(/^file:/, "");
// The stranded-seam and fresh-install sections run against their own files:
// their whole point is what a REAL `prisma migrate deploy` does to a database
// the self-migrator worked on, so they must not share state with the main one.
const STRANDED_NAME = "migration-replay-check-stranded";
const STRANDED_URL = testDatabaseUrl(root, STRANDED_NAME);
const STRANDED_FILE = STRANDED_URL.replace(/^file:/, "");
const FRESH_NAME = "migration-replay-check-fresh";
const FRESH_URL = testDatabaseUrl(root, FRESH_NAME);
const FRESH_FILE = FRESH_URL.replace(/^file:/, "");
const BOOTSTRAP_NAME = "migration-replay-check-bootstrap";
const BOOTSTRAP_URL = testDatabaseUrl(root, BOOTSTRAP_NAME);
const BOOTSTRAP_FILE = BOOTSTRAP_URL.replace(/^file:/, "");

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
};
const sqlAt = (file, q) => execFileSync("sqlite3", [file, q], { encoding: "utf8" }).trim();
const sql = (q) => sqlAt(FILE, q);

/**
 * Run something with the console captured, and never rethrow.
 *
 * Three of the defects below are about a migrator that decides to do nothing
 * and says nothing - so what the boot log contains IS the behaviour under test,
 * and "did it throw?" is the difference between a stranded init and a survivable
 * one. `check` logs, so the real console is restored before anything asserts.
 */
const captureConsole = async (fn) => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const spy = (...args) =>
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  console.log = spy;
  console.warn = spy;
  console.error = spy;
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    Object.assign(console, original);
  }
  return { out: lines.join("\n"), error };
};

/** Boot the self-migrator as if the app were installed at `dir`. */
const bootIn = async (dir) => {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await captureConsole(() => ensureSchema());
  } finally {
    process.chdir(cwd);
    await prisma.$disconnect();
  }
};

/** A throwaway install directory shipping exactly the given migrations. */
const fakeInstallWith = (prefix, migrations) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [name, body] of Object.entries(migrations)) {
    const migDir = path.join(dir, "prisma", "migrations", name);
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, "migration.sql"), body);
  }
  return dir;
};
const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Run a REAL `prisma migrate deploy` - the CLI itself, not a re-enactment.
const deploy = (schemaPath, dbUrl) => {
  ensureSqliteDatabaseFile(dbUrl);
  return spawnSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
};

cleanDatabase(root, DB_NAME);
cleanDatabase(root, STRANDED_NAME);
cleanDatabase(root, FRESH_NAME);
cleanDatabase(root, BOOTSTRAP_NAME);
console.log("\nPreparing scratch database…");
// `prisma db push` leaves the schema current and the ledger empty - the same
// shape as a restored snapshot or a pre-1.0 install. This is the state that
// used to trigger a full replay.
prepareDatabase(root, DB_URL);
process.env.DATABASE_URL = DB_URL;
register("./ts-loader.mjs", import.meta.url);

const { createFromTemplate } = await import(
  pathToFileURL(path.join(root, "src/lib/templates.ts")).href
);
const { prisma } = await import(pathToFileURL(path.join(root, "src/lib/prisma.ts")).href);
const schemaMigrateHref = pathToFileURL(path.join(root, "src/lib/schema-migrate.ts")).href;
const { ensureSchema, schemaStatus } = await import(schemaMigrateHref);

try {
  console.log("\nInstance-owner claim compatibility migration\n");
  {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-owner-claim-migration-")));
    const migrationSql = fs.readFileSync(
      path.join(root, "prisma", "migrations", "20260813000002_instance_owner_claim", "migration.sql"),
      "utf8"
    );
    const runMigration = (file) =>
      spawnSync("sqlite3", ["-bail", file], { input: migrationSql, encoding: "utf8" });
    const createTables = (file) =>
      sqlAt(
        file,
        `CREATE TABLE "AppSetting" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL);
         CREATE TABLE "Workspace" ("id" TEXT PRIMARY KEY NOT NULL, "ownerId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL);`
      );
    try {
      const fresh = path.join(dir, "fresh.db");
      createTables(fresh);
      const freshResult = runMigration(fresh);
      check("a fresh empty database remains unclaimed", freshResult.status === 0 && sqlAt(fresh, `SELECT COUNT(*) FROM "AppSetting";`) === "0");

      const single = path.join(dir, "single.db");
      createTables(single);
      sqlAt(
        single,
        `INSERT INTO "Workspace" ("id", "ownerId", "createdAt") VALUES
         ('a', 'only-user', '2026-01-01 00:00:00'),
         ('b', 'only-user', '2026-01-02 00:00:00');`
      );
      const singleResult = runMigration(single);
      check(
        "a single-user legacy instance preserves its only possible owner",
        singleResult.status === 0 &&
          sqlAt(single, `SELECT "value" FROM "AppSetting" WHERE "key"='instance.ownerUserId';`) === "only-user"
      );

      const multi = path.join(dir, "multi.db");
      createTables(multi);
      sqlAt(
        multi,
        `INSERT INTO "Workspace" ("id", "ownerId", "createdAt") VALUES
         ('z', 'second-user', '2026-01-01 00:00:00'),
         ('a', 'first-user', '2026-01-01 00:00:00');`
      );
      const multiResult = runMigration(multi);
      check(
        "a multi-user legacy instance stays unclaimed instead of guessing the operator",
        multiResult.status === 0 &&
          sqlAt(multi, `SELECT COUNT(*) FROM "AppSetting" WHERE "key"='instance.ownerUserId';`) === "0"
      );

      const claimed = path.join(dir, "claimed.db");
      createTables(claimed);
      sqlAt(
        claimed,
        `INSERT INTO "Workspace" ("id", "ownerId", "createdAt") VALUES ('a', 'oldest-user', '2025-01-01');
         INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES ('instance.ownerUserId', 'explicit-user', CURRENT_TIMESTAMP);`
      );
      const claimedResult = runMigration(claimed);
      check(
        "the compatibility migration never replaces an explicit claim",
        claimedResult.status === 0 &&
          sqlAt(claimed, `SELECT "value" FROM "AppSetting" WHERE "key"='instance.ownerUserId';`) === "explicit-user"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nGoogle identity uniqueness migration fails closed\n");
  {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-google-id-migration-")));
    const migrationSql = fs.readFileSync(
      path.join(
        root,
        "prisma",
        "migrations",
        "20260813000001_google_identity_unique",
        "migration.sql"
      ),
      "utf8"
    );
    const runMigration = (file) =>
      spawnSync("sqlite3", ["-bail", file], { input: migrationSql, encoding: "utf8" });
    const createUserTable = (file) =>
      sqlAt(file, 'CREATE TABLE "User" ("id" TEXT PRIMARY KEY NOT NULL, "googleId" TEXT);');

    try {
      const empty = path.join(dir, "empty.db");
      createUserTable(empty);
      const emptyResult = runMigration(empty);
      check(
        "an empty User table accepts the Google identity constraint",
        emptyResult.status === 0,
        emptyResult.stderr.trim()
      );
      check(
        "the empty migration creates the unique index",
        sqlAt(empty, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='User_googleId_key';`) === "1"
      );

      const normal = path.join(dir, "normal.db");
      createUserTable(normal);
      sqlAt(
        normal,
        `INSERT INTO "User" ("id", "googleId") VALUES
         ('a', 'google-subject-a'), ('b', 'google-subject-b'), ('c', NULL);`
      );
      const normalResult = runMigration(normal);
      check(
        "distinct and null Google links migrate normally",
        normalResult.status === 0,
        normalResult.stderr.trim()
      );
      check(
        "the normal migration preserves every link",
        sqlAt(normal, `SELECT COUNT(*) FROM "User";`) === "3" &&
          sqlAt(normal, `SELECT COUNT(*) FROM "User" WHERE "googleId" IS NOT NULL;`) === "2"
      );

      const duplicate = path.join(dir, "duplicate.db");
      createUserTable(duplicate);
      sqlAt(
        duplicate,
        `INSERT INTO "User" ("id", "googleId") VALUES
         ('a', 'shared-google-subject'), ('b', 'shared-google-subject');`
      );
      const duplicateResult = runMigration(duplicate);
      check("duplicate legacy links block the migration", duplicateResult.status !== 0);
      check(
        "the blocked migration gives an actionable diagnostic",
        duplicateResult.stderr.includes(
          "Keel migration blocked duplicate non-null User.googleId links exist resolve before upgrade"
        ),
        duplicateResult.stderr.trim()
      );
      check(
        "the blocked migration leaves both account links untouched",
        sqlAt(
          duplicate,
          `SELECT COUNT(*) FROM "User" WHERE "googleId" = 'shared-google-subject';`
        ) === "2"
      );
      check(
        "the blocked migration does not create a misleading unique index",
        sqlAt(duplicate, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='User_googleId_key';`) === "0"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const user = await prisma.user.create({
    data: { email: "m@example.test", name: "M", username: "m", passwordHash: "x" },
  });
  const ws = await prisma.workspace.create({
    data: { name: "M", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });
  await createFromTemplate("mind-map", { workspaceId: ws.id, userId: user.id });

  // Node positions too: the same copy that drops parentRecordId drops these.
  const [first] = await prisma.databaseRecord.findMany({ take: 1, orderBy: { sortOrder: "asc" } });
  await prisma.databaseRecord.update({
    where: { id: first.id },
    data: { mapX: 123, mapY: 456, collapsed: true },
  });
  await prisma.$disconnect();

  const before = {
    records: Number(sql("select count(*) from DatabaseRecord;")),
    parented: Number(sql("select count(*) from DatabaseRecord where parentRecordId is not null;")),
    placed: Number(sql("select count(*) from DatabaseRecord where mapX is not null;")),
    collapsed: Number(sql("select count(*) from DatabaseRecord where collapsed = 1;")),
    ledger: sql("select count(*) from sqlite_master where name='_keel_migrations';"),
  };

  console.log("\nA database whose schema is ahead of its ledger\n");
  check("starts with a real record tree", before.parented > 0, `${before.parented} parented`);
  check("starts with a placed node", before.placed === 1);
  check("has no migration ledger yet", before.ledger === "0");

  console.log("\nBooting the self-migrator over it\n");
  await ensureSchema();
  await prisma.$disconnect();

  const after = {
    records: Number(sql("select count(*) from DatabaseRecord;")),
    parented: Number(sql("select count(*) from DatabaseRecord where parentRecordId is not null;")),
    placed: Number(sql("select count(*) from DatabaseRecord where mapX is not null;")),
    collapsed: Number(sql("select count(*) from DatabaseRecord where collapsed = 1;")),
    applied: Number(sql("select count(*) from _keel_migrations;")),
  };

  check("every record survives", after.records === before.records, `${after.records}/${before.records}`);
  check(
    "the record tree survives - parents are not reset to NULL",
    after.parented === before.parented,
    `${after.parented}/${before.parented} parented`
  );
  check("mind-map positions survive", after.placed === before.placed, `${after.placed}/${before.placed}`);
  check("collapsed state survives", after.collapsed === before.collapsed);
  check("the ledger adopts the shipped migrations", after.applied > 0, `${after.applied} recorded`);

  console.log("\nAnd booting again is still a no-op\n");
  await ensureSchema();
  await prisma.$disconnect();
  check(
    "a second boot changes nothing",
    Number(sql("select count(*) from DatabaseRecord where parentRecordId is not null;")) === before.parented
  );

  console.log("\nA genuinely older database still gets migrated\n");
  {
    // Strip the tree columns back off, as a pre-tree install would have them,
    // and confirm the migration is applied rather than skipped.
    sql(
      `CREATE TABLE "old_DatabaseRecord" ("id" TEXT PRIMARY KEY, "databaseId" TEXT NOT NULL,
       "pageId" TEXT NOT NULL, "sortOrder" REAL NOT NULL DEFAULT 0,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
       INSERT INTO "old_DatabaseRecord" SELECT "id","databaseId","pageId","sortOrder","createdAt","updatedAt" FROM "DatabaseRecord";
       DROP TABLE "DatabaseRecord";
       ALTER TABLE "old_DatabaseRecord" RENAME TO "DatabaseRecord";
       DELETE FROM "_keel_migrations";`
    );
    check("the column is really gone", !sql("pragma table_info(DatabaseRecord);").includes("parentRecordId"));
    // The rebuild's DROP TABLE is where round 9's HIGH lived: run through
    // prisma.$transaction, `PRAGMA foreign_keys=OFF` was silently ignored, so
    // ON DELETE CASCADE emptied DatabaseValue while the migration reported
    // success. The value count crossing the replay is the regression guard.
    const valuesBefore = Number(sql("select count(*) from DatabaseValue;"));
    check("cell values exist going in", valuesBefore > 0, `${valuesBefore} values`);
    await ensureSchema();
    await prisma.$disconnect();
    check(
      "the self-migrator adds it back",
      sql("pragma table_info(DatabaseRecord);").includes("parentRecordId")
    );
    check(
      "and the rows are carried across",
      Number(sql("select count(*) from DatabaseRecord;")) === before.records
    );
    check(
      "and the table rebuild does NOT cascade-wipe cell values",
      Number(sql("select count(*) from DatabaseValue;")) === valuesBefore,
      `${sql("select count(*) from DatabaseValue;")}/${valuesBefore} survive`
    );
  }

  console.log("\nA partially-ahead database is refused, not quietly emptied\n");
  {
    // Behind on the record-tree migration, but carrying a column the rebuild's
    // copy list does not name - the shape a restore or a hand-repaired schema
    // produces. Applying the rebuild here would drop that column.
    sql(
      `CREATE TABLE "part_DatabaseRecord" ("id" TEXT PRIMARY KEY, "databaseId" TEXT NOT NULL,
       "pageId" TEXT NOT NULL, "sortOrder" REAL NOT NULL DEFAULT 0,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
       "localOnlyNote" TEXT);
       INSERT INTO "part_DatabaseRecord" SELECT "id","databaseId","pageId","sortOrder","createdAt","updatedAt",'keep me' FROM "DatabaseRecord";
       DROP TABLE "DatabaseRecord";
       ALTER TABLE "part_DatabaseRecord" RENAME TO "DatabaseRecord";
       DELETE FROM "_keel_migrations";`
    );
    const before = Number(sql(`select count(*) from DatabaseRecord where localOnlyNote = 'keep me';`));
    check("the unknown column starts populated", before > 0, `${before} rows`);
    await ensureSchema();
    await prisma.$disconnect();
    check(
      "the column the rebuild would have dropped is still there",
      Number(sql(`select count(*) from DatabaseRecord where localOnlyNote = 'keep me';`)) === before
    );
    check(
      "and it stopped rather than applying the destructive migration",
      !sql("pragma table_info(DatabaseRecord);").includes("parentRecordId")
    );
  }

  console.log("\nA constraint-only rebuild is applied, not silently adopted\n");
  {
    // The trap: a rebuild that adds no table, no column and no index - its
    // only change is a FOREIGN KEY action. Every target alreadySatisfied()
    // checks is present on a database that is genuinely one migration behind,
    // so the old check recorded the migration WITHOUT running it, and
    // self-managed installs silently diverged from CLI-managed ones on
    // ON DELETE behaviour. The FK-set comparison is what closes that; this
    // section is what proves it stays closed.
    sql(
      `CREATE TABLE "FkParent" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TABLE "FkProbe" ("id" TEXT NOT NULL PRIMARY KEY, "parentId" TEXT,
         CONSTRAINT "FkProbe_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FkParent" ("id") ON DELETE NO ACTION ON UPDATE CASCADE);
       INSERT INTO "FkParent" VALUES ('p1');
       INSERT INTO "FkProbe" VALUES ('r1', 'p1');
       CREATE TABLE "ReplayMarker" ("id" TEXT NOT NULL PRIMARY KEY);`
    );

    // A fake install dir so ensureSchema sees ONLY these two migrations.
    const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), "keel-fk-rebuild-"));
    const shipMigration = (name, migrationSql) => {
      const dir = path.join(fakeInstall, "prisma", "migrations", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "migration.sql"), migrationSql);
    };
    const rebuild = (onDelete, marker) => `-- Constraint-only rebuild: same columns, different FK action.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FkProbe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentId" TEXT,
    CONSTRAINT "FkProbe_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FkParent" ("id") ON DELETE ${onDelete} ON UPDATE CASCADE
);
INSERT INTO "new_FkProbe" ("id", "parentId") SELECT "id", "parentId" FROM "FkProbe";
DROP TABLE "FkProbe";
ALTER TABLE "new_FkProbe" RENAME TO "FkProbe";
INSERT INTO "ReplayMarker" ("id") VALUES ('${marker}');
PRAGMA foreign_keys=ON;
`;
    // First: NO ACTION → CASCADE. Nothing but the constraint changes, so it
    // MUST be executed, not adopted. Second: identical to the table the first
    // one produces - the FK sets match, so adoption is correct and its marker
    // must never run (that direction protects the adopt path from regressing
    // into replay-everything, which is what destroys data).
    shipMigration(
      "20990101000000_fk_only_rebuild",
      rebuild("CASCADE", "changed-fk-ran")
    );
    shipMigration(
      "20990102000000_fk_identical_rebuild",
      rebuild("CASCADE", "identical-ran")
    );

    const cwd = process.cwd();
    try {
      process.chdir(fakeInstall);
      await ensureSchema();
    } finally {
      process.chdir(cwd);
      await prisma.$disconnect();
      fs.rmSync(fakeInstall, { recursive: true, force: true });
    }

    check(
      "the FK-changing rebuild really ran - ON DELETE is now CASCADE",
      sql(`select "on_delete" from pragma_foreign_key_list('FkProbe');`) === "CASCADE",
      sql(`select "on_delete" from pragma_foreign_key_list('FkProbe');`)
    );
    check(
      "…because it was executed, not just recorded",
      sql(`select count(*) from ReplayMarker where id='changed-fk-ran';`) === "1"
    );
    check("the rows were carried across the rebuild", sql(`select count(*) from FkProbe;`) === "1");
    check(
      "both rebuilds land in the ledger",
      sql(`select count(*) from _keel_migrations where name like '2099%';`) === "2"
    );
    check(
      "the identical rebuild was adopted, not replayed",
      sql(`select count(*) from ReplayMarker where id='identical-ran';`) === "0"
    );
  }

  console.log("\nThe reverse seam: a Docker-created ledger moved into a CLI install\n");
  {
    // A database that grew up under `prisma migrate deploy` carries
    // `_prisma_migrations` - and used to make ensureSchema defer FOREVER,
    // even in an install with no entrypoint and no Prisma CLI (`keel import`
    // of a file copied out of a Docker volume). The rule now: defer only
    // while nothing shipped is missing from both ledgers; a migration in
    // NEITHER ledger proves no CLI ran this boot, so the history is adopted
    // and the missing migrations are applied through the ordinary path.
    const shippedNames = fs
      .readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    // Reset the record table to the genuine pre-tree shape (the stray column
    // from the partial-ahead section would rightly trip the destroy guard),
    // drop the keel ledger, and fabricate the Docker ledger: every shipped
    // migration applied, exactly what `migrate deploy` leaves behind.
    sql(
      `ALTER TABLE "DatabaseRecord" DROP COLUMN "localOnlyNote";
       DROP TABLE IF EXISTS "_keel_migrations";
       CREATE TABLE "_prisma_migrations" (
         "id" TEXT PRIMARY KEY NOT NULL,
         "checksum" TEXT NOT NULL,
         "finished_at" DATETIME,
         "migration_name" TEXT NOT NULL,
         "logs" TEXT,
         "rolled_back_at" DATETIME,
         "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
         "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
       );`
    );
    for (const name of shippedNames) {
      sql(
        `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count")
         VALUES (lower(hex(randomblob(16))), 'x', datetime('now'), '${name}', 1);`
      );
    }

    // Current ledger → still CLI-managed territory: hands off. (In Docker,
    // deploy runs before boot, so a current ledger is the every-boot case -
    // this is the two-writers guarantee staying intact.)
    await ensureSchema();
    await prisma.$disconnect();
    check(
      "a current CLI ledger still means hands off - no keel ledger appears",
      sql(`select count(*) from sqlite_master where name='_keel_migrations';`) === "0"
    );
    check(
      "…and the schema is untouched",
      !sql("pragma table_info(DatabaseRecord);").includes("parentRecordId")
    );

    // Now the import scenario: the file left Docker before the record-tree
    // migration shipped, so the prisma ledger is genuinely behind and nothing
    // in this install will ever run deploy.
    sql(`DELETE FROM "_prisma_migrations" WHERE migration_name >= '20260803000002';`);
    const recordsBefore = Number(sql("select count(*) from DatabaseRecord;"));
    await ensureSchema();
    await prisma.$disconnect();
    check(
      "a behind CLI ledger is adopted - the pending migration really applies",
      sql("pragma table_info(DatabaseRecord);").includes("parentRecordId")
    );
    check(
      "…rows survive the takeover",
      Number(sql("select count(*) from DatabaseRecord;")) === recordsBefore,
      `${sql("select count(*) from DatabaseRecord;")}/${recordsBefore}`
    );
    check(
      "…the CLI's history is carried into the keel ledger",
      sql(`select count(*) from _keel_migrations where name='0_init';`) === "1"
    );
    check(
      "…and every shipped migration ends up recorded",
      Number(sql(`select count(*) from _keel_migrations where name in (${shippedNames.map((n) => `'${n}'`).join(",")});`)) ===
        shippedNames.length,
      `${sql(`select count(*) from _keel_migrations where name in (${shippedNames.map((n) => `'${n}'`).join(",")});`)}/${shippedNames.length}`
    );

    // And the boot after the takeover is quiet again.
    const ledgerAfter = sql("select count(*) from _keel_migrations;");
    await ensureSchema();
    await prisma.$disconnect();
    check(
      "a second boot after adoption changes nothing",
      sql("select count(*) from _keel_migrations;") === ledgerAfter
    );
  }

  console.log("\nA packaging shape with no prisma/migrations is loud, not silent\n");
  {
    // The shape that ships today: scripts/desktop-build.mjs copies
    // prisma/schema.sql into the standalone bundle but not prisma/migrations,
    // so a packaged desktop install boots with no migration set at all. From
    // inside ensureSchema that is indistinguishable from "nothing to do" - the
    // database may be a release behind and every path no-ops. The boot log is
    // the only thing standing between that and a column-not-found error weeks
    // later with nothing pointing at why.
    const emptyInstall = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-no-migrations-")));
    let out, error;
    try {
      ({ out, error } = await bootIn(emptyInstall));
    } finally {
      fs.rmSync(emptyInstall, { recursive: true, force: true });
    }
    check(
      "a missing migration set does not throw - init must not be stranded by it",
      !error,
      error ? String(error.message) : ""
    );
    check("…the boot log says no shipped migrations were found", /NO SHIPPED MIGRATIONS FOUND/.test(out), out.slice(0, 100));
    check(
      "…and names the paths it searched",
      out.includes(path.join(emptyInstall, "prisma", "migrations"))
    );
    check(
      "…and warns that the schema will not be migrated",
      /will not migrate it/.test(out) && /up to date/.test(out)
    );
  }

  console.log("\nAn empty database carrying _prisma_migrations, in an install with no migrations\n");
  {
    // The packaged-desktop shape (schema.sql copied, prisma/migrations not)
    // pointed at a database left behind by a `prisma migrate deploy` that died
    // on its first migration: the file carries `_prisma_migrations` and has no
    // schema. Nothing shipped makes "missing" empty by arithmetic rather than
    // by evidence, and the CLI-managed branch used to take that as proof the
    // CLI had it covered: it returned "all 0 shipped migrations recorded -
    // leaving the schema to the CLI migrator" - on an install with no CLI -
    // and skipped the schema.sql bootstrap, so the app served an empty
    // database while Settings showed a reassuring line.
    const install = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-bootstrap-")));
    try {
      fs.mkdirSync(path.join(install, "prisma"), { recursive: true });
      fs.copyFileSync(
        path.join(root, "prisma", "schema.sql"),
        path.join(install, "prisma", "schema.sql")
      );
      // What a deploy that failed on its first migration leaves: the ledger,
      // one unfinished row, and no tables of its own.
      sqlAt(
        BOOTSTRAP_FILE,
        `CREATE TABLE "_prisma_migrations" (
           "id" TEXT PRIMARY KEY NOT NULL,
           "checksum" TEXT NOT NULL,
           "finished_at" DATETIME,
           "migration_name" TEXT NOT NULL,
           "logs" TEXT,
           "rolled_back_at" DATETIME,
           "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
           "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
         );
         INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","applied_steps_count")
         VALUES (lower(hex(randomblob(16))), 'x', '0_init', 0);`
      );
      check(
        "the database starts empty apart from the CLI ledger",
        sqlAt(BOOTSTRAP_FILE, `select count(*) from sqlite_master where name='User';`) === "0"
      );

      const runner = path.join(install, "run-ensure.mjs");
      fs.writeFileSync(
        runner,
        `import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
register(pathToFileURL(path.join(root, "scripts", "ts-loader.mjs")));
const { ensureSchema, schemaStatus } = await import(pathToFileURL(path.join(root, "src", "lib", "schema-migrate.ts")).href);
const { prisma } = await import(pathToFileURL(path.join(root, "src", "lib", "prisma.ts")).href);
await ensureSchema();
console.log("STATUS " + JSON.stringify(schemaStatus()));
await prisma.$disconnect();
`
      );
      const boot = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", runner, root],
        { cwd: install, env: { ...process.env, DATABASE_URL: BOOTSTRAP_URL }, encoding: "utf8" }
      );
      const out = `${boot.stdout}${boot.stderr}`;
      const status = JSON.parse(/STATUS (\{.*\})/.exec(out)?.[1] ?? "{}");
      check(
        "it bootstraps rather than deferring - the schema really is created",
        boot.status === 0 &&
          sqlAt(BOOTSTRAP_FILE, `select count(*) from sqlite_master where name='User';`) === "1",
        boot.status === 0 ? out.slice(-200) : (boot.stderr || boot.stdout || "").trim().slice(-300)
      );
      check(
        "…and never claims a CLI migrator has an install with no CLI covered",
        !/leaving the schema to the CLI migrator/.test(out),
        out.slice(0, 200)
      );
      check(
        "…the recorded status is not 'deferred'",
        status.state === "current",
        JSON.stringify(status)
      );
      check(
        "…and it still says the migration set was missing, since that is unverifiable",
        /no shipped migrations were found/.test(status.detail ?? ""),
        status.detail
      );
      check(
        "…without fabricating applied rows in the CLI ledger",
        sqlAt(
          BOOTSTRAP_FILE,
          `select count(*) from _prisma_migrations where finished_at is not null;`
        ) === "0"
      );
      check(
        "…and a second boot is a quiet no-op, not a re-bootstrap",
        (() => {
          const rows = sqlAt(BOOTSTRAP_FILE, `select count(*) from sqlite_master;`);
          const again = spawnSync(
            process.execPath,
            ["--experimental-strip-types", "--no-warnings", runner, root],
            { cwd: install, env: { ...process.env, DATABASE_URL: BOOTSTRAP_URL }, encoding: "utf8" }
          );
          return (
            again.status === 0 && sqlAt(BOOTSTRAP_FILE, `select count(*) from sqlite_master;`) === rows
          );
        })()
      );
    } finally {
      fs.rmSync(install, { recursive: true, force: true });
    }
  }

  console.log("\nKEEL_SELF_MIGRATE=0 defers on BOTH ledger shapes, and states its reason\n");
  {
    // The flag means "an external migrator owns this schema". It used to be
    // read only inside the `_prisma_migrations` branch, so on a self-managed
    // database - every non-Docker install - it was silently a no-op and this
    // module migrated anyway: the two-writers situation the flag exists to
    // prevent. And when it WAS honoured it returned in silence, so an external
    // deploy that never ran left the schema falling behind with no breadcrumb.
    const probe = "20990301000000_defer_probe";
    const install = fakeInstallWith("keel-defer-", {
      [probe]: `CREATE TABLE "DeferProbe" (\n    "id" TEXT NOT NULL PRIMARY KEY\n);\n`,
    });
    const probeTables = () => sql(`select count(*) from sqlite_master where name='DeferProbe';`);
    try {
      process.env.KEEL_SELF_MIGRATE = "0";

      // Shape 1: `_prisma_migrations` present - the branch that already honoured it.
      const cli = await bootIn(install);
      check("with a CLI ledger present, the pending migration is not applied", probeTables() === "0");
      check(
        "…and the deferral names the flag and what it is leaving undone",
        /KEEL_SELF_MIGRATE=0/.test(cli.out) && cli.out.includes(probe),
        cli.out.slice(0, 120)
      );

      // Shape 2: no `_prisma_migrations` at all - where the flag was ignored.
      sql(`DROP TABLE "_prisma_migrations";`);
      const selfManaged = await bootIn(install);
      check("with no CLI ledger, the flag is honoured too - nothing is applied", probeTables() === "0");
      check(
        "…and that deferral states its reason as well",
        /KEEL_SELF_MIGRATE=0/.test(selfManaged.out) && selfManaged.out.includes(probe),
        selfManaged.out.slice(0, 120)
      );
    } finally {
      delete process.env.KEEL_SELF_MIGRATE;
    }

    // Control, so neither green tick above can be vacuous: the flag was the
    // only thing stopping a migration that genuinely applies.
    const control = await bootIn(install);
    check(
      "control: without the flag the same migration really does apply",
      probeTables() === "1",
      control.error ? String(control.error.message) : ""
    );
    fs.rmSync(install, { recursive: true, force: true });
  }

  console.log("\nA failed ledger mirror does not strand the migrations behind it\n");
  {
    // The mirror writes on the adopt path had no error handling: one
    // SQLITE_BUSY - from exactly the concurrent-deploy race the mirror defends
    // against - threw out of ensureSchema, skipping every later migration, and
    // initServerOnce caches the failure, so nothing retried and the process
    // served a behind schema (and no WAL, no backups) until a restart.
    const first = "20990401000000_mirror_a";
    const second = "20990402000000_mirror_b";
    const table = (name) => `CREATE TABLE "${name}" (\n    "id" TEXT NOT NULL PRIMARY KEY\n);\n`;
    const install = fakeInstallWith("keel-mirror-", {
      [first]: table("MirrorA"),
      [second]: table("MirrorB"),
    });
    // Both tables already exist, so both migrations take the adopt path - the
    // one the mirror lives on - and a trigger fails the first one's mirror the
    // way a busy database would: transiently, and only for that row.
    sql(
      `CREATE TABLE "MirrorA" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TABLE "MirrorB" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TABLE "_prisma_migrations" (
         "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
         "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
         "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
         "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
       );
       CREATE TRIGGER "mirror_boom" BEFORE INSERT ON "_prisma_migrations"
         WHEN NEW."migration_name" = '${first}'
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`
    );
    const keelRow = (name) => sql(`select count(*) from _keel_migrations where name='${name}';`);
    const cliRow = (name) =>
      sql(`select count(*) from _prisma_migrations where migration_name='${name}' and finished_at is not null and rolled_back_at is null;`);

    const boom = await bootIn(install);
    check(
      "a mirror failure does not throw out of ensureSchema",
      !boom.error,
      boom.error ? String(boom.error.message) : ""
    );
    check(
      "…it is reported, naming the migration",
      boom.out.includes(first) && /could not be mirrored/.test(boom.out),
      boom.out.slice(0, 120)
    );
    check("…the migration behind it is still adopted", keelRow(second) === "1");
    check("…and still mirrored into the CLI ledger", cliRow(second) === "1");
    check(
      "…while the failed one stays out of BOTH ledgers, so the next boot retries",
      keelRow(first) === "0" && cliRow(first) === "0"
    );

    sql(`DROP TRIGGER "mirror_boom";`);
    await bootIn(install);
    check(
      "…and once the transient failure clears, the next boot records it",
      keelRow(first) === "1" && cliRow(first) === "1"
    );
    fs.rmSync(install, { recursive: true, force: true });
  }

  console.log("\nA failed keel-ledger write does not strand them either\n");
  {
    // The round-12 fix guarded the mirror writes and stopped one statement
    // short: the `_keel_migrations` INSERT standing right beside them was still
    // bare, though it is the same kind of write against the same locked file on
    // the same client. One SQLITE_BUSY there threw out of ensureSchema exactly
    // as the mirror's used to - skipping every later migration, and (because
    // initServerOnce memoizes the rejection) leaving the process with no WAL,
    // no backfill and no automatic backups until someone restarted it. The
    // regression test above could never have caught it: its trigger fires on
    // `_prisma_migrations` only.
    const first = "20990501000000_keelrow_a";
    const second = "20990502000000_keelrow_b";
    const table = (name) => `CREATE TABLE "${name}" (\n    "id" TEXT NOT NULL PRIMARY KEY\n);\n`;
    const install = fakeInstallWith("keel-keelrow-", {
      [first]: table("KeelRowA"),
      [second]: table("KeelRowB"),
    });
    // Both tables already exist, so both migrations take the adopt path - the
    // one that ends in the keel-ledger write - and a trigger fails the first
    // one's write the way a busy database would: transiently, for that row.
    sql(
      `CREATE TABLE "KeelRowA" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TABLE "KeelRowB" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TRIGGER "keelrow_boom" BEFORE INSERT ON "_keel_migrations"
         WHEN NEW."name" = '${first}'
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`
    );
    const keelRow = (name) => sql(`select count(*) from _keel_migrations where name='${name}';`);
    const cliRow = (name) =>
      sql(`select count(*) from _prisma_migrations where migration_name='${name}' and finished_at is not null and rolled_back_at is null;`);

    const boom = await bootIn(install);
    check(
      "a keel-ledger failure does not throw out of ensureSchema",
      !boom.error,
      boom.error ? String(boom.error.message) : ""
    );
    check(
      "…it is reported, naming the migration",
      boom.out.includes(first) && /could not be recorded/.test(boom.out),
      boom.out.slice(0, 120)
    );
    check("…the migration behind it is still adopted", keelRow(second) === "1");
    check("…and still mirrored into the CLI ledger", cliRow(second) === "1");
    check(
      "…while the failed one stays out of _keel_migrations, so the next boot retries",
      keelRow(first) === "0"
    );
    check(
      "…and the boot says so rather than claiming the schema is up to date",
      schemaStatus().state === "failed" && /could not be recorded this boot/.test(schemaStatus().detail),
      `${schemaStatus().state}: ${schemaStatus().detail.slice(0, 80)}`
    );

    // What "the next boot retries" means here is worth pinning exactly, because
    // the mirror ran BEFORE the write that failed. On a CLI-managed file that
    // leaves the migration recorded in `_prisma_migrations` and absent from
    // `_keel_migrations`, so the next boot sees nothing missing from both
    // ledgers and defers - the ordinary hands-off branch. That is the safe end
    // state, not a stranding: the ledger a stray `prisma migrate deploy` reads
    // is the complete one, so the replay this module exists to prevent still
    // cannot happen, and nothing pending is skipped (deferring here requires
    // that nothing IS pending).
    sql(`DROP TRIGGER "keelrow_boom";`);
    const quiet = await bootIn(install);
    check(
      "…the boot after that is a safe no-op - the ledger a stray deploy reads already has it",
      cliRow(first) === "1" &&
        sql(`select count(*) from _prisma_migrations where migration_name='${first}';`) === "1" &&
        /leaving the schema to the CLI migrator/.test(quiet.out),
      quiet.out.slice(0, 120)
    );

    // …and the short keel ledger is not permanent either: the next release that
    // genuinely has something to do takes the database over again, and the
    // takeover's adoption loop carries the CLI's history across wholesale.
    const third = "20990503000000_keelrow_c";
    const thirdDir = path.join(install, "prisma", "migrations", third);
    fs.mkdirSync(thirdDir, { recursive: true });
    fs.writeFileSync(path.join(thirdDir, "migration.sql"), table("KeelRowC"));
    const repair = await bootIn(install);
    check(
      "…and the next shipped migration repairs the keel ledger while applying itself",
      keelRow(first) === "1" && keelRow(third) === "1" &&
        sql(`select count(*) from sqlite_master where name='KeelRowC';`) === "1",
      `keel ${keelRow(first)}, ${keelRow(third)}; ${repair.error ? repair.error.message : ""}`
    );
    check(
      "…and the status reports current again",
      schemaStatus().state === "current",
      `${schemaStatus().state}: ${schemaStatus().detail.slice(0, 80)}`
    );
    fs.rmSync(install, { recursive: true, force: true });

    // And the same failure on the shape every non-Docker install has: no
    // `_prisma_migrations` at all, so the keel row is the ONLY ledger write and
    // "the next boot retries" is literal. This is the shape where the stranding
    // cost the most, too - a self-managed install has no entrypoint to repair
    // anything, so the cached rejection meant no WAL, no backfill and no
    // automatic backups until a human happened to restart it.
    const soloFirst = "20990601000000_solo_a";
    const soloSecond = "20990602000000_solo_b";
    const solo = fakeInstallWith("keel-solo-", {
      [soloFirst]: table("SoloA"),
      [soloSecond]: table("SoloB"),
    });
    sql(
      `DROP TABLE "_prisma_migrations";
       CREATE TABLE "SoloA" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TABLE "SoloB" ("id" TEXT NOT NULL PRIMARY KEY);
       CREATE TRIGGER "solo_boom" BEFORE INSERT ON "_keel_migrations"
         WHEN NEW."name" = '${soloFirst}'
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`
    );
    const soloBoom = await bootIn(solo);
    check(
      "a self-managed install survives it too, and still adopts the migration behind it",
      !soloBoom.error && keelRow(soloSecond) === "1" && keelRow(soloFirst) === "0",
      soloBoom.error ? String(soloBoom.error.message) : `${keelRow(soloFirst)}/${keelRow(soloSecond)}`
    );
    sql(`DROP TRIGGER "solo_boom";`);
    await bootIn(solo);
    check(
      "…and with no CLI ledger to have recorded it, the next boot really does re-adopt it",
      keelRow(soloFirst) === "1" && schemaStatus().state === "current",
      `${schemaStatus().state}: ${schemaStatus().detail.slice(0, 80)}`
    );
    fs.rmSync(solo, { recursive: true, force: true });
  }

  console.log("\nThe last decision survives Next's per-graph module duplication\n");
  {
    // schemaStatus() used to be a plain module binding while the init once-flag
    // lives on globalThis. Next compiles this file into more than one module
    // graph (it appears in the build output as both `schema-migrate.ts
    // [app-rsc]` and `schema-migrate.ts [app-route]`), so the copy that lost the
    // race to run ensureSchema kept its seed value FOREVER - the once-flag
    // guarantees it never runs again. Settings renders in the RSC copy, so an
    // API request arriving first made the panel tell the owner "cannot verify
    // the schema … has not run yet" on a healthy install, and swallow the real
    // detail when a migration had genuinely failed.
    //
    // A query string makes Node instantiate the module a second time - the same
    // duplication, reproduced honestly rather than described.
    const otherCopy = await import(`${schemaMigrateHref}?graph=rsc`);
    check(
      "the second import really is a separate module instance",
      otherCopy.schemaStatus !== schemaStatus
    );
    const shared = globalThis.__keelSchemaStatus;
    check(
      "the boot above wrote its decision somewhere both copies can see it",
      Boolean(shared) && shared.detail === schemaStatus().detail,
      shared ? shared.state : "nothing on globalThis"
    );
    check(
      "…so the copy that never ran ensureSchema reports the real answer, not the seed",
      otherCopy.schemaStatus().detail === schemaStatus().detail &&
        !/has not run yet/.test(otherCopy.schemaStatus().detail),
      otherCopy.schemaStatus().detail.slice(0, 80)
    );
    // And the other direction: a failure recorded by whichever copy the request
    // happened to reach must reach the copy Settings renders in.
    globalThis.__keelSchemaStatus = {
      state: "failed",
      detail: "recorded by the other module graph",
      at: new Date().toISOString(),
    };
    check(
      "…and a failure recorded in one copy is what the other one shows",
      otherCopy.schemaStatus().detail === "recorded by the other module graph" &&
        schemaStatus().state === "failed"
    );
    check(
      "…as a copy, so a caller cannot mutate the recorded decision",
      ((s) => {
        s.detail = "tampered";
        return schemaStatus().detail === "recorded by the other module graph";
      })(schemaStatus())
    );
    globalThis.__keelSchemaStatus = shared;
  }

  console.log("\nThe stranded seam: a real `prisma migrate deploy` after a self-migrated takeover\n");
  {
    // Round 10 taught ensureSchema to take over a CLI-managed database whose
    // ledger is behind. The defect this section pins: the takeover recorded
    // its work only in `_keel_migrations`, so the CLI still believed those
    // migrations were pending - and `npm run db:deploy` (README documents it;
    // install.sh re-runs invoke it) made the REAL `prisma migrate deploy`
    // replay them. A replayed table rebuild copies only the columns its
    // frozen list names and silently drops the rest: rounds 8-10's data-loss
    // class, reopened through the seam between the two ledgers. The fix
    // mirrors every migration the self-migrator applies or adopts into
    // `_prisma_migrations` whenever that table exists; this section drives
    // the actual CLI over the result to prove it sees nothing to do.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel-stranded-"));
    try {
      // A genuinely CLI-migrated database - created by the real deploy, so
      // its ledger rows are Prisma's own, not a test's idea of them.
      const born = deploy(path.join(root, "prisma", "schema.prisma"), STRANDED_URL);
      check("a CLI-managed database is born from a real deploy", born.status === 0, `exit ${born.status}`);

      // Ground truth for the row format the fix imitates: the checksum column
      // the CLI itself wrote must be the sha256 hex of the migration file.
      check(
        "the CLI's own checksum is sha256(migration.sql) - the format the mirror writes",
        sqlAt(STRANDED_FILE, `select checksum from _prisma_migrations where migration_name='0_init';`) ===
          sha256File(path.join(root, "prisma", "migrations", "0_init", "migration.sql"))
      );

      // Tables "the previous release" already had, carrying data the coming
      // rebuild's copy list will not name. StrandMarker counts executions.
      sqlAt(
        STRANDED_FILE,
        `CREATE TABLE "StrandProbe" ("id" TEXT NOT NULL PRIMARY KEY);
         CREATE TABLE "StrandMarker" ("id" TEXT NOT NULL PRIMARY KEY, "runs" INTEGER NOT NULL DEFAULT 0);
         INSERT INTO "StrandProbe" ("id") VALUES ('p1');
         INSERT INTO "StrandMarker" ("id","runs") VALUES ('rebuild', 0);`
      );

      // The "next release": every shipped migration plus one more - a
      // Prisma-shaped rebuild, the migration class whose replay destroys.
      const install = path.join(scratch, "install");
      fs.cpSync(path.join(root, "prisma", "migrations"), path.join(install, "prisma", "migrations"), {
        recursive: true,
      });
      const rebuildName = "20990201000000_stranded_rebuild";
      const rebuildDir = path.join(install, "prisma", "migrations", rebuildName);
      fs.mkdirSync(rebuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(rebuildDir, "migration.sql"),
        `-- Adds "extra" via the standard SQLite rebuild: copy the old columns, drop, rename.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StrandProbe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "extra" TEXT
);
INSERT INTO "new_StrandProbe" ("id") SELECT "id" FROM "StrandProbe";
DROP TABLE "StrandProbe";
ALTER TABLE "new_StrandProbe" RENAME TO "StrandProbe";
UPDATE "StrandMarker" SET "runs" = "runs" + 1 WHERE "id" = 'rebuild';
PRAGMA foreign_keys=ON;
`
      );
      // `migrate deploy` only needs the datasource; the migrations dir is the
      // one sitting beside this schema file.
      fs.writeFileSync(
        path.join(install, "prisma", "schema.prisma"),
        `datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n`
      );

      // The takeover happens on boot, which owns a different DATABASE_URL than
      // this script's shared client - so boot in a child process, cwd'd into
      // the fake install the way a packaged app runs from its own directory.
      const runner = path.join(scratch, "run-ensure.mjs");
      fs.writeFileSync(
        runner,
        `import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
register(pathToFileURL(path.join(root, "scripts", "ts-loader.mjs")));
const { ensureSchema } = await import(pathToFileURL(path.join(root, "src", "lib", "schema-migrate.ts")).href);
const { prisma } = await import(pathToFileURL(path.join(root, "src", "lib", "prisma.ts")).href);
await ensureSchema();
await prisma.$disconnect();
`
      );
      const boot = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", runner, root],
        { cwd: install, env: { ...process.env, DATABASE_URL: STRANDED_URL }, encoding: "utf8" }
      );
      check(
        "the self-migrator takes the database over and applies the new rebuild",
        boot.status === 0 && sqlAt(STRANDED_FILE, `select runs from StrandMarker where id='rebuild';`) === "1",
        boot.status === 0 ? "" : (boot.stderr || boot.stdout || `exit ${boot.status}`).trim().slice(-300)
      );
      check(
        "the takeover records it in the keel ledger",
        sqlAt(STRANDED_FILE, `select count(*) from _keel_migrations where name='${rebuildName}';`) === "1"
      );

      // The fix itself: the CLI's ledger got the same migration, in the CLI's
      // own row format - applied, and carrying the real file checksum.
      check(
        "…and mirrors it into _prisma_migrations as applied",
        sqlAt(
          STRANDED_FILE,
          `select count(*) from _prisma_migrations where migration_name='${rebuildName}' and finished_at is not null and rolled_back_at is null;`
        ) === "1"
      );
      check(
        "…with a checksum indistinguishable from one the CLI would write",
        sqlAt(STRANDED_FILE, `select checksum from _prisma_migrations where migration_name='${rebuildName}';`) ===
          sha256File(path.join(rebuildDir, "migration.sql"))
      );

      // Weeks pass; users fill the new column. This is the parentRecordId /
      // mapX / mapY stand-in - data that exists only in columns the rebuild's
      // copy list does not name.
      sqlAt(STRANDED_FILE, `UPDATE "StrandProbe" SET "extra" = 'precious' WHERE "id" = 'p1';`);

      // The operator re-runs the installer: a REAL deploy over the mirrored
      // ledger. It must see nothing pending - exit clean, run nothing, drop
      // nothing.
      const stray = deploy(path.join(install, "prisma", "schema.prisma"), STRANDED_URL);
      check("a later real `prisma migrate deploy` exits clean", stray.status === 0, `exit ${stray.status}`);
      check(
        "…does NOT replay the rebuild",
        sqlAt(STRANDED_FILE, `select runs from StrandMarker where id='rebuild';`) === "1",
        `${sqlAt(STRANDED_FILE, `select runs from StrandMarker where id='rebuild';`)} run(s)`
      );
      check(
        "…and the data in the self-migrated column survives",
        sqlAt(STRANDED_FILE, `select extra from StrandProbe where id='p1';`) === "precious"
      );

      // Negative control, so a green run above can never be vacuous: remove
      // the mirrored row and the same deploy really does replay the rebuild,
      // exit 0, and silently erase the column's data - the exact HIGH this
      // section exists to keep fixed.
      sqlAt(STRANDED_FILE, `DELETE FROM "_prisma_migrations" WHERE migration_name='${rebuildName}';`);
      const unmirrored = deploy(path.join(install, "prisma", "schema.prisma"), STRANDED_URL);
      check(
        "control: without the mirrored row, deploy replays and destroys - silently",
        unmirrored.status === 0 &&
          sqlAt(STRANDED_FILE, `select runs from StrandMarker where id='rebuild';`) === "2" &&
          sqlAt(STRANDED_FILE, `select extra is null from StrandProbe where id='p1';`) === "1",
        "the mirror row is load-bearing"
      );

      console.log("\nA fresh self-managed install stays immune by refusal, not by bookkeeping\n");
      // The deliberate half of the fix: where `_prisma_migrations` does NOT
      // exist, ensureSchema must not fabricate it. A schema with no CLI ledger
      // makes deploy refuse outright (P3005) before touching anything - a
      // stronger guarantee than any fabricated history, and one a bootstrap
      // that got ahead of its shipped migrations can't undermine.
      const freshBoot = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", runner, root],
        { cwd: root, env: { ...process.env, DATABASE_URL: FRESH_URL }, encoding: "utf8" }
      );
      const freshShipped = fs
        .readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
        .filter((e) => e.isDirectory()).length;
      check(
        "an empty file bootstraps into a full schema",
        freshBoot.status === 0 && sqlAt(FRESH_FILE, `select count(*) from sqlite_master where name='User';`) === "1",
        freshBoot.status === 0 ? "" : (freshBoot.stderr || freshBoot.stdout || "").trim().slice(-300)
      );
      check(
        "…with every shipped migration in the keel ledger",
        Number(sqlAt(FRESH_FILE, `select count(*) from _keel_migrations;`)) === freshShipped,
        `${sqlAt(FRESH_FILE, `select count(*) from _keel_migrations;`)}/${freshShipped}`
      );
      check(
        "…and no fabricated _prisma_migrations",
        sqlAt(FRESH_FILE, `select count(*) from sqlite_master where name='_prisma_migrations';`) === "0"
      );
      const objectsBefore = sqlAt(FRESH_FILE, `select count(*) from sqlite_master;`);
      const refused = deploy(path.join(root, "prisma", "schema.prisma"), FRESH_URL);
      check(
        "a stray deploy is refused outright (P3005), nothing replayed",
        refused.status !== 0 && `${refused.stdout}${refused.stderr}`.includes("P3005"),
        `exit ${refused.status}`
      );
      check(
        "…and the database is untouched by the refusal",
        sqlAt(FRESH_FILE, `select count(*) from sqlite_master;`) === objectsBefore &&
          sqlAt(FRESH_FILE, `select count(*) from sqlite_master where name='_prisma_migrations';`) === "0"
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.stack || err.message}\n`);
  failures.push(err.message);
} finally {
  await prisma.$disconnect().catch(() => {});
  cleanDatabase(root, DB_NAME);
  cleanDatabase(root, STRANDED_NAME);
  cleanDatabase(root, FRESH_NAME);
  cleanDatabase(root, BOOTSTRAP_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
