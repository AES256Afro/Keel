#!/usr/bin/env node
// Split view (/p/A?with=B), in a real browser.
//
// The interesting failures are all cross-cutting: two live editors autosaving
// through the same API without clobbering each other, a URL parameter that is
// user input feeding a server-rendered second pane, and a divider whose state
// lives in localStorage. None of that is reachable from the API suites.
//
// The one that matters most is the leak guard: `with` accepts any page id, so
// a page from another workspace must degrade to the single-page view - its
// content appearing in the right pane would be a cross-tenant read.
//
//   npm run build && node scripts/split-browser-check.mjs
//
// Env:
//   CHROMIUM   override the auto-detected Chromium (see find-chromium.mjs)
//   SPLIT_PORT
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "split-browser-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.SPLIT_PORT || 3195);
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

const doc = (title) =>
  `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${title} body"}]}]}`;

cleanDatabase(root, DB_NAME);
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "sp@example.test", name: "S", username: "sp", passwordHash: "x" },
});
const ws = await prisma.workspace.create({
  data: { name: "S", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

const mk = (title, type = "document", workspaceId = ws.id, extra = {}) =>
  prisma.page.create({
    data: {
      workspaceId,
      type,
      title,
      content: doc(title),
      plainText: `${title} body`,
      createdById: user.id,
      sortOrder: 0,
      ...extra,
    },
  });

const left = await mk("Draft");
const right = await mk("Notes");
const database = await mk("Tasks", "database", ws.id, { content: "{}" });

// Another user's workspace - the page whose body must never render.
const outsider = await prisma.user.create({
  data: { email: "out@example.test", name: "O", username: "out", passwordHash: "x" },
});
const otherWs = await prisma.workspace.create({
  data: {
    name: "O",
    ownerId: outsider.id,
    members: { create: { userId: outsider.id, role: "owner" } },
  },
});
const foreign = await prisma.page.create({
  data: {
    workspaceId: otherWs.id,
    type: "document",
    title: "Foreign secrets",
    content: doc("TOPSECRET-MARKER"),
    plainText: "TOPSECRET-MARKER body",
    createdById: outsider.id,
    sortOrder: 0,
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
    args: ["--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies([
    { name: "keel_session", value: token, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

  const editors = () => page.locator(".ProseMirror").count();

  /* ---------------- Two panes render and edit ---------------- */
  console.log("\nTwo live panes");

  await page.goto(`${BASE}/p/${left.id}?with=${right.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-split-pane="right"] .ProseMirror');
  check("both panes mount an editor", (await editors()) === 2, `${await editors()} editors`);

  const leftText = await page.locator('[data-split-pane="left"]').innerText();
  const rightText = await page.locator('[data-split-pane="right"]').innerText();
  check("left pane shows the left document", leftText.includes("Draft body"));
  check("right pane shows the right document", rightText.includes("Notes body"));

  // Type into each pane and verify each save lands on the right row.
  await page.click('[data-split-pane="left"] .ProseMirror');
  await page.keyboard.press("End");
  await page.keyboard.type(" LEFTEDIT");
  await page.click('[data-split-pane="right"] .ProseMirror');
  await page.keyboard.press("End");
  await page.keyboard.type(" RIGHTEDIT");

  // Autosave debounce is 700ms; poll the database rather than guessing at
  // timing - what's in the row is the ground truth anyway.
  const db = await testPrisma(root, DB_URL);
  const content = async (id) =>
    (await db.page.findUnique({ where: { id }, select: { content: true } }))?.content ?? "";
  let leftSaved = false;
  let rightSaved = false;
  for (let i = 0; i < 40 && !(leftSaved && rightSaved); i++) {
    await page.waitForTimeout(250);
    leftSaved = (await content(left.id)).includes("LEFTEDIT");
    rightSaved = (await content(right.id)).includes("RIGHTEDIT");
  }
  check("the left pane's edit saved to the left page", leftSaved);
  check("the right pane's edit saved to the right page", rightSaved);

  // And not to each other - the same-API-different-ids failure mode.
  check("panes do not clobber each other", !(await content(left.id)).includes("RIGHTEDIT"));
  await db.$disconnect();

  /* ---------------- The URL is the state ---------------- */
  console.log("\nThe split is a URL");

  await page.click('[data-split-pane="left"] button[title="Swap sides"]');
  await page.waitForURL(`**/p/${right.id}?with=${left.id}`);
  check("swap flips the URL", true);
  await page.waitForSelector('[data-split-pane="left"] .ProseMirror');
  const swappedLeft = await page.locator('[data-split-pane="left"]').innerText();
  check("after swapping, the panes trade places", swappedLeft.includes("Notes body"));

  await page.click('[data-split-pane="right"] button[title="Close this pane"]');
  await page.waitForURL(`**/p/${right.id}`);
  await page.waitForFunction(() => document.querySelectorAll(".ProseMirror").length === 1);
  check("closing a pane returns to the single view", true);

  /* ---------------- Invalid ?with= degrades, never errors ---------------- */
  console.log("\nHostile and nonsense ?with= values");

  const single = async (withValue, name) => {
    await page.goto(`${BASE}/p/${left.id}?with=${withValue}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".ProseMirror");
    const n = await editors();
    const body = await page.evaluate(() => document.body.innerText);
    check(name, n === 1, `${n} editors`);
    return body;
  };

  const leaked = await single(foreign.id, "a page from another workspace is refused");
  check("the foreign page's content is nowhere in the response", !leaked.includes("TOPSECRET"));
  await single(left.id, "with=self is ignored");
  await single(database.id, "with=<database> is ignored");
  await single("does-not-exist", "with=<garbage id> is ignored");

  /* ---------------- The divider ---------------- */
  console.log("\nThe divider");

  await page.goto(`${BASE}/p/${left.id}?with=${right.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-split-pane="right"] .ProseMirror');

  const widthOf = async () =>
    (await page.locator('[data-split-pane="left"]').boundingBox())?.width ?? 0;

  const before = await widthOf();
  const divider = await page.locator('[role="separator"]').boundingBox();
  await page.mouse.move(divider.x + 2, divider.y + 400);
  await page.mouse.down();
  await page.mouse.move(divider.x - 200, divider.y + 400, { steps: 5 });
  await page.mouse.up();
  const after = await widthOf();
  check("dragging the divider resizes the panes", before - after > 120, `${before} → ${after}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-split-pane="right"] .ProseMirror');
  const reloaded = await widthOf();
  check(
    "the ratio survives a reload",
    Math.abs(reloaded - after) < 30,
    `${after} → ${reloaded} after reload`
  );

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
