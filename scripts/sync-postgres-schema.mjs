#!/usr/bin/env node
// Keep prisma/postgresql/schema.prisma in lockstep with prisma/schema.prisma.
//
// Prisma looks for a migrations directory next to the schema file, and the two
// dialects need different migration SQL - SQLite rebuilds a table to add a
// foreign key where PostgreSQL runs ALTER TABLE. So PostgreSQL gets its own
// schema file and its own migrations, generated from the one source of truth
// rather than hand-maintained (which would drift the first time anyone forgot).
//
//   node scripts/sync-postgres-schema.mjs           # regenerate the copy
//   node scripts/sync-postgres-schema.mjs --check   # fail if it has drifted
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "prisma", "schema.prisma");
const OUT_DIR = path.join(root, "prisma", "postgresql");
const OUT = path.join(OUT_DIR, "schema.prisma");

const HEADER = `// GENERATED - do not edit.
// Source: prisma/schema.prisma. Regenerate with \`npm run db:sync-postgres\`.
//
// Identical to the SQLite schema except for the datasource provider. It lives
// here because Prisma resolves a migrations directory relative to the schema,
// and the PostgreSQL migration SQL differs from SQLite's.

`;

function render(source) {
  const withProvider = source.replace(
    /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")[a-z]+(")/,
    `$1postgresql$2`
  );
  return HEADER + withProvider;
}

const expected = render(readFileSync(SOURCE, "utf8"));

if (process.argv.includes("--check")) {
  const actual = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (actual !== expected) {
    console.error(
      "[keel] prisma/postgresql/schema.prisma is out of date - run `npm run db:sync-postgres`"
    );
    process.exit(1);
  }
  console.log("[keel] PostgreSQL schema is in sync");
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, expected);
console.log("[keel] wrote prisma/postgresql/schema.prisma");
