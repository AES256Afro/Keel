#!/usr/bin/env node
// Capture privacy-safe product screenshots for keelnotes.com.
//
// The script uses a throwaway SQLite database with synthetic people and notes,
// signs a browser into that isolated instance, writes the screenshots, and
// removes the database again. Build first so `next start` serves the current UI:
//
//   npm run build && node scripts/capture-website-screenshots.mjs
//
// Env:
//   CHROMIUM          override the auto-detected Chromium
//   SCREENSHOT_PORT   local capture server port (default 3298)

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "website", "public", "assets", "screenshots");
const databaseName = "website-screenshot-capture";
const databaseUrl = testDatabaseUrl(root, databaseName);
const port = Number(process.env.SCREENSHOT_PORT || 3298);
const base = `http://127.0.0.1:${port}`;

const doc = (...content) => JSON.stringify({ type: "doc", content });
const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content) => ({ type: "paragraph", content });
const heading = (level, value) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const bullet = (value) => ({
  type: "listItem",
  content: [paragraph(text(value))],
});
const task = (value, checked) => ({
  type: "taskItem",
  attrs: { checked },
  content: [paragraph(text(value))],
});

async function waitForServer(url, attempts = 160) {
  while (attempts-- > 0) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_500) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("capture server did not start");
}

function stopServer(server) {
  if (!server || server.killed) return;
  server.kill("SIGTERM");
}

cleanDatabase(root, databaseName);
prepareDatabase(root, databaseUrl);
fs.mkdirSync(output, { recursive: true });

const prisma = await testPrisma(root, databaseUrl);
const user = await prisma.user.create({
  data: {
    email: "alex@keel-demo.example",
    name: "Alex Morgan",
    username: "alex",
    passwordHash: "synthetic-screenshot-account",
    onboardedAt: new Date(),
  },
});
const workspace = await prisma.workspace.create({
  data: {
    name: "Voyage Studio",
    ownerId: user.id,
    members: { create: { userId: user.id, role: "owner" } },
  },
});
const sessionToken = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token: sessionToken, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
});

const launchBriefContent = doc(
  paragraph(text("A practical home for the decisions, research, and tasks behind the next release.")),
  heading(2, "What success looks like"),
  {
    type: "bulletList",
    content: [
      bullet("A calm writing space that stays fast as the notebook grows"),
      bullet("One set of records that can become a table, board, timeline, or mind map"),
      bullet("Exports and encrypted backups that are easy to test"),
    ],
  },
  heading(2, "This week"),
  {
    type: "taskList",
    content: [
      task("Polish the onboarding checklist", true),
      task("Review the launch board with the team", true),
      task("Record the release walkthrough", false),
    ],
  },
  {
    type: "blockquote",
    content: [paragraph(text("Keep the notebook understandable enough that moving it never feels risky."))],
  }
);

const launchBrief = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Launch brief",
    icon: "⛵",
    content: launchBriefContent,
    plainText: "Launch brief success writing databases backups onboarding board walkthrough",
    createdById: user.id,
    editedById: user.id,
    sortOrder: 1,
  },
});
const research = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    parentPageId: launchBrief.id,
    type: "document",
    title: "Research notes",
    icon: "🧭",
    content: doc(heading(2, "Signals worth keeping"), paragraph(text("Fast capture, durable links, and clear ownership."))),
    plainText: "Signals worth keeping fast capture durable links clear ownership",
    createdById: user.id,
    editedById: user.id,
    sortOrder: 1,
  },
});
const meetingLog = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Meeting log",
    icon: "🗒️",
    content: doc(heading(2, "Decision log"), paragraph(text("Ship small, verify the real experience, then expand."))),
    plainText: "Decision log ship small verify real experience then expand",
    createdById: user.id,
    editedById: user.id,
    sortOrder: 2,
  },
});
const readingList = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Reading list",
    icon: "📚",
    content: doc(paragraph(text("Design systems, local-first software, and durable personal archives."))),
    plainText: "Design systems local first software durable personal archives",
    createdById: user.id,
    editedById: user.id,
    sortOrder: 3,
  },
});
await prisma.pageTag.createMany({
  data: [
    { workspaceId: workspace.id, pageId: launchBrief.id, tag: "launch", label: "launch" },
    { workspaceId: workspace.id, pageId: research.id, tag: "research", label: "research" },
    { workspaceId: workspace.id, pageId: meetingLog.id, tag: "decisions", label: "decisions" },
  ],
});
await prisma.pageLink.createMany({
  data: [
    { workspaceId: workspace.id, fromPageId: launchBrief.id, toPageId: research.id, targetTitle: "research notes" },
    { workspaceId: workspace.id, fromPageId: launchBrief.id, toPageId: meetingLog.id, targetTitle: "meeting log" },
    { workspaceId: workspace.id, fromPageId: research.id, toPageId: readingList.id, targetTitle: "reading list" },
    { workspaceId: workspace.id, fromPageId: meetingLog.id, toPageId: research.id, targetTitle: "research notes" },
  ],
});

const boardPage = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "database",
    title: "Launch work",
    icon: "🗂️",
    content: "{}",
    plainText: "",
    createdById: user.id,
    editedById: user.id,
    sortOrder: 4,
  },
});
const database = await prisma.database.create({
  data: { workspaceId: workspace.id, pageId: boardPage.id },
});
const status = await prisma.databaseProperty.create({
  data: {
    databaseId: database.id,
    name: "Status",
    type: "select",
    sortOrder: 1,
    settings: JSON.stringify({
      options: [
        { id: "planned", name: "Planned", color: "gray" },
        { id: "underway", name: "Underway", color: "blue" },
        { id: "review", name: "Review", color: "orange" },
        { id: "complete", name: "Complete", color: "green" },
      ],
    }),
  },
});
const priority = await prisma.databaseProperty.create({
  data: {
    databaseId: database.id,
    name: "Priority",
    type: "select",
    sortOrder: 2,
    settings: JSON.stringify({
      options: [
        { id: "high", name: "High", color: "red" },
        { id: "medium", name: "Medium", color: "yellow" },
        { id: "low", name: "Low", color: "gray" },
      ],
    }),
  },
});
const due = await prisma.databaseProperty.create({
  data: { databaseId: database.id, name: "Due", type: "date", sortOrder: 3 },
});
const progress = await prisma.databaseProperty.create({
  data: { databaseId: database.id, name: "Progress", type: "progress", sortOrder: 4 },
});
await prisma.databaseView.createMany({
  data: [
    {
      databaseId: database.id,
      name: "Board",
      type: "board",
      sortOrder: 0,
      config: JSON.stringify({
        groupByPropertyId: status.id,
        cardPropertyIds: [priority.id, due.id, progress.id],
        columnOrder: ["planned", "underway", "review", "complete"],
        wipLimits: { underway: 3 },
      }),
    },
    { databaseId: database.id, name: "Table", type: "table", sortOrder: 1, config: "{}" },
    {
      databaseId: database.id,
      name: "Timeline",
      type: "timeline",
      sortOrder: 2,
      config: JSON.stringify({ timeline: { datePropertyId: due.id } }),
    },
    {
      databaseId: database.id,
      name: "Mind map",
      type: "mindmap",
      sortOrder: 3,
      config: JSON.stringify({ groupByPropertyId: status.id, mindmap: { layout: "auto", direction: "right" } }),
    },
  ],
});

const recordSeeds = [
  ["Write the installation walkthrough", "underway", "high", "2026-08-18", 70],
  ["Capture product screenshots", "underway", "high", "2026-08-17", 55],
  ["Review onboarding copy", "review", "medium", "2026-08-16", 90],
  ["Test encrypted restore", "complete", "high", "2026-08-14", 100],
  ["Prepare release notes", "planned", "medium", "2026-08-19", 20],
  ["Polish the public sharing guide", "planned", "low", "2026-08-21", 10],
  ["Verify mobile navigation", "complete", "medium", "2026-08-14", 100],
];
const records = [];
for (const [index, [title, state, importance, date, percent]] of recordSeeds.entries()) {
  const page = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      parentPageId: boardPage.id,
      type: "record",
      title,
      icon: index % 2 ? "◻️" : "✓",
      content: doc(paragraph(text(`Notes for ${title.toLowerCase()}.`))),
      plainText: `Notes for ${title.toLowerCase()}`,
      createdById: user.id,
      editedById: user.id,
      sortOrder: index + 1,
    },
  });
  const record = await prisma.databaseRecord.create({
    data: {
      databaseId: database.id,
      pageId: page.id,
      sortOrder: index + 1,
      ...(index > 0 && index < 4 ? { parentRecordId: records[0]?.id } : {}),
    },
  });
  records.push(record);
  await prisma.databaseValue.createMany({
    data: [
      { recordId: record.id, propertyId: status.id, value: JSON.stringify(state) },
      { recordId: record.id, propertyId: priority.id, value: JSON.stringify(importance) },
      { recordId: record.id, propertyId: due.id, value: JSON.stringify(date) },
      { recordId: record.id, propertyId: progress.id, value: JSON.stringify(percent) },
    ],
  });
}
await prisma.pageLink.create({
  data: {
    workspaceId: workspace.id,
    fromPageId: launchBrief.id,
    toPageId: boardPage.id,
    targetTitle: "launch work",
  },
});
await prisma.favorite.create({ data: { userId: user.id, pageId: launchBrief.id } });
await prisma.favorite.create({ data: { userId: user.id, pageId: boardPage.id } });
await prisma.$disconnect();

const server = spawn("npx", ["next", "start", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    PORT: String(port),
    KEEL_PUBLIC_URL: base,
  },
  stdio: "ignore",
  shell: process.platform === "win32",
});

let browser;
try {
  await waitForServer(`${base}/api/health`);
  browser = await chromium.launch({
    ...chromiumLaunchOptions(),
    args: ["--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await context.addCookies([
    { name: "keel_session", value: sessionToken, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  async function capture(name, url, ready) {
    await page.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
    if (ready) await page.waitForSelector(ready);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.screenshot({ path: path.join(output, name), animations: "disabled" });
    console.log(`captured ${name}`);
  }

  await capture("keel-editor.png", `/p/${launchBrief.id}`, ".ProseMirror");
  await capture("keel-board.png", `/p/${boardPage.id}`, "text=Capture product screenshots");
  await page.goto(`${base}/graph`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas");
  await page.waitForTimeout(2_200);
  await page.screenshot({ path: path.join(output, "keel-graph.png"), animations: "disabled" });
  console.log("captured keel-graph.png");
} finally {
  await browser?.close();
  stopServer(server);
  cleanDatabase(root, databaseName);
}
