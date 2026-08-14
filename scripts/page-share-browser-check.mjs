#!/usr/bin/env node
// Browser and HTTP boundaries for read-only public document links.
// Run after `npm run build`.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbName = "page-share-browser-check";
const databaseUrl = testDatabaseUrl(root, dbName);
const port = Number(process.env.PAGE_SHARE_PORT || 3296);
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
const owner = await prisma.user.create({
  data: { email: "share-owner@example.test", name: "Share Owner", username: "share-owner", passwordHash: "x", onboardedAt: new Date() },
});
const editor = await prisma.user.create({
  data: { email: "share-editor@example.test", name: "Share Editor", username: "share-editor", passwordHash: "x", onboardedAt: new Date() },
});
const workspace = await prisma.workspace.create({
  data: {
    name: "Share Workspace",
    ownerId: owner.id,
    members: {
      create: [
        { userId: owner.id, role: "owner" },
        { userId: editor.id, role: "editor" },
      ],
    },
  },
});
const ownerToken = randomBytes(32).toString("hex");
const editorToken = randomBytes(32).toString("hex");
await prisma.session.createMany({
  data: [ownerToken, editorToken].map((token, index) => ({
    token,
    userId: index === 0 ? owner.id : editor.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  })),
});
const page = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Public launch checklist",
    plainText: "Safe public sharing marker",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Safe public sharing marker" }] },
      ],
    }),
    createdById: owner.id,
  },
});
const foreignPage = await prisma.page.create({
  data: { workspaceId: workspace.id, type: "document", title: "Private sibling", createdById: owner.id },
});
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const attachment = await prisma.attachment.create({
  data: {
    workspaceId: workspace.id,
    pageId: page.id,
    name: "pixel.png",
    mime: "image/png",
    size: pixel.length,
    sha256: createHash("sha256").update(pixel).digest("hex"),
    data: pixel,
    createdById: owner.id,
  },
});
const foreignAttachment = await prisma.attachment.create({
  data: {
    workspaceId: workspace.id,
    pageId: foreignPage.id,
    name: "foreign.png",
    mime: "image/png",
    size: pixel.length,
    sha256: createHash("sha256").update(Buffer.concat([pixel, Buffer.from("foreign")])).digest("hex"),
    data: pixel,
    createdById: owner.id,
  },
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
    { name: "keel_session", value: ownerToken, domain: "127.0.0.1", path: "/" },
    { name: "keel-workspace", value: workspace.id, domain: "127.0.0.1", path: "/" },
  ]);
  const browserPage = await context.newPage();
  browserPage.setDefaultTimeout(15_000);
  await browserPage.goto(`${base}/p/${page.id}`, { waitUntil: "domcontentloaded" });

  const shareButton = browserPage.getByTitle("Create or manage a read-only public link");
  await shareButton.waitFor();
  check("the workspace owner sees the Share action", await shareButton.isVisible());
  await shareButton.click();
  const dialog = browserPage.getByRole("dialog", { name: "Public read-only link" });
  await dialog.waitFor();
  await dialog.getByText("This document is private.", { exact: true }).waitFor();
  check("the dialog begins with accurate private status", true);

  const issueResponsePromise = browserPage.waitForResponse((response) =>
    response.url().endsWith(`/api/pages/${page.id}/share`) &&
    response.request().method() === "POST" &&
    response.status() === 201
  );
  await dialog.getByRole("button", { name: "Generate public link" }).click();
  const issueResponse = await issueResponsePromise;
  const issued = await issueResponse.json();
  const publicUrl = new URL(issued.path, base).toString();
  await dialog.getByLabel("New public page link").waitFor();
  check("the full capability is shown exactly once after generation", await dialog.getByLabel("New public page link").inputValue() === publicUrl);

  const shareRow = await prisma.pageShare.findUniqueOrThrow({ where: { pageId: page.id } });
  check("the browser flow stores a digest rather than the token", !JSON.stringify(shareRow).includes(issued.path));
  const statusResponse = await context.request.get(`${base}/api/pages/${page.id}/share`, {
    headers: { Cookie: `keel_session=${ownerToken}; keel-workspace=${workspace.id}` },
  });
  check("later status responses omit the capability", statusResponse.ok() && !JSON.stringify(await statusResponse.json()).includes("keel_share_"));

  const publicResponse = await context.request.get(publicUrl);
  const publicHtml = await publicResponse.text();
  check("an anonymous reader can open the shared document", publicResponse.status() === 200 && publicHtml.includes("Safe public sharing marker"));
  check("shared pages are no-store and noindex", publicResponse.headers()["cache-control"] === "no-store" && publicResponse.headers()["x-robots-tag"]?.includes("noindex"));

  const publicToken = issued.path.split("/").pop();
  const ownFile = await context.request.get(`${base}/share/${publicToken}/attachments/${attachment.id}`);
  const foreignFile = await context.request.get(`${base}/share/${publicToken}/attachments/${foreignAttachment.id}`);
  check("the capability serves an attachment from the exact shared page", ownFile.status() === 200 && ownFile.headers()["content-type"] === "image/png");
  check("the capability cannot read a sibling page attachment", foreignFile.status() === 404);

  await browserPage.setViewportSize({ width: 390, height: 844 });
  await browserPage.goto(`${base}/p/${page.id}`, { waitUntil: "domcontentloaded" });
  await browserPage.getByTitle("Create or manage a read-only public link").click();
  await browserPage.getByRole("dialog", { name: "Public read-only link" }).waitFor();
  const mobileLayout = await browserPage.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
    dialog: document.querySelector('[role="dialog"]')?.getBoundingClientRect().width ?? 0,
  }));
  check("the Share action does not widen the 390px app shell", mobileLayout.body <= mobileLayout.viewport, JSON.stringify(mobileLayout));
  check("the sharing dialog fits a phone viewport", mobileLayout.dialog > 0 && mobileLayout.dialog <= 358, JSON.stringify(mobileLayout));
  await browserPage.getByLabel("Close public sharing").click();

  await context.clearCookies();
  await context.addCookies([
    { name: "keel_session", value: editorToken, domain: "127.0.0.1", path: "/" },
    { name: "keel-workspace", value: workspace.id, domain: "127.0.0.1", path: "/" },
  ]);
  await browserPage.goto(`${base}/p/${page.id}`, { waitUntil: "domcontentloaded" });
  check("an editor does not see the Share action", await browserPage.getByTitle("Create or manage a read-only public link").count() === 0);
  const editorAttempt = await context.request.post(`${base}/api/pages/${page.id}/share`, {
    headers: {
      Cookie: `keel_session=${editorToken}; keel-workspace=${workspace.id}`,
      Origin: base,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    data: { expiresInDays: 7 },
  });
  check("an editor cannot create a link through the API", editorAttempt.status() === 403);

  const revoke = await context.request.delete(`${base}/api/pages/${page.id}/share`, {
    headers: {
      Cookie: `keel_session=${ownerToken}; keel-workspace=${workspace.id}`,
      Origin: base,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  check("the owner can revoke the capability", revoke.status() === 200);
  check("the revoked URL immediately becomes unavailable", (await context.request.get(publicUrl)).status() === 404);
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
