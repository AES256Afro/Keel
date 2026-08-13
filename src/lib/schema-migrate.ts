import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { PrismaClient } from "@prisma/client";

/**
 * A dedicated single-connection client for applying migrations.
 *
 * Migration SQL depends on connection-scoped PRAGMAs: Prisma's SQLite table
 * rebuilds open with `PRAGMA foreign_keys=OFF`, and SQLite silently ignores
 * that pragma inside an open transaction. Running a rebuild through
 * prisma.$transaction therefore executed its DROP TABLE with foreign keys ON -
 * and ON DELETE CASCADE quietly emptied every child table (all DatabaseValue
 * rows, for the record-tree rebuild) while the migration reported success.
 *
 * So migrations run on their own client pinned to one connection
 * (connection_limit=1): the pragma is issued OUTSIDE the transaction where it
 * takes effect, and BEGIN/COMMIT are explicit statements on that same
 * connection - which also frees us from the interactive transaction's 5s
 * default timeout, which a large table rebuild can genuinely exceed.
 */
function migrationClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "";
  const sep = url.includes("?") ? "&" : "?";
  return new PrismaClient({ datasourceUrl: `${url}${sep}connection_limit=1` });
}

/**
 * Run statements as one atomic unit with foreign-key enforcement suspended,
 * the way `prisma migrate deploy` runs a migration file. Tolerated errors
 * ("duplicate column", "already exists") skip the statement: that is the state
 * of a pre-1.0 install whose schema.sql already contained early migrations.
 */
async function applyAtomically(mig: PrismaClient, statements: string[]) {
  await mig.$executeRawUnsafe(`PRAGMA foreign_keys=OFF`);
  await mig.$executeRawUnsafe(`BEGIN IMMEDIATE`);
  try {
    for (const statement of statements) {
      try {
        await mig.$executeRawUnsafe(statement);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (/duplicate column|already exists/i.test(text)) continue;
        throw err;
      }
    }
    await mig.$executeRawUnsafe(`COMMIT`);
  } catch (err) {
    await mig.$executeRawUnsafe(`ROLLBACK`).catch(() => {});
    throw err;
  } finally {
    await mig.$executeRawUnsafe(`PRAGMA foreign_keys=ON`).catch(() => {});
    // Enforcement was off while the unit ran; surface anything it broke rather
    // than failing the boot - this matches how the Prisma CLI applies the same
    // file, and a warning beats refusing to start over a pre-existing orphan.
    const broken = await mig
      .$queryRawUnsafe<unknown[]>(`PRAGMA foreign_key_check`)
      .catch(() => []);
    if (broken.length) {
      console.warn(`[keel] foreign_key_check reports ${broken.length} inconsistent row(s) after migration`);
    }
  }
}

/**
 * Every place a shipped file could be, in the order we look. Split out from
 * findShipped so a failure can name the paths it searched: "prisma/migrations
 * was not found" is only actionable next to the list of where we looked.
 */
type ShippedPath = "migrations" | "schema.sql";

function shippedCandidates(target: ShippedPath): string[] {
  // __dirname exists in the bundled server but not when this module is loaded
  // as ESM (the test harness does exactly that); cwd already covers that case.
  const here = typeof __dirname !== "undefined" ? __dirname : null;
  const fromCwd =
    target === "migrations"
      ? path.join(process.cwd(), "prisma", "migrations")
      : path.join(process.cwd(), "prisma", "schema.sql");
  const fromBundle = here
    ? target === "migrations"
      ? path.join(here, "..", "..", "prisma", "migrations")
      : path.join(here, "..", "..", "prisma", "schema.sql")
    : null;
  return [
    fromCwd,
    ...(fromBundle ? [fromBundle] : []),
  ];
}

/** Locate a file that ships beside the app in any install shape. */
async function findShipped(target: ShippedPath): Promise<string | null> {
  for (const candidate of shippedCandidates(target)) {
    try {
      await fs.access(/* turbopackIgnore: true */ candidate);
      return candidate;
    } catch {}
  }
  return null;
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*[\r\n]+/)
    .map((statement) =>
      statement
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

/**
 * What a migration is trying to end up with - derived from its own SQL.
 *
 * Needed because "has this already been applied?" cannot be answered by
 * running it and tolerating the error. SQLite has no ADD COLUMN for a foreign
 * key, so Prisma emits the standard rebuild: create `new_T`, copy the columns
 * that existed *when the migration was written*, drop `T`, rename. Replayed
 * against a database that already has the newer columns, every statement
 * succeeds - and the copy silently drops the columns it doesn't name. That is
 * how a record tree and every mind-map node position get erased by an
 * "additive" migration. So we check the destination state first and skip.
 */
function migrationTargets(sql: string): {
  tables: string[];
  columns: [string, string][];
  indexes: string[];
  /** Table rebuilds (CREATE new_T … RENAME TO T): destination name + CREATE body. */
  rebuilds: { table: string; body: string }[];
} {
  const tables: string[] = [];
  const columns: [string, string][] = [];
  const indexes: string[] = [];
  const rebuilds: { table: string; body: string }[] = [];

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(([\s\S]*?)\n\)/gi)) {
    const [, rawName, body] = m;
    // A rebuild's real destination is the name it is renamed to.
    const renamed = new RegExp(`ALTER\\s+TABLE\\s+"${rawName}"\\s+RENAME\\s+TO\\s+"([^"]+)"`, "i").exec(sql);
    const table = renamed ? renamed[1] : rawName;
    if (!renamed) tables.push(table);
    else rebuilds.push({ table, body });
    for (const line of body.split(/\r?\n/)) {
      // Column definitions are quoted and start the line; CONSTRAINT / PRIMARY
      // KEY / FOREIGN KEY clauses are not quoted, so this excludes them.
      const col = /^\s*"([^"]+)"\s+\S/.exec(line);
      if (col) columns.push([table, col[1]]);
    }
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/gi)) {
    columns.push([m[1], m[2]]);
  }
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) {
    indexes.push(m[1]);
  }
  return { tables, columns, indexes, rebuilds };
}

/**
 * The FOREIGN KEY set a rebuilt table declares, canonicalised to compare
 * against PRAGMA foreign_key_list - or null when the CREATE body mentions
 * REFERENCES in a shape this parser doesn't understand. Null must be read as
 * "assume not satisfied": guessing "satisfied" is the one wrong answer,
 * because it records the migration without running it.
 */
function declaredForeignKeys(body: string): string[] | null {
  const fks: string[] = [];
  const action = (clause: string, kind: "DELETE" | "UPDATE") => {
    const m = new RegExp(
      `ON\\s+${kind}\\s+(SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT|NO\\s+ACTION)`,
      "i"
    ).exec(clause);
    // SQLite's default action when the clause is absent.
    return (m ? m[1] : "NO ACTION").toUpperCase().replace(/\s+/g, " ");
  };
  const names = (cols: string) => [...cols.matchAll(/"([^"]+)"/g)].map((c) => c[1]).join(",");
  const canon = (from: string, table: string, to: string, rest: string) =>
    `${from}=>${table}(${to}) DELETE:${action(rest, "DELETE")} UPDATE:${action(rest, "UPDATE")}`;
  // Table-level, the shape Prisma emits:
  //   CONSTRAINT "T_col_fkey" FOREIGN KEY ("col") REFERENCES "P" ("id") ON DELETE …
  for (const m of body.matchAll(
    /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"([^"]+)"\s*(?:\(([^)]*)\))?([^,\n]*)/gi
  )) {
    fks.push(canon(names(m[1]), m[2], m[3] ? names(m[3]) : "", m[4]));
  }
  // Column-level, for hand-written SQL: "col" TEXT REFERENCES "P" ("id") …
  for (const m of body.matchAll(
    /^\s*"([^"]+)"[^,\n]*?REFERENCES\s+"([^"]+)"\s*(?:\(([^)]*)\))?([^,\n]*)/gim
  )) {
    fks.push(canon(m[1], m[2], m[3] ? names(m[3]) : "", m[4]));
  }
  // Every REFERENCES in the body must be accounted for by one parsed clause.
  const mentions = body.match(/REFERENCES/gi)?.length ?? 0;
  return fks.length === mentions ? fks.sort() : null;
}

interface ForeignKeyRow {
  id: number | bigint;
  seq: number | bigint;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

/** The live table's FK set, in the same canonical form as declaredForeignKeys. */
async function liveForeignKeys(table: string): Promise<string[] | null> {
  const rows = await prisma
    .$queryRawUnsafe<ForeignKeyRow[]>(`PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`)
    .catch(() => null);
  if (!rows) return null;
  // Composite keys arrive as one row per column, grouped by id, ordered by seq.
  const grouped = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = grouped.get(Number(row.id));
    if (group) group.push(row);
    else grouped.set(Number(row.id), [row]);
  }
  const fks: string[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => Number(a.seq) - Number(b.seq));
    const from = group.map((r) => r.from).join(",");
    // `to` is null when the FK references the parent's primary key implicitly -
    // which is also the shape the SQL parser records as "".
    const to = group.map((r) => r.to ?? "").join(",");
    const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
    fks.push(
      `${from}=>${group[0].table}(${to}) DELETE:${norm(group[0].on_delete)} UPDATE:${norm(group[0].on_update)}`
    );
  }
  return fks.sort();
}

/**
 * True when every table, column and index a migration would create is already
 * there - so running it could only destroy data, never add anything.
 *
 * Deliberately conservative: a migration whose SQL yields no targets at all
 * (a pure data backfill, say) reports false and gets applied.
 */
async function alreadySatisfied(sql: string): Promise<boolean> {
  const { tables, columns, indexes, rebuilds } = migrationTargets(sql);
  if (!tables.length && !columns.length && !indexes.length) return false;

  const live = new Map<string, Set<string>>();
  const columnsOf = async (table: string) => {
    const cached = live.get(table);
    if (cached) return cached;
    const rows = await prisma
      .$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
      .catch(() => []);
    const set = new Set(rows.map((r) => r.name));
    live.set(table, set);
    return set;
  };

  for (const t of tables) if ((await columnsOf(t)).size === 0) return false;
  for (const [t, c] of columns) if (!(await columnsOf(t)).has(c)) return false;
  if (indexes.length) {
    const rows = await prisma
      .$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type='index'`)
      .catch(() => []);
    const have = new Set(rows.map((r) => r.name));
    for (const i of indexes) if (!have.has(i)) return false;
  }
  // A rebuild whose only change is constraint-level - a new FOREIGN KEY, a
  // different ON DELETE - creates no new table, column or index, so every
  // check above passes on a database that is genuinely one migration behind,
  // and the migration would be recorded without ever running. A rebuild is
  // only satisfied if the live table also matches its declared FK set. Any
  // difference - or a clause the parser can't read - reports "not satisfied",
  // which is safe: wouldDestroyColumns() still refuses any rebuild whose copy
  // list would drop data, and a constraint-only rebuild copies every column.
  for (const rebuild of rebuilds) {
    const declared = declaredForeignKeys(rebuild.body);
    if (!declared) return false;
    const existing = await liveForeignKeys(rebuild.table);
    if (!existing) return false;
    if (declared.length !== existing.length) return false;
    if (declared.some((fk, i) => fk !== existing[i])) return false;
  }
  return true;
}

/**
 * Columns a migration would destroy: present in the live table, absent from
 * the rebuild's column list.
 *
 * alreadySatisfied() handles the database that is wholly ahead of its ledger.
 * This handles the partial case - a database ahead in some migrations and
 * behind in others, which a restore or a hand-repaired schema can produce. The
 * rebuild copies a fixed list of columns, so anything the live table has that
 * the list omits is gone the moment the old table is dropped. Losing data is
 * never the better branch: name what would go and refuse.
 */
async function wouldDestroyColumns(sql: string): Promise<string[]> {
  const lost: string[] = [];
  for (const m of sql.matchAll(
    /INSERT\s+INTO\s+"([^"]+)"\s*\(([^)]*)\)\s*SELECT[\s\S]*?FROM\s+"([^"]+)"/gi
  )) {
    const [, into, cols, from] = m;
    // Only the rebuild shape: copy out, drop the original, rename over it.
    if (!new RegExp(`DROP\\s+TABLE\\s+"${from}"`, "i").test(sql)) continue;
    if (!new RegExp(`ALTER\\s+TABLE\\s+"${into}"\\s+RENAME\\s+TO\\s+"${from}"`, "i").test(sql)) continue;
    const carried = new Set([...cols.matchAll(/"([^"]+)"/g)].map((c) => c[1]));
    const rows = await prisma
      .$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${from.replace(/"/g, '""')}")`)
      .catch(() => []);
    for (const r of rows) if (!carried.has(r.name)) lost.push(`${from}.${r.name}`);
  }
  return lost;
}

/**
 * Statements that record a migration as applied in `_prisma_migrations`, in
 * the CLI's own row format.
 *
 * Why the CLI's ledger must be kept current: `prisma migrate deploy` consults
 * ONLY `_prisma_migrations` and has no alreadySatisfied() guard. When the
 * takeover above adopts a CLI-managed database, everything this module then
 * applies or adopts lands in `_keel_migrations` - and if the CLI ledger is
 * left behind, a later `npm run db:deploy` (README documents it; re-running
 * install.sh invokes it) sees those migrations as pending and REPLAYS them.
 * Replaying a table rebuild onto a database that is already ahead succeeds
 * while silently dropping every column the rebuild's copy list doesn't name -
 * the exact loss class the guards above exist to stop, reopened through the
 * seam between the two ledgers. So: whenever a migration is recorded in
 * `_keel_migrations` AND `_prisma_migrations` exists, mirror it there too, and
 * the CLI can never believe it has work this module already did.
 *
 * Only mirror - never CREATE `_prisma_migrations` where it doesn't exist.
 * A self-managed database without the table is already immune to a stray
 * deploy: the CLI refuses a non-empty schema with no ledger outright (P3005,
 * verified against Prisma 6.x) before touching anything. Fabricating a
 * complete CLI history there would trade that hard refusal for trust in
 * bookkeeping, and would turn one corner dangerous that is safe today: a
 * database bootstrapped from a schema.sql that ran ahead of the shipped
 * migrations would carry a "complete" ledger, so a later deploy of the
 * catch-up migration would replay its rebuild onto the ahead schema. Absence
 * of the table IS the inoculation; completeness matters only where it exists.
 *
 * Row format verified against a database migrated by `prisma migrate deploy`
 * (Prisma 6.x, SQLite): `id` is a UUID, `checksum` is the sha256 hex digest
 * of the migration.sql file bytes, `started_at`/`finished_at` are unix-epoch
 * milliseconds, `logs` and `rolled_back_at` are NULL, `applied_steps_count`
 * is 1. Deploy's "applied" test is finished_at set and rolled_back_at unset,
 * so these statements are idempotent against any pre-existing state: a
 * leftover failed attempt (finished_at NULL) is marked rolled back - the
 * state `prisma migrate resolve --rolled-back` produces - and the applied row
 * is inserted only if none exists.
 */
function mirrorToPrismaLedger(name: string, sql: string): string[] {
  const esc = (s: string) => s.replace(/'/g, "''");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const now = Date.now();
  return [
    `UPDATE "_prisma_migrations" SET "rolled_back_at" = ${now} ` +
      `WHERE "migration_name" = '${esc(name)}' AND "finished_at" IS NULL AND "rolled_back_at" IS NULL`,
    `INSERT INTO "_prisma_migrations" ` +
      `("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") ` +
      `SELECT '${randomUUID()}', '${checksum}', ${now}, '${esc(name)}', NULL, NULL, ${now}, 1 ` +
      `WHERE NOT EXISTS (SELECT 1 FROM "_prisma_migrations" ` +
      `WHERE "migration_name" = '${esc(name)}' AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL)`,
  ];
}

/**
 * What ensureSchema decided last, so "why is my schema old?" has an answer.
 *
 * Every path out of ensureSchema - including the ones that do nothing - goes
 * through report(), which both logs one line and records it here. The log is
 * the primary surface (it is what an operator has on a headless install); this
 * is the machine-readable copy, for a health/Settings panel to show without
 * re-deriving anything.
 *
 *   • current   - the shipped set is fully recorded, or was just applied
 *   • deferred  - deliberately not managing the schema (KEEL_SELF_MIGRATE=0,
 *                 a current CLI ledger, a non-SQLite datasource)
 *   • unverified- we could not tell whether the schema is current (no shipped
 *                 migrations found, unreadable ledger). Serving continues; see
 *                 the refuse-vs-warn note in ensureSchema.
 *   • failed    - a migration or a ledger write failed; the schema may be behind
 */
export interface SchemaStatus {
  state: "current" | "deferred" | "unverified" | "failed";
  detail: string;
  at: string;
}

/**
 * The status lives on globalThis, NOT in a module binding - the same escape
 * hatch src/lib/prisma.ts and src/lib/server-init.ts use, and for the same
 * reason, which here is load-bearing rather than merely tidy.
 *
 * ensureSchema runs exactly once per process, behind `g.__keelInitPromise` in
 * server-init.ts - a globalThis flag. But Next compiles a server component and
 * a route handler into separate module graphs (this file appears in the build
 * output as both `schema-migrate.ts [app-rsc]` and `schema-migrate.ts
 * [app-route]`, i.e. two instantiations), and `next dev` re-instantiates
 * modules on recompile. Module state would therefore be per-copy while the
 * once-flag is per-process: whichever copy loses the race to run ensureSchema
 * keeps its seed value forever, because the once-flag guarantees it never runs
 * again. Settings renders in the RSC copy, so an API request arriving first -
 * a tab left open across a restart POSTs /api/pages/{id}/visit - would make the
 * schema panel tell the owner "Keel cannot verify the schema is up to date -
 * ensureSchema has not run yet" on an install whose schema is perfectly
 * current, and (worse) show that generic line instead of the real failure
 * detail when a migration actually failed. A panel that cries wolf on healthy
 * boots is a panel operators learn to ignore, which is the one thing it cannot
 * afford. Sharing the status's lifetime with the once-flag makes the reader and
 * the writer the same slot no matter which copy each of them lives in.
 */
const g = globalThis as unknown as { __keelSchemaStatus?: SchemaStatus };

/** The last decision ensureSchema made - for a health/Settings surface. */
export function schemaStatus(): SchemaStatus {
  return {
    ...(g.__keelSchemaStatus ??= {
      state: "unverified",
      detail: "ensureSchema has not run yet",
      at: new Date().toISOString(),
    }),
  };
}

function report(
  state: SchemaStatus["state"],
  detail: string,
  level: "log" | "warn" | "error" = "log"
) {
  g.__keelSchemaStatus = { state, detail, at: new Date().toISOString() };
  console[level](`[keel] ${detail}`);
}

/**
 * Schema management for installs that have no Prisma CLI - the packaged
 * desktop app, brew/npm installs, anything updated by swapping the app
 * directory. This is what makes updates seamless: a new version boots, sees
 * which shipped migrations the database hasn't had yet, and applies them.
 *
 * Three cases, decided by what's in the database:
 *
 *   • `_prisma_migrations` exists and nothing shipped is missing from the
 *     ledgers - a CLI-managed install (Docker, the installers). The entrypoint
 *     ran `prisma migrate deploy` before boot; touching the schema from here
 *     would mean two writers, so we don't. But when a shipped migration is in
 *     NEITHER ledger, no CLI ran this boot - the file was carried out of a
 *     Docker volume into an install with no entrypoint (`keel import`), and
 *     deferring forever would strand it on a stale schema. Adopt the CLI's
 *     history into `_keel_migrations` and self-manage from then on (details
 *     at the check below).
 *   • Brand-new file - apply prisma/schema.sql in one pass, then record every
 *     shipped migration as applied in `_keel_migrations`.
 *   • Existing data - apply any shipped migration not yet recorded, oldest
 *     first, after checking it isn't already in place. Statements that fail
 *     because the change exists ("duplicate column", "already exists") are
 *     tolerated and recorded.
 *
 * A migration being "additive" is not something to take on trust. Prisma's
 * SQLite output rebuilds a table to add a foreign key, and a rebuild replayed
 * onto a database that is already ahead succeeds while dropping the columns
 * the copy doesn't name - which is how a whole record tree and every mind-map
 * position got erased between one boot and the next. alreadySatisfied() is
 * what stops that; scripts/migration-replay-check.mjs is what proves it.
 *
 * Every exit from here reports - including, especially, the ones that do
 * nothing. A migrator that decides to skip and says nothing is how a database
 * stays behind for weeks: "the schema is old" and "the schema is current" look
 * identical in a silent log. So each return goes through report(), which logs
 * one line and records it in schemaStatus() for a health/Settings surface.
 *
 * "Every exit" includes the ones nobody planned. The individual writes below
 * that can plausibly lose a race are guarded where they stand, but a throw from
 * anywhere else - a ledger CREATE TABLE, the fresh bootstrap, a raw query
 * against a busy file - would leave BOTH the log line and the status unwritten,
 * and would take the rest of initServer down with it: initServerOnce memoizes
 * the rejected promise, so WAL mode, the plainText backfill and the automatic
 * backup scheduler would all be silently off for the life of the process after
 * a single transient error. So the whole body runs inside one catch that
 * reports and returns. Serving with a schema we could not verify is the same
 * trade the "no shipped migrations" branch already makes, and it is strictly
 * better than serving with no backups and no explanation.
 */
export async function ensureSchema() {
  try {
    await migrateSchema();
  } catch (err) {
    report(
      "failed",
      `the schema check did not complete: ${
        err instanceof Error ? err.message : String(err)
      }. The schema may be behind the shipped migrations; the next boot retries.`,
      "error"
    );
  }
}

async function migrateSchema() {
  // Self-migration is a SQLite mechanism. Postgres installs are CLI-managed by
  // construction (the Docker entrypoint runs deploy-migrations), and probing
  // sqlite_master against them would only produce noise.
  if (!(process.env.DATABASE_URL ?? "").startsWith("file:")) {
    report("deferred", "DATABASE_URL is not SQLite - the deploy owns the schema, not this process");
    return;
  }

  const searched = shippedCandidates("migrations");
  const migrationsDir = await findShipped("migrations");
  const shipped: { name: string; sql: string }[] = [];
  if (migrationsDir) {
    for (const entry of (
      await fs.readdir(/* turbopackIgnore: true */ migrationsDir)
    ).sort()) {
      const file = path.join(
        /* turbopackIgnore: true */ migrationsDir,
        entry,
        "migration.sql"
      );
      try {
        shipped.push({
          name: entry,
          sql: await fs.readFile(/* turbopackIgnore: true */ file, "utf8"),
        });
      } catch {} // migration_lock.toml and friends
    }
  }

  const cliManaged = await prisma
    .$queryRawUnsafe<unknown[]>(`SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`)
    .then((rows) => rows.length > 0)
    .catch(() => false);

  // "Is the schema created at all?", asked at most once per boot. Decided by
  // whether the table exists, not by whether a query against it succeeds: a
  // transient database error must not be read as "empty" and send a populated
  // database down the create-everything path (which would then throw on the
  // first CREATE TABLE).
  let freshMemo: boolean | undefined;
  const isFresh = async () =>
    (freshMemo ??= await prisma
      .$queryRawUnsafe<unknown[]>(`SELECT name FROM sqlite_master WHERE type='table' AND name='User'`)
      .then((rows) => rows.length === 0));

  // KEEL_SELF_MIGRATE=0 means "an external migrator owns this schema" - an
  // external deploy that runs after boot, say. It used to be read only inside
  // the cliManaged branch below, so on a self-managed database (no
  // `_prisma_migrations` - every non-Docker install) the flag was silently a
  // no-op and this module migrated anyway: two writers, the exact situation
  // the flag exists to prevent. It is consulted here so it holds on every
  // path, fresh databases included (a bootstrap is a schema write like any
  // other, and the external migrator is the one that should perform it).
  //
  // Deferring is a decision, not an absence of one: say so, and say what is
  // being left undone, or a schema that quietly falls further behind produces
  // runtime column-not-found errors with nothing in the boot log to explain it.
  if (process.env.KEEL_SELF_MIGRATE === "0") {
    const names = async (query: string) =>
      new Set(
        (await prisma.$queryRawUnsafe<{ n: string }[]>(query).catch(() => [])).map((r) => r.n)
      );
    const recorded = new Set([
      ...(await names(`SELECT name AS n FROM "_keel_migrations"`)),
      ...(cliManaged
        ? await names(
            `SELECT migration_name AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
          )
        : []),
    ]);
    const pending = shipped.filter((m) => !recorded.has(m.name));
    report(
      "deferred",
      `KEEL_SELF_MIGRATE=0 - not touching the schema; an external migrator is expected to. ` +
        (!shipped.length
          ? `No shipped migrations were found (searched: ${searched.join(", ")}), so what is pending here is unknown.`
          : pending.length
            ? `${pending.length} shipped migration(s) are recorded in neither ledger and will NOT be applied by this process: ${pending
                .map((m) => m.name)
                .join(", ")}.`
            : `All ${shipped.length} shipped migrations are already recorded.`),
      pending.length ? "warn" : "log"
    );
    return;
  }

  // No shipped migrations at all. This is a packaging failure, not a quiet
  // "nothing to do": it is indistinguishable from an up-to-date database from
  // in here, so every path below would no-op and the app would serve a possibly
  // stale schema with zero diagnostics - how the round-9 loss stayed invisible.
  //
  // Warn, do not refuse. Refusing to serve is tempting, but with no migration
  // set we have no evidence the database IS behind: the overwhelmingly likely
  // case is a correct schema plus a mispacked directory (scripts/desktop-build
  // .mjs copies prisma/schema.sql but not prisma/migrations, so every packaged
  // desktop install lands here). Refusing would turn a diagnosable risk into a
  // certain total outage - including for users whose data is perfectly fine and
  // who have no CLI to repair anything with. So: serve, but say so loudly on
  // every boot, name the paths searched, and record it in schemaStatus() as
  // "unverified" so a health/Settings surface can show it too. A stale schema
  // still fails loudly at the first query against a new column - the point of
  // this message is that the boot log will then explain why.
  if (!shipped.length) {
    const where = migrationsDir
      ? `${migrationsDir} contains no migration.sql files`
      : `prisma/migrations was not found (searched: ${searched.join(", ")})`;
    if (await isFresh()) {
      // The schema.sql bootstrap below still works; the ledger just ends up
      // empty, and a later boot that DOES find the directory adopts it.
      report("unverified", `no shipped migrations to record - ${where}`, "warn");
    } else {
      report(
        "unverified",
        `NO SHIPPED MIGRATIONS FOUND - ${where}. This install cannot tell whether its ` +
          `database schema is up to date, and will not migrate it. If this release added ` +
          `columns, queries against them will fail until prisma/migrations ships beside the app.`,
        "error"
      );
      return;
    }
  }

  if (cliManaged) {
    // `_prisma_migrations` normally means a CLI-managed install (Docker, the
    // installers): the entrypoint runs `prisma migrate deploy` before the
    // server boots, and touching the schema from here would mean two writers.
    // But the table is a property of the database FILE, not of the runtime -
    // `keel import` happily adopts a database copied out of a Docker volume
    // into an install that has no entrypoint and no Prisma CLI, where
    // deferring forever means new releases never migrate and every query
    // against a new column fails at runtime with nothing pointing at why.
    //
    // The tie-breaker is the ledger itself: in a genuinely CLI-managed
    // runtime, `migrate deploy` has ALREADY run by the time this code
    // executes, so no shipped migration can be absent from both ledgers here.
    // If one is, no CLI ran this boot - take over. We migrate the ledger
    // rather than run alongside: everything the CLI applied is adopted into
    // `_keel_migrations`, and the ordinary path below applies only what is
    // genuinely missing, under the same alreadySatisfied/wouldDestroyColumns
    // guards as always. The Docker entrypoint performs the mirror adoption
    // (`migrate resolve --applied` for `_keel_migrations` entries) if the
    // file ever moves back into a container - and the ordinary path below
    // keeps `_prisma_migrations` itself current as it works (see
    // mirrorToPrismaLedger), so even a bare `prisma migrate deploy` with no
    // entrypoint in front of it (`npm run db:deploy`, a re-run of install.sh)
    // finds nothing pending. Each migrator recognises the other's records,
    // so neither ever replays the other's work. That keeps the two-writers
    // concern closed in both directions.
    //
    // Override for exotic setups: KEEL_SELF_MIGRATE=1 forces the adoption even
    // when nothing is missing. (Its counterpart, KEEL_SELF_MIGRATE=0, is
    // handled far above so it holds on self-managed databases too.)
    const appliedRows = await prisma
      .$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
      )
      .catch(() => null);
    if (appliedRows === null) {
      // Don't guess about someone else's database - but don't vanish either:
      // this is the one branch where we neither migrate nor know we needn't.
      report(
        "unverified",
        `_prisma_migrations exists but could not be read - leaving the schema to the CLI migrator ` +
          `rather than guessing. If no CLI runs here, this database will not be migrated.`,
        "error"
      );
      return;
    }
    const applied = new Set(appliedRows.map((r) => r.migration_name));
    const keelDone = new Set(
      (
        await prisma
          .$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "_keel_migrations"`)
          .catch(() => [] as { name: string }[])
      ).map((r) => r.name)
    );
    const missing = shipped.filter((m) => !applied.has(m.name) && !keelDone.has(m.name));
    // With nothing shipped, `missing` is empty by arithmetic rather than by
    // evidence, and deferring on it is the wrong call twice over. The database
    // here is necessarily FRESH - the block above returned for every other
    // shape - so the "the CLI has this covered" branch used to return on an
    // empty file and skip the schema.sql bootstrap below entirely, leaving a
    // database with no tables in it. It is a reachable state: a packaged
    // desktop build ships schema.sql but not prisma/migrations (see the note
    // above), and `_prisma_migrations` can sit in an otherwise empty file left
    // by a deploy that failed on its first migration. The status line was
    // untrue as well - "all 0 shipped migrations recorded - leaving the schema
    // to the CLI migrator", on an install that has no CLI to leave it to. A
    // fresh database needs its schema whichever ledger it happens to carry, so
    // fall through to the bootstrap and say that is what is happening.
    const nothingShipped = !shipped.length;
    if (!nothingShipped && missing.length === 0 && process.env.KEEL_SELF_MIGRATE !== "1") {
      // The every-boot Docker case. It is a deliberate hands-off, so name it:
      // this line is the difference between "the CLI has it covered" and "the
      // migrator found nothing and said nothing".
      report(
        "deferred",
        `CLI-managed database (_prisma_migrations present) with all ${shipped.length} shipped ` +
          `migrations recorded - leaving the schema to the CLI migrator`
      );
      return;
    }
    console.log(
      nothingShipped
        ? `[keel] an empty database carrying _prisma_migrations, and no shipped migrations to defer to a CLI ` +
            `about - creating the schema from prisma/schema.sql rather than leaving an empty file behind`
        : missing.length
          ? `[keel] _prisma_migrations is behind the shipped migrations (${missing
              .map((m) => m.name)
              .join(", ")}) and no CLI deploy ran this boot - adopting the database as self-managed`
          : `[keel] KEEL_SELF_MIGRATE=1 - adopting the CLI migration history as self-managed`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "_keel_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)`
    );
    const now = new Date().toISOString();
    for (const name of applied) {
      await prisma.$executeRawUnsafe(
        `INSERT OR IGNORE INTO "_keel_migrations" ("name","applied_at") VALUES (?, ?)`,
        name,
        now
      );
    }
  }

  // "Fresh" means the schema was never created - see isFresh above.
  const fresh = await isFresh();

  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "_keel_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)`
  );

  if (fresh) {
    const schemaFile = await findShipped("schema.sql");
    if (!schemaFile) {
      report(
        "failed",
        `database is empty and prisma/schema.sql was not found (searched: ${shippedCandidates(
          "schema.sql"
        ).join(", ")})`,
        "error"
      );
      return;
    }
    // One atomic unit, ledger rows included. A crash mid-bootstrap must leave
    // the database empty - a half-created schema is "not fresh" to the next
    // boot, which would then try to migrate a database that is neither old nor
    // current and refuse. All-or-nothing makes the next boot simply fresh again.
    const sql = await fs.readFile(
      /* turbopackIgnore: true */ schemaFile,
      "utf8"
    );
    const now = new Date().toISOString();
    const esc = (s: string) => s.replace(/'/g, "''");
    const mig = migrationClient();
    try {
      await applyAtomically(mig, [
        ...splitSqlStatements(sql),
        ...shipped.map(
          (m) =>
            `INSERT OR IGNORE INTO "_keel_migrations" ("name","applied_at") VALUES ('${esc(m.name)}', '${now}')`
        ),
        // A schema-less file can still carry `_prisma_migrations`: a deploy
        // that failed on its first migration rolls the schema back but leaves
        // its failed ledger row. Bring that ledger up to what this bootstrap
        // just created, or a retried deploy replays 0_init into it. Never
        // created here when absent - see mirrorToPrismaLedger.
        ...(cliManaged ? shipped.flatMap((m) => mirrorToPrismaLedger(m.name, m.sql)) : []),
      ]);
    } finally {
      await mig.$disconnect();
    }
    // With migrations shipped this is unambiguously current: schema.sql is
    // this release's schema and every shipped migration is recorded against
    // it. With none shipped it is a bootstrap we cannot check - this report
    // overwrites the "no shipped migrations to record" warning above (report()
    // keeps only the last decision), so the caveat has to travel with it or
    // the Settings panel would show a clean "current" for a packaging shape
    // that genuinely cannot tell whether schema.sql is a release behind.
    report(
      "current",
      shipped.length
        ? `created database schema from prisma/schema.sql (${shipped.length} shipped migrations recorded as applied)`
        : `created database schema from prisma/schema.sql - no shipped migrations were found ` +
            `(searched: ${searched.join(", ")}), so the ledger starts empty and a later boot that ` +
            `finds them adopts them`
    );
    return;
  }

  // Existing data, self-managed: bring it up to the shipped migration set.
  const done = new Set(
    (
      await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "_keel_migrations"`).catch(() => [])
    ).map((r) => r.name)
  );
  let applied = 0;
  let adopted = 0;
  let unrecorded = 0;
  for (const m of shipped) {
    if (done.has(m.name)) continue;
    // A database can be ahead of the ledger - bootstrapped with `prisma db
    // push`, or restored from a newer snapshot, or upgraded from a pre-1.0
    // install whose schema.sql already carried these changes. Adopt those
    // migrations instead of replaying them: see migrationTargets() for what
    // replaying a table rebuild costs.
    if (await alreadySatisfied(m.sql)) {
      // Mirror before recording: if a crash lands between the two, the next
      // boot re-adopts (the keel row is the skip condition) and the mirror
      // insert is idempotent. The other order leaves the CLI ledger short
      // forever - exactly the gap a stray `migrate deploy` replays into.
      if (cliManaged) {
        try {
          for (const statement of mirrorToPrismaLedger(m.name, m.sql)) {
            await prisma.$executeRawUnsafe(statement);
          }
        } catch (err) {
          // These are the two writes most likely to hit SQLITE_BUSY - the very
          // concurrent-deploy race the mirror defends against. Uncaught, one
          // transient failure threw out of ensureSchema, stranding every later
          // migration AND everything initServer does afterwards (WAL, backups),
          // with initServerOnce caching the failure so nothing ever retried.
          //
          // So: skip this migration and keep going. Skipping is cheap and
          // correct here - an adopted migration is already present in the
          // schema, so nothing after it depends on the ledger row, and leaving
          // BOTH ledgers short (no `_keel_migrations` row either) is what makes
          // the next boot re-adopt it. Recording it while the mirror failed is
          // the one unsafe option: the keel row is the skip condition, so the
          // CLI ledger would stay short forever - the gap a stray `migrate
          // deploy` replays into.
          unrecorded++;
          console.error(
            `[keel] migration ${m.name} is already present but could not be mirrored into ` +
              `_prisma_migrations - leaving it unrecorded so the next boot retries:`,
            err instanceof Error ? err.message : String(err)
          );
          continue;
        }
      }
      try {
        await prisma.$executeRawUnsafe(
          `INSERT OR IGNORE INTO "_keel_migrations" ("name","applied_at") VALUES (?, ?)`,
          m.name,
          new Date().toISOString()
        );
      } catch (err) {
        // The keel row is exposed to the same SQLITE_BUSY as the mirror beside
        // it - it is one more write against the same locked file, on the same
        // shared client - so it gets the same treatment, for the same reason:
        // uncaught, one transient failure threw out of ensureSchema, stranding
        // every later migration AND everything initServer does afterwards (WAL,
        // backfill, the backup scheduler), with initServerOnce caching the
        // failure so nothing ever retried.
        //
        // Skipping is again the safe branch, and again because the keel row is
        // the skip condition: on a self-managed database - every install with
        // no `_prisma_migrations` - its absence is exactly what makes the next
        // boot re-run this adopt step, and mirrorToPrismaLedger's INSERT is
        // NOT EXISTS-guarded so re-adopting converges rather than duplicating.
        //
        // On a CLI-managed one the mirror above has already recorded it, so the
        // next boot instead finds nothing missing from both ledgers and defers.
        // That is equally safe and deliberately so: the ledger a stray `migrate
        // deploy` consults is the complete one, so the replay this module
        // exists to prevent still cannot happen; deferring there requires that
        // nothing is pending; and the next release that does have work takes
        // the database over again and carries the CLI history into
        // `_keel_migrations` wholesale. What is never safe is the inverse order
        // - recording keel while the mirror failed - which is why the mirror
        // goes first.
        unrecorded++;
        console.error(
          `[keel] migration ${m.name} is already present but could not be recorded in ` +
            `_keel_migrations - leaving it unrecorded so the next boot retries:`,
          err instanceof Error ? err.message : String(err)
        );
        continue;
      }
      adopted++;
      console.log(`[keel] migration ${m.name} already present - recorded, not replayed`);
      continue;
    }
    const lost = await wouldDestroyColumns(m.sql);
    if (lost.length) {
      // No CLI advice here: on the installs this module serves there IS no
      // usable Prisma CLI state - `migrate deploy` would replay 0_init into an
      // existing schema and die. The honest instruction is the data-safe one.
      report(
        "failed",
        `refusing to apply migration ${m.name}: it rebuilds a table and would drop ` +
          `${lost.join(", ")}. This database carries columns the migration predates, so ` +
          `applying it would lose data. Export your data (Settings → Backup, or \`keel export\`), ` +
          `then restore into a fresh database created by this version.`,
        "error"
      );
      return;
    }
    // Each migration is one atomic unit: all its statements AND the ledger row
    // commit together, or nothing does - via applyAtomically, NOT
    // prisma.$transaction. The distinction is load-bearing: inside an already
    // open transaction SQLite ignores `PRAGMA foreign_keys=OFF`, so a table
    // rebuild's DROP TABLE ran with enforcement on and ON DELETE CASCADE
    // emptied every child table while the migration reported success.
    const esc = (s: string) => s.replace(/'/g, "''");
    const mig = migrationClient();
    try {
      await applyAtomically(mig, [
        ...splitSqlStatements(m.sql),
        `INSERT OR IGNORE INTO "_keel_migrations" ("name","applied_at") VALUES ('${esc(m.name)}', '${new Date().toISOString()}')`,
        // On a database that carries the CLI's ledger, the migration, the
        // keel row and the CLI row commit as one unit - `migrate deploy`
        // can never observe this migration as applied-but-unrecorded.
        ...(cliManaged ? mirrorToPrismaLedger(m.name, m.sql) : []),
      ]);
      applied++;
      console.log(`[keel] applied migration ${m.name}`);
    } catch (err) {
      report(
        "failed",
        `migration ${m.name} failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }. The schema is behind the shipped migrations; later migrations were not attempted.`,
        "error"
      );
      // Stop at the first real failure - later migrations may depend on it.
      return;
    } finally {
      await mig.$disconnect();
    }
  }

  // The loop can finish having done nothing at all - the ordinary steady state.
  // Say which of the two "nothing happened"s it was, so a stale schema is never
  // indistinguishable from a current one in the log.
  if (unrecorded) {
    report(
      "failed",
      `${unrecorded} migration(s) present in the schema could not be recorded this boot (see above); ` +
        `the next boot retries them`,
      "error"
    );
  } else if (applied || adopted) {
    report(
      "current",
      `schema is up to date - ${applied} migration(s) applied, ${adopted} adopted, ` +
        `${shipped.length} shipped in total`
    );
  } else {
    report("current", `schema is up to date - all ${shipped.length} shipped migrations already recorded`);
  }
}
