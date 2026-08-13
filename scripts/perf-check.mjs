#!/usr/bin/env node
// Performance regression checks.
//
// Not a benchmark suite - a set of upper bounds on operations that were
// quadratic or N+1 and would silently become slow again. Each seeds a workspace
// large enough that the old implementation would visibly miss the budget.
//
//   node scripts/perf-check.mjs
//   SCALE=3 node scripts/perf-check.mjs   # bigger, slower, more decisive
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "perf-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.PERF_PORT || 3194);
const BASE = `http://localhost:${PORT}`;
const SCALE = Number(process.env.SCALE || 1);

const PAGES = 400 * SCALE;
const RECORDS = 500 * SCALE;
const PROPERTIES = 8;

let passed = 0;
const failures = [];
function budget(name, ms, limit) {
  const ok = ms <= limit;
  const line = `${name} - ${ms.toFixed(0)}ms (budget ${limit}ms)`;
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${line}`);
  } else {
    failures.push(line);
    console.log(`  \x1b[31m✗ ${line}\x1b[0m`);
  }
}

const time = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
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

async function seed() {
  const prisma = await testPrisma(root, DB_URL);
  const user = await prisma.user.create({
    data: { email: "perf@example.test", name: "Perf", username: "perf", passwordHash: "x" },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "Perf", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
  });

  // A deep-ish page tree, which is what getPageTree walks on every navigation.
  console.log(`  seeding ${PAGES} pages…`);
  const pageIds = [];
  for (let i = 0; i < PAGES; i++) {
    const parentPageId = i > 0 && i % 3 !== 0 ? pageIds[Math.floor(i / 3)] : null;
    const p = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentPageId,
        type: "document",
        title: `Page ${i}`,
        content: '{"type":"doc","content":[{"type":"paragraph"}]}',
        sortOrder: i,
        createdById: user.id,
      },
    });
    pageIds.push(p.id);
  }

  console.log(`  seeding a database with ${RECORDS} records × ${PROPERTIES} properties…`);
  const dbPage = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "database",
      title: "Big",
      createdById: user.id,
      sortOrder: PAGES + 1,
    },
  });
  const db = await prisma.database.create({
    data: { workspaceId: workspace.id, pageId: dbPage.id },
  });
  const properties = [];
  for (let i = 0; i < PROPERTIES; i++) {
    properties.push(
      await prisma.databaseProperty.create({
        data: { databaseId: db.id, name: `P${i}`, type: "text", sortOrder: i },
      })
    );
  }
  const recordIds = [];
  for (let i = 0; i < RECORDS; i++) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentPageId: dbPage.id,
        type: "record",
        title: `Record ${i}`,
        content: '{"type":"doc","content":[{"type":"paragraph"}]}',
        createdById: user.id,
      },
    });
    const rec = await prisma.databaseRecord.create({
      data: {
        databaseId: db.id,
        pageId: page.id,
        sortOrder: i,
        parentRecordId: i > 0 ? recordIds[Math.floor(i / 4)] : null,
      },
    });
    recordIds.push(rec.id);
    await prisma.databaseValue.createMany({
      data: properties.map((p) => ({
        recordId: rec.id,
        propertyId: p.id,
        value: JSON.stringify(`v${i}`),
      })),
    });
  }

  const firstRecordPage = await prisma.databaseRecord.findFirst({
    where: { databaseId: db.id },
    select: { pageId: true },
  });
  await prisma.$disconnect();
  return { token, workspace, dbPageId: dbPage.id, recordPageId: firstRecordPage.pageId };
}

async function main() {
  cleanDatabase(root, DB_NAME);
  console.log("Preparing scratch database…");
  prepareDatabase(root, DB_URL);
  const ids = await seed();

  console.log(`Starting server on :${PORT}…`);
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  const get = (url) =>
    fetch(BASE + url, { headers: { Cookie: `keel_session=${ids.token}` } });
  const post = (url, body) =>
    fetch(BASE + url, {
      method: "POST",
      headers: {
        Cookie: `keel_session=${ids.token}`,
        "Content-Type": "application/json",
        Origin: BASE,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(body ?? {}),
    });

  try {
    if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");
    // Warm the process so the first measurement isn't JIT and connection setup.
    await get(`/p/${ids.dbPageId}`);
    await get("/trash");

    console.log(`\nAt ${PAGES} pages / ${RECORDS} records × ${PROPERTIES} properties`);

    // getPageTree runs in the sidebar layout on every navigation. It used
    // pages.some() inside a loop over pages.
    {
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await time(() => get("/trash"))).ms);
      budget("sidebar page tree (O(n) not O(n²))", Math.min(...runs), 1500);
    }

    // A record page used to load every sibling record and value.
    {
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await time(() => get(`/p/${ids.recordPageId}`))).ms);
      const ms = Math.min(...runs);
      budget("opening one record does not load the database", ms, 800);

      const html = await (await get(`/p/${ids.recordPageId}`)).text();
      // The payload should not carry hundreds of sibling titles.
      const siblings = (html.match(/Record \d+/g) ?? []).length;
      const ok = siblings < 50;
      if (ok) {
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m record payload carries ${siblings} record titles, not ${RECORDS}`);
      } else {
        failures.push(`record payload carries ${siblings} record titles`);
        console.log(`  \x1b[31m✗ record payload carries ${siblings} record titles\x1b[0m`);
      }
    }

    // snapshotWorkspace filtered values with Array.some inside filter.
    {
      const { ms } = await time(() => post("/api/workspace/export"));
      budget("full workspace export (O(n) value filtering)", ms, 4000);
    }

    // restoreSnapshot did one insert per row, sequentially.
    {
      const res = await post("/api/workspace/backups", {});
      const data = await res.json();
      const name = data.backups?.[0]?.name;
      const { ms } = await time(() =>
        post("/api/workspace/backups/restore", { filename: name })
      );
      budget("restore uses batched inserts", ms, 20000);
    }

    // The database page itself.
    {
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await time(() => get(`/p/${ids.dbPageId}`))).ms);
      budget("database board renders", Math.min(...runs), 3000);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    cleanDatabase(root, DB_NAME);
  }

  console.log(`\n${passed} within budget, ${failures.length} over`);
  if (failures.length) {
    console.log("\nOver budget:");
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  cleanDatabase(root, DB_NAME);
  process.exit(1);
});
