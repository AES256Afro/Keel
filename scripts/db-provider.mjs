#!/usr/bin/env node
// Switch the Prisma datasource provider between SQLite and PostgreSQL.
//
// Prisma resolves `provider` at generate time and does not accept an env var
// there, so "runs on SQLite locally, PostgreSQL in the cloud" needs the schema
// rewritten before `prisma generate`. This does exactly that - one line in
// schema.prisma - and is idempotent, so it is safe to run on every build.
//
//   node scripts/db-provider.mjs              # infer from DATABASE_URL
//   node scripts/db-provider.mjs postgresql   # force
//   node scripts/db-provider.mjs --check      # report, change nothing
//
// Migrations are per-provider (prisma/migrations is SQLite-specific SQL), so
// each provider keeps its own directory - see prisma/migrations-postgresql.
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(root, "prisma", "schema.prisma");

const SUPPORTED = ["sqlite", "postgresql"];

/** Guess the provider from a connection string. */
export function providerFromUrl(url) {
  if (!url) return null;
  if (url.startsWith("file:")) return "sqlite";
  if (/^postgres(ql)?:\/\//.test(url)) return "postgresql";
  return null;
}

function currentProvider(schema) {
  return /provider\s*=\s*"([a-z]+)"/.exec(
    /datasource\s+db\s*\{[\s\S]*?\}/.exec(schema)?.[0] ?? ""
  )?.[1];
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const explicit = args.find((a) => SUPPORTED.includes(a));

  const schema = readFileSync(SCHEMA, "utf8");
  const current = currentProvider(schema);

  const wanted =
    explicit ??
    process.env.KEEL_DB_PROVIDER ??
    providerFromUrl(process.env.DATABASE_URL) ??
    current;

  if (!SUPPORTED.includes(wanted)) {
    console.error(
      `[keel] unsupported database provider "${wanted}". Use one of: ${SUPPORTED.join(", ")}`
    );
    process.exit(1);
  }

  if (check) {
    console.log(`schema provider: ${current}\nresolved provider: ${wanted}`);
    process.exit(current === wanted ? 0 : 1);
  }

  if (current === wanted) {
    console.log(`[keel] database provider already "${wanted}"`);
    return;
  }

  // Only the datasource block's provider is touched - the generator block also
  // has a `provider` line and must not be rewritten.
  const updated = schema.replace(/(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")[a-z]+(")/, `$1${wanted}$2`);
  if (updated === schema) {
    console.error("[keel] could not find the datasource provider in prisma/schema.prisma");
    process.exit(1);
  }
  writeFileSync(SCHEMA, updated);
  console.log(`[keel] database provider: ${current} → ${wanted}`);
  if (wanted === "postgresql") {
    console.log(
      "[keel] PostgreSQL selected. Use `npm run db:deploy` (migrations live in prisma/migrations-postgresql)."
    );
  }
}

main();
