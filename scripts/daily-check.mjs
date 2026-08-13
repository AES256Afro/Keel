#!/usr/bin/env node
// Daily notes: /today finds or creates the day's page and redirects to it.
//
// The property that matters is idempotence - "go to today" hit twice, from two
// tabs, on two days, must converge on one page per day rather than sprouting
// duplicates. That is an HTTP-level behaviour (redirects, auth, the ?d
// parameter), so this drives the real server.
//
//   npm run build && node scripts/daily-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "daily-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.DAILY_PORT || 3198);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
};

async function waitFor(url, tries = 160) {
  while (tries-- > 0) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

cleanDatabase(root, DB_NAME);
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "d@example.test", name: "D", username: "d", passwordHash: "x" },
});
const ws = await prisma.workspace.create({
  data: { name: "D", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

// A page that already links to a future daily note - the link should resolve
// the moment the note is created.
const linking = await prisma.page.create({
  data: {
    workspaceId: ws.id,
    type: "document",
    title: "Planning",
    content: "{}",
    plainText: "see [[2026-09-15]]",
    createdById: user.id,
    sortOrder: 0,
  },
});
await prisma.pageLink.create({
  data: {
    workspaceId: ws.id,
    fromPageId: linking.id,
    toPageId: null,
    targetTitle: "2026-09-15",
  },
});

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
  stdio: "ignore",
  shell: process.platform === "win32",
});

const get = (d, cookie = true) =>
  fetch(`${BASE}/today${d ? `?d=${encodeURIComponent(d)}` : ""}`, {
    redirect: "manual",
    headers: cookie ? { cookie: `keel_session=${token}` } : {},
  });
const target = (res) => new URL(res.headers.get("location"), BASE).pathname;

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  console.log("\nFind-or-create\n");

  const first = await get("2026-09-15");
  check("redirects to a page", first.status === 307 && target(first).startsWith("/p/"), `status ${first.status} → ${first.headers.get("location")}`);

  const again = await get("2026-09-15");
  check("the same day resolves to the same page", target(again) === target(first), `${target(first)} vs ${target(again)}`);

  const note = await prisma.page.findFirst({
    where: { workspaceId: ws.id, title: "2026-09-15" },
    include: { parent: true },
  });
  check("the note is titled with its date", Boolean(note));
  check("it lives under a Daily notes parent", note?.parent?.title === "Daily notes", note?.parent?.title ?? "no parent");

  const folders = await prisma.page.count({
    where: { workspaceId: ws.id, title: "Daily notes" },
  });
  check("exactly one Daily notes folder exists", folders === 1, `${folders}`);

  const other = await get("2026-09-16");
  check("a different day is a different page", target(other) !== target(first));
  const notes = await prisma.page.count({
    where: { workspaceId: ws.id, parentPageId: note.parentPageId, type: "document" },
  });
  check("both notes share the one folder", notes === 2, `${notes}`);

  console.log("\nHammering it concurrently\n");

  // Ten simultaneous requests for a brand-new day: the race window in
  // find-or-create, hit deliberately.
  const day = "2026-10-01";
  const burst = await Promise.all(Array.from({ length: 10 }, () => get(day)));
  const targets = new Set(burst.map(target));
  check("ten concurrent requests converge on one page", targets.size === 1, [...targets].join(", "));
  // The per-workspace serialization makes the strong claim hold: not merely
  // "losers are invisible" but no duplicate is ever left behind at all.
  const copies = await prisma.page.count({ where: { workspaceId: ws.id, title: day } });
  check("exactly one page exists for the day", copies === 1, `${copies} copies`);

  console.log("\nThe ?d parameter is untrusted input\n");

  const bogus = [
    ["2026-02-31", "an impossible date"],
    ["not-a-date", "garbage"],
    ["2026-09-15T12:00:00Z<script>", "a datetime with extras"],
    ["", "empty"],
  ];
  for (const [d, label] of bogus) {
    const res = await get(d);
    const ok = res.status === 307 && target(res).startsWith("/p/");
    // Falls back to the server's day - never a 500, never a literal-garbage title.
    check(`${label} falls back cleanly`, ok, `status ${res.status}`);
  }
  const garbagePages = await prisma.page.count({
    where: { workspaceId: ws.id, title: { in: ["not-a-date", "2026-02-31"] } },
  });
  check("no page was created with a garbage title", garbagePages === 0, `${garbagePages}`);

  console.log("\nAuth and links\n");

  const anon = await get("2026-09-15", false);
  check("signed out redirects to login", anon.status === 307 && target(anon) === "/login", `${anon.status} → ${anon.headers.get("location")}`);

  const link = await prisma.pageLink.findFirst({
    where: { workspaceId: ws.id, targetTitle: "2026-09-15" },
  });
  check("a pre-existing [[2026-09-15]] link now resolves to the note", link?.toPageId === note?.id);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.message}\n`);
  failures.push(err.message);
} finally {
  await prisma.$disconnect();
  server.kill();
  cleanDatabase(root, DB_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
