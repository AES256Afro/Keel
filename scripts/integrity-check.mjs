#!/usr/bin/env node
// Repository integrity checks - the class of bug that has no runtime symptom.
//
// The backup feature shipped calling three endpoints that were not in the
// repository, because .gitignore's unanchored `backups/` rule matched
// src/app/api/workspace/backups/ and `git add` skipped it without a word. No
// test failed, no build broke, and the UI looked healthy. These checks catch
// that shape of problem.
//
//   node scripts/integrity-check.mjs
import { execFileSync } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? `\n      ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `\n      ${detail}` : ""}`);
  }
};

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(root, p);

/* ---------- 1. No source file is silently gitignored ---------- */
console.log("\nNo source file is hidden from git");
{
  const sources = [
    ...walk(path.join(root, "src"), (f) => /\.(ts|tsx|css)$/.test(f)),
    ...walk(path.join(root, "scripts"), (f) => /\.(mjs|js|ps1|sh)$/.test(f)),
    ...walk(path.join(root, "prisma"), (f) => /\.(prisma|sql|toml)$/.test(f)),
    ...walk(path.join(root, "deploy"), () => true),
    ...walk(path.join(root, "docker"), () => true),
  ].map(rel);

  let ignored = [];
  try {
    // check-ignore exits 1 when nothing matches, which is the good case.
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      input: sources.join("\n"),
      encoding: "utf8",
    });
    ignored = out.split("\n").filter(Boolean);
  } catch {
    ignored = [];
  }
  check(
    `${sources.length} source files are all trackable`,
    ignored.length === 0,
    ignored.length ? `ignored: ${ignored.join(", ")}` : ""
  );

  // Untracked-but-not-ignored source files are usually fine mid-work, but a
  // committed tree should have none.
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && /^(src|scripts|prisma|deploy|docker)\//.test(f));
  check(
    "no untracked source files",
    untracked.length === 0,
    untracked.length ? untracked.join(", ") : ""
  );
}

/* ---------- 2. Every endpoint the UI calls exists ---------- */
console.log("\nEvery endpoint the UI calls exists");
{
  const clientFiles = walk(path.join(root, "src"), (f) => /\.(ts|tsx)$/.test(f));
  const called = new Set();
  const callSite = new Map();

  for (const file of clientFiles) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)) {
      const url = m[1]
        .split("?")[0]
        .replace(/\$\{[^}]*\}/g, "ID")
        .replace(/\/$/, "");
      if (!url.startsWith("/api/")) continue;
      called.add(url);
      if (!callSite.has(url)) callSite.set(url, rel(file));
    }
  }

  const existing = new Set(
    walk(path.join(root, "src/app/api"), (f) => f.endsWith("route.ts")).map((f) =>
      rel(f)
        .replace(/^src\/app/, "")
        .replace(/\/route\.ts$/, "")
        .replace(/\[[^\]]*\]/g, "ID")
    )
  );

  // A dynamic segment accepts any concrete value: UI copy may legitimately
  // reference /api/cloud/callback/onedrive while the handler is .../[provider].
  const patterns = [...existing].map(
    (e) => new RegExp("^" + e.split("/").map((seg) => (seg === "ID" ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$")
  );
  const missing = [...called].filter(
    (u) => !existing.has(u) && !patterns.some((re) => re.test(u))
  );
  check(
    `${called.size} referenced endpoints all have a route handler`,
    missing.length === 0,
    missing.map((u) => `${u}  (called from ${callSite.get(u)})`).join("\n      ")
  );
}

/* ---------- 3. Migrations match the schema ---------- */
console.log("\nMigrations and schema agree");
{
  const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

  const sqliteInit = walk(path.join(root, "prisma/migrations"), (f) => f.endsWith(".sql"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const missingSqlite = models.filter((m) => !sqliteInit.includes(`"${m}"`));
  check(
    `all ${models.length} models appear in the SQLite migrations`,
    missingSqlite.length === 0,
    missingSqlite.join(", ")
  );

  const pgInit = walk(path.join(root, "prisma/postgresql/migrations"), (f) => f.endsWith(".sql"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const missingPg = models.filter((m) => !pgInit.includes(`"${m}"`));
  check(
    `all ${models.length} models appear in the PostgreSQL migrations`,
    missingPg.length === 0,
    missingPg.join(", ")
  );

  // schema.sql bootstraps the desktop app, which has no Prisma CLI.
  const bootstrap = readFileSync(path.join(root, "prisma/schema.sql"), "utf8");
  const missingBootstrap = models.filter((m) => !bootstrap.includes(`"${m}"`));
  check(
    "prisma/schema.sql covers every model (desktop bootstrap)",
    missingBootstrap.length === 0,
    missingBootstrap.length
      ? `${missingBootstrap.join(", ")} - run: npm run db:sql`
      : ""
  );
}

/* ---------- 4. Privileged routes use the right guard ---------- */
console.log("\nPrivileged routes are guarded");
{
  const instanceRoutes = [
    ...walk(path.join(root, "src/app/api/admin"), (f) => f.endsWith("route.ts")),
    ...walk(path.join(root, "src/app/api/instance"), (f) => f.endsWith("route.ts")),
  ];
  const wrong = instanceRoutes.filter((f) => {
    const text = readFileSync(f, "utf8");
    return /\brequireOwner\b/.test(text) || !/\brequireInstanceOwner\b/.test(text);
  });
  check(
    `${instanceRoutes.length} instance-wide routes use requireInstanceOwner`,
    wrong.length === 0,
    wrong.map(rel).join(", ")
  );

  // Every route handler must authenticate somehow. The exceptions are
  // deliberate and listed, so adding a new unauthenticated route is a choice
  // someone has to make explicitly here.
  const PUBLIC = new Set([
    "src/app/api/health/route.ts",
    "src/app/api/auth/google/route.ts",
    "src/app/api/auth/google/callback/route.ts",
    "src/app/api/auth/desktop-claim/route.ts",
    "src/app/api/auth/desktop-status/route.ts",
    "src/app/api/auth/webauthn/authenticate/options/route.ts",
    "src/app/api/auth/webauthn/authenticate/verify/route.ts",
  ]);
  const all = walk(path.join(root, "src/app/api"), (f) => f.endsWith("route.ts"));
  const unguarded = all.filter((f) => {
    if (PUBLIC.has(rel(f))) return false;
    const text = readFileSync(f, "utf8");
    return !/require(Context|Editor|Owner|InstanceOwner)|getCurrentUser|getCurrentContext/.test(text);
  });
  check(
    `${all.length - PUBLIC.size} non-public routes authenticate the caller`,
    unguarded.length === 0,
    unguarded.map(rel).join(", ")
  );
}

/* ---------- 5. No secrets committed ---------- */
console.log("\nNo secrets in the tree");
{
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const envLike = tracked.filter((f) => /^\.env/.test(f) && !/\.example$/.test(f));
  check("no .env file is tracked", envLike.length === 0, envLike.join(", "));

  // Long random-looking assignments in tracked files, excluding lockfiles and
  // the example env files (whose values are placeholders).
  const suspicious = [];
  for (const f of tracked) {
    if (/package-lock\.json|\.example$|\.md$|\.sql$/.test(f)) continue;
    const full = path.join(root, f);
    try {
      if (statSync(full).size > 512 * 1024) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(
        /(SECRET|PASSWORD|PASSPHRASE|_KEY|TOKEN)\s*[:=]\s*["']([A-Za-z0-9+/_-]{24,})["']/g
      )) {
        // Placeholders and env lookups are fine.
        if (/^(your|change|xxx|placeholder|example)/i.test(m[2])) continue;
        suspicious.push(`${f}: ${m[1]}`);
      }
    } catch {
      /* binary or unreadable */
    }
  }
  check("no hard-coded secrets", suspicious.length === 0, suspicious.join(", "));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
