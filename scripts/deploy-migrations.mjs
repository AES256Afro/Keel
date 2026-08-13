#!/usr/bin/env node
// Apply migrations for whichever database this deployment uses.
//
// Migration SQL is dialect-specific, so the two providers keep separate
// migration directories, each beside its own schema file. This picks the right
// pair from DATABASE_URL and hands off to `prisma migrate deploy`.
//
//   DATABASE_URL=file:/data/keel.db      → prisma/migrations
//   DATABASE_URL=postgresql://…           → prisma/postgresql/migrations
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function providerFromUrl(url) {
  if (!url) return null;
  if (url.startsWith("file:")) return "sqlite";
  if (/^postgres(ql)?:\/\//.test(url)) return "postgresql";
  return null;
}

const provider =
  process.env.KEEL_DB_PROVIDER ?? providerFromUrl(process.env.DATABASE_URL) ?? "sqlite";

if (!["sqlite", "postgresql"].includes(provider)) {
  console.error(
    `[keel] cannot tell which database to migrate. Set DATABASE_URL to a file: or postgresql: URL.`
  );
  process.exit(1);
}

const run = (cmd, args, label) => {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[keel] ${label} failed`);
    process.exit(res.status ?? 1);
  }
};

let schema = path.join(root, "prisma", "schema.prisma");

if (provider === "postgresql") {
  // Regenerate the PostgreSQL schema copy so it can never lag the source.
  run(process.execPath, [path.join(root, "scripts/sync-postgres-schema.mjs")], "schema sync");
  schema = path.join(root, "prisma", "postgresql", "schema.prisma");
}

const migrations = path.join(path.dirname(schema), "migrations");
if (!existsSync(migrations)) {
  console.error(`[keel] no migrations directory for ${provider} at ${migrations}`);
  process.exit(1);
}

console.log(`[keel] applying ${provider} migrations from ${path.relative(root, migrations)}`);
run("npx", ["prisma", "migrate", "deploy", "--schema", schema], "migrate deploy");
console.log("[keel] migrations applied");
