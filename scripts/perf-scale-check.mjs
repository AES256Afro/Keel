#!/usr/bin/env node
// Performance at scale.
//
// Sub-10ms on an empty workspace proves nothing - every over-fetch and missing
// index the sweeps found was invisible until there was data. This seeds a
// deliberately large workspace and measures the paths those fixes touched, so
// a regression shows up as a number rather than as a slow app somebody notices
// months later.
//
// Budgets are generous on purpose: they are regression alarms, not benchmarks.
// A 10x blowout should fail; normal machine-to-machine variation should not.
//
//   npm run build && node scripts/perf-scale-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "perf-scale-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.PERF_PORT || 3215);
const BASE = `http://127.0.0.1:${PORT}`;

const PAGES = 600;
const RECORDS = 800;
const COMMENTS = 500;

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

async function waitFor(url, tries = 200) {
  while (tries-- > 0) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Median of N timed requests - median, not mean, so one GC pause doesn't fail a run. */
async function timeIt(url, headers, samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers, cache: "no-store" });
    await res.arrayBuffer();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)]);
}

cleanDatabase(root, DB_NAME);
console.log(`Seeding a large workspace (${PAGES} pages, ${RECORDS} records, ${COMMENTS} comments)…`);
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "perf@example.test", name: "P", username: "perf", passwordHash: "x", onboardedAt: new Date() },
});
const ws = await prisma.workspace.create({
  data: { name: "Perf", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

// A document with real body text, so `content` is not trivially small - the
// getDatabaseDTO over-fetch was invisible with empty documents.
const body = (n) =>
  JSON.stringify({
    type: "doc",
    content: Array.from({ length: 12 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Page ${n} paragraph ${i}: ${"lorem ipsum ".repeat(12)}` }],
    })),
  });

const root1 = await prisma.page.create({
  data: {
    workspaceId: ws.id, type: "document", title: "Perf root", content: body(0),
    plainText: "root", createdById: user.id, sortOrder: 0,
  },
});
// A deep-ish tree so the sequence-read BFS has levels to walk.
let parent = root1.id;
for (let i = 1; i <= PAGES; i++) {
  const p = await prisma.page.create({
    data: {
      workspaceId: ws.id, type: "document", title: `Page ${i}`, content: body(i),
      plainText: `page ${i} lorem`, createdById: user.id,
      parentPageId: i % 10 === 0 ? root1.id : parent, sortOrder: i,
    },
  });
  if (i % 10 === 0) parent = p.id;
}

const dbPage = await prisma.page.create({
  data: {
    workspaceId: ws.id, type: "database", title: "Big database", content: "{}",
    plainText: "", createdById: user.id, sortOrder: 9999,
  },
});
const database = await prisma.database.create({ data: { workspaceId: ws.id, pageId: dbPage.id } });
const status = await prisma.databaseProperty.create({
  data: { databaseId: database.id, name: "Status", type: "select", sortOrder: 1,
    settings: JSON.stringify({ options: [{ id: "a", label: "Todo" }, { id: "b", label: "Doing" }, { id: "c", label: "Done" }] }) },
});
for (let i = 0; i < RECORDS; i++) {
  const rp = await prisma.page.create({
    data: {
      workspaceId: ws.id, type: "record", title: `Record ${i}`, content: body(i),
      plainText: `record ${i}`, createdById: user.id, parentPageId: dbPage.id, sortOrder: i,
    },
  });
  const rec = await prisma.databaseRecord.create({
    data: { databaseId: database.id, pageId: rp.id, sortOrder: i },
  });
  await prisma.databaseValue.create({
    data: { recordId: rec.id, propertyId: status.id, value: JSON.stringify(["a", "b", "c"][i % 3]) },
  });
}
for (let i = 0; i < COMMENTS; i++) {
  await prisma.comment.create({
    data: { pageId: root1.id, authorId: user.id, body: `Comment ${i}`,
      ...(i % 3 === 0 ? { resolvedAt: new Date() } : {}) },
  });
}
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
  stdio: "ignore",
  shell: process.platform === "win32",
});
const auth = { cookie: `keel_session=${token}` };

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");
  // One warm pass so JIT/connection setup isn't measured as latency.
  await fetch(`${BASE}/api/health`, { headers: auth }).then((r) => r.arrayBuffer());

  console.log(`\nAt ${PAGES} pages / ${RECORDS} records / ${COMMENTS} comments\n`);

  const health = await timeIt(`${BASE}/api/health`, auth);
  check("health stays instant", health < 150, `${health}ms`);

  const graph = await timeIt(`${BASE}/api/graph`, auth);
  check("the graph API is bounded (MAX_NODES caps it)", graph < 2000, `${graph}ms`);

  const search = await timeIt(`${BASE}/api/search?q=lorem`, auth);
  check("search over 1400 documents", search < 2500, `${search}ms`);

  const comments = await timeIt(`${BASE}/api/pages/${root1.id}/comments`, auth);
  check("comments are capped, not whole-thread", comments < 1500, `${comments}ms`);

  const read = await timeIt(`${BASE}/read/${root1.id}`, auth);
  check("sequence read is bounded by MAX_SECTIONS, not the tree", read < 3000, `${read}ms`);

  const dbView = await timeIt(`${BASE}/p/${dbPage.id}`, auth);
  check("opening an 800-record database", dbView < 5000, `${dbView}ms`);

  const csv = await timeIt(`${BASE}/api/databases/${database.id}/export`, auth, 3);
  check("CSV export of 800 records", csv < 5000, `${csv}ms`);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.message}\n`);
  failures.push(err.message);
} finally {
  server.kill();
  cleanDatabase(root, DB_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
