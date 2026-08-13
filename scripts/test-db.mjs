// Scratch database setup shared by the test scripts.
//
// Local runs get a throwaway SQLite file - no services to install, and each
// script cleans up after itself. CI also runs the same suites against a real
// PostgreSQL service, because "it works on SQLite" says nothing about the
// dialect Azure and every managed host actually use.
//
// Set DATABASE_URL to a postgresql:// URL and these helpers switch over.
import { spawnSync } from "child_process";
import { rmSync, existsSync, writeFileSync } from "fs";
import path from "path";

export function isPostgres(url = process.env.DATABASE_URL) {
  return Boolean(url && /^postgres(ql)?:\/\//.test(url));
}

/**
 * Resolve the URL a test should use.
 * @param root  repository root
 * @param name  scratch database name, e.g. "authz-check"
 */
export function testDatabaseUrl(root, name) {
  if (isPostgres()) return process.env.DATABASE_URL;
  // Absolute: Prisma resolves a relative file: URL against prisma/, but the
  // Next server resolves it against cwd - so a relative path means two databases.
  return "file:" + path.join(root, `${name}.db`).split(path.sep).join("/");
}

function run(cmd, args, env, root) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

/** Ensure Prisma receives an existing SQLite file on platforms where its
 * schema engine cannot create the first file itself. */
export function ensureSqliteDatabaseFile(url) {
  if (!isPostgres(url)) writeFileSync(url.slice("file:".length), "", { flag: "a" });
}

/** Create (or reset) the schema so every run starts from empty. */
export function prepareDatabase(root, url) {
  const schema = isPostgres(url)
    ? path.join(root, "prisma", "postgresql", "schema.prisma")
    : path.join(root, "prisma", "schema.prisma");

  if (isPostgres(url)) {
    // The suites assume an empty database; a leftover row from a previous job
    // would make "the instance owner is whoever registered first" nondeterministic.
    run("npx", ["prisma", "db", "push", "--force-reset", "--skip-generate", "--schema", schema], { DATABASE_URL: url }, root);
    return;
  }
  // Prisma normally creates a missing SQLite file itself. On macOS 27 the
  // 6.x schema engine can fail that first create with an empty "Schema engine
  // error", while applying the identical schema to an existing empty file
  // succeeds. Pre-creating the scratch file is harmless on every platform and
  // keeps test provisioning independent of that engine quirk.
  ensureSqliteDatabaseFile(url);
  run("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema", schema], { DATABASE_URL: url }, root);
}

/** Remove a scratch SQLite file. No-op on PostgreSQL. */
export function cleanDatabase(root, name) {
  if (isPostgres()) return;
  const file = path.join(root, `${name}.db`);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    if (existsSync(file + suffix)) rmSync(file + suffix, { force: true });
  }
}

/** A Prisma client bound to the test database, without touching global state. */
export async function testPrisma(root, url) {
  const { PrismaClient } = await import(
    path.join(root, "node_modules/@prisma/client/index.js")
  );
  return new PrismaClient({ datasources: { db: { url } } });
}
