#!/usr/bin/env node
// The graph view, in a real browser.
//
// graph-check.mjs covers the layout maths; none of it proves anything reaches
// the screen. A canvas can mount, size itself correctly and paint absolutely
// nothing - no error, no failed request, just an empty rectangle. That failure
// is invisible to every other suite, so this one reads the pixels back.
//
//   npm run build && node scripts/graph-browser-check.mjs
//
// Env:
//   CHROMIUM   override the auto-detected Chromium (see find-chromium.mjs)
//   GRAPH_PORT
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "graph-browser-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.GRAPH_PORT || 3193);
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
  data: { email: "g@example.test", name: "G", username: "g", passwordHash: "x" },
});
const workspace = await prisma.workspace.create({
  data: { name: "G", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

// A hub with spokes, plus an unconnected page - enough shape that hover
// highlighting and the orphan filter both have something to act on.
const TITLES = ["Hub", "Alpha", "Beta", "Gamma", "Delta", "Lonely"];
const pages = {};
for (const [i, title] of TITLES.entries()) {
  pages[title] = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "document",
      title,
      content: '{"type":"doc","content":[{"type":"paragraph"}]}',
      plainText: "",
      createdById: user.id,
      sortOrder: i,
    },
  });
}
for (const spoke of ["Alpha", "Beta", "Gamma", "Delta"]) {
  await prisma.pageLink.create({
    data: {
      workspaceId: workspace.id,
      fromPageId: pages.Hub.id,
      toPageId: pages[spoke].id,
      targetTitle: spoke.toLowerCase(),
    },
  });
}
// A record inside a database: must NOT appear, or real workspaces would be
// swamped by rows nobody thinks of as pages.
const db = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "database",
    title: "Tasks",
    content: "{}",
    plainText: "",
    createdById: user.id,
    sortOrder: 99,
  },
});
await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "record",
    title: "A task row",
    content: "{}",
    plainText: "",
    createdById: user.id,
    parentPageId: db.id,
    sortOrder: 1,
  },
});
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: DB_URL,
    NODE_ENV: "production",
    PORT: String(PORT),
    KEEL_SITE_URL: BASE,
  },
  stdio: "ignore",
  shell: process.platform === "win32",
});

let browser;
try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  browser = await chromium.launch({
    ...chromiumLaunchOptions(),
    // Chrome honours the system proxy; curl does not. Tailscale or a corporate
    // PAC file will otherwise route 127.0.0.1 through it and the failure looks
    // like an app bug.
    args: ["--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([
    { name: "keel_session", value: token, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [console]", m.text().slice(0, 160));
  });

  /* ---------------- It renders ---------------- */
  console.log("\nThe graph renders");

  await page.goto(`${BASE}/graph`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  check("the canvas mounts", true);

  // Wait for the fetch + settle to have painted something.
  const painted = await page
    .waitForFunction(
      () => {
        const c = document.querySelector("canvas");
        if (!c || !c.width) return false;
        const ctx = c.getContext("2d");
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
        return false;
      },
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  check("the canvas actually has pixels drawn on it", painted, painted ? "" : "canvas is blank");

  const ink = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
    return { painted: n, total: data.length / 4 };
  });
  // Nodes and edges only, so most of the canvas is legitimately empty - but a
  // handful of stray pixels would mean the layout collapsed to a point.
  check(
    "the drawing covers a plausible area",
    ink.painted > 2000 && ink.painted < ink.total * 0.9,
    `${ink.painted} of ${ink.total} pixels`
  );

  /* ---------------- It shows the right things ---------------- */
  console.log("\nThe right pages, and only those");

  const api = await page.evaluate(async () => (await fetch("/api/graph")).json());
  const titles = api.nodes.map((n) => n.title).sort();
  check(
    "every document and database is a node",
    ["Alpha", "Beta", "Delta", "Gamma", "Hub", "Lonely", "Tasks"].every((t) => titles.includes(t)),
    titles.join(", ")
  );
  check("database records are excluded", !titles.includes("A task row"), titles.join(", "));
  check("the four hub links are edges", api.edges.length === 4, `${api.edges.length} edges`);

  const hub = api.nodes.find((n) => n.title === "Hub");
  const lonely = api.nodes.find((n) => n.title === "Lonely");
  check("the hub's degree counts its links", hub?.degree === 4, `degree ${hub?.degree}`);
  check("an unlinked page has degree 0", lonely?.degree === 0, `degree ${lonely?.degree}`);

  const noOrphans = await page.evaluate(async () =>
    (await fetch("/api/graph?orphans=0")).json()
  );
  check(
    "hiding orphans drops the unlinked page",
    !noOrphans.nodes.some((n) => n.title === "Lonely"),
    noOrphans.nodes.map((n) => n.title).join(", ")
  );
  check(
    "hiding orphans keeps every edge's endpoints",
    noOrphans.edges.every(
      (e) =>
        noOrphans.nodes.some((n) => n.id === e.source) &&
        noOrphans.nodes.some((n) => n.id === e.target)
    )
  );

  /* ---------------- It comes to rest ---------------- */
  console.log("\nIt settles, and stays settled");

  // Sample the canvas twice, a second apart, with no interaction. A layout that
  // never cools would differ; this is the regression guard for the jitter.
  const hash = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas");
      const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      let h = 0;
      for (let i = 3; i < data.length; i += 4) h = (h * 31 + data[i]) | 0;
      return h;
    });
  // Annealing takes ~200 frames from a reheat, and wall-clock per frame varies
  // by machine and browser - a fixed sample window measures the host, not the
  // layout. So: wait for quiescence with a generous deadline (a layout that
  // never cools blows the deadline), THEN assert it stays at rest.
  let prev = await hash();
  let settledAt = -1;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const cur = await hash();
    if (cur === prev) {
      settledAt = Date.now();
      break;
    }
    prev = cur;
  }
  check("the graph comes to rest within 15s", settledAt > 0);
  await page.waitForTimeout(1200);
  const later = await hash();
  check("and stays at rest a second later", later === prev, `${prev} vs ${later}`);

  /* ---------------- It responds ---------------- */
  console.log("\nInteraction");

  const box = await page.locator("canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);

  // Find a node on screen and click it - it should open that page.
  const target = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return { w: c.clientWidth, h: c.clientHeight };
  });
  check("the canvas has real dimensions", target.w > 100 && target.h > 100, `${target.w}×${target.h}`);

  const before = page.url();
  // Sweep for a node: hovering one changes the cursor to a pointer.
  let found = null;
  for (let gx = 0.2; gx <= 0.8 && !found; gx += 0.05) {
    for (let gy = 0.2; gy <= 0.8 && !found; gy += 0.05) {
      const x = box.x + box.width * gx;
      const y = box.y + box.height * gy;
      await page.mouse.move(x, y);
      const cursor = await page.evaluate(
        () => getComputedStyle(document.querySelector("canvas")).cursor
      );
      if (cursor === "pointer") found = { x, y };
    }
  }
  check("hovering a node is discoverable (cursor becomes a pointer)", Boolean(found));

  if (found) {
    await page.mouse.click(found.x, found.y);
    await page.waitForTimeout(1200);
    check(
      "clicking a node opens its page",
      page.url() !== before && /\/p\//.test(page.url()),
      page.url()
    );
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.message}\n`);
  failures.push(err.message);
} finally {
  await browser?.close();
  server.kill();
  cleanDatabase(root, DB_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
