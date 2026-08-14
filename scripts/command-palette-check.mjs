#!/usr/bin/env node
// Browser-level contracts for the global command palette and trash undo.
//
//   npm run build && npm run test:palette

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbName = "command-palette-check";
const databaseUrl = testDatabaseUrl(root, dbName);
const port = Number(process.env.PALETTE_PORT || 3297);
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function serverReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

cleanDatabase(root, dbName);
prepareDatabase(root, databaseUrl);
const prisma = await testPrisma(root, databaseUrl);
const user = await prisma.user.create({
  data: {
    email: "palette@example.test",
    name: "Palette User",
    username: "palette-user",
    passwordHash: "x",
    onboardedAt: new Date(),
  },
});
const workspace = await prisma.workspace.create({
  data: {
    name: "Palette Workspace",
    ownerId: user.id,
    members: { create: { userId: user.id, role: "owner" } },
  },
});
const roadmap = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Roadmap alpha",
    content: '{"type":"doc","content":[{"type":"paragraph"}]}',
    plainText: "Everyday speed milestone",
    createdById: user.id,
    sortOrder: 1,
  },
});
const scratch = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Scratch pad",
    content: '{"type":"doc","content":[{"type":"paragraph"}]}',
    plainText: "",
    createdById: user.id,
    sortOrder: 2,
  },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
});

const server = spawn("npx", ["next", "start", "-p", String(port)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "production", PORT: String(port) },
  stdio: "ignore",
  shell: process.platform === "win32",
});

let browser;
try {
  if (!(await serverReady())) throw new Error("server did not start");
  browser = await chromium.launch({
    ...chromiumLaunchOptions(),
    args: ["--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: "keel_session", value: token, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}/p/${scratch.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Search and commands" }).waitFor();

  console.log("\nCommand palette");
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await palette.waitFor();
  check("Cmd-K opens the global palette", await palette.isVisible());
  check("empty palette offers New page", await palette.getByText("New page", { exact: true }).isVisible());
  check(
    "empty palette offers today's note",
    await palette.getByText("Open today's note", { exact: true }).isVisible()
  );

  const input = palette.getByRole("textbox", { name: "Search pages or run a command" });
  await input.fill("settings");
  await palette.getByText("Open settings", { exact: true }).waitFor();
  check("typing filters commands", !(await palette.getByText("New page", { exact: true }).isVisible()));
  await page.keyboard.press("Enter");
  await page.waitForURL(`${base}/settings`);
  check("Enter executes the selected command", page.url() === `${base}/settings`);

  await page.keyboard.press("Control+K");
  const searchPalette = page.getByRole("dialog", { name: "Search and commands" });
  await searchPalette.getByRole("textbox").fill("Roadmap alpha");
  await searchPalette.getByText("Roadmap alpha", { exact: true }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${base}/p/${roadmap.id}`);
  check("page search remains part of the palette", page.url().endsWith(`/p/${roadmap.id}`));

  console.log("\nTrash undo");
  await page.goto(`${base}/p/${scratch.id}`, { waitUntil: "domcontentloaded" });
  const roadmapRow = page.locator("aside .group").filter({ hasText: "Roadmap alpha" }).first();
  await roadmapRow.hover();
  await roadmapRow.getByTitle("Page actions").click();
  await page.getByRole("button", { name: /Move to trash/ }).click();
  const undoStatus = page.getByRole("status").filter({ hasText: "Moved page to trash" });
  await undoStatus.waitFor();
  const archived = await prisma.page.findUnique({ where: { id: roadmap.id } });
  check("trashing archives the page", archived?.archivedAt instanceof Date);
  await undoStatus.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForURL(`${base}/p/${roadmap.id}`);
  const restored = await prisma.page.findUnique({ where: { id: roadmap.id } });
  check("Undo restores the same page", restored?.archivedAt === null);
  check("Undo returns to the restored page", page.url().endsWith(`/p/${roadmap.id}`));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 400));
  cleanDatabase(root, dbName);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  • ${failure}`);
  process.exit(1);
}
