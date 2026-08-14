#!/usr/bin/env node
// Workspace-scoped trash retention contracts.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbName = "trash-retention-check";
const databaseUrl = testDatabaseUrl(root, dbName);
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

cleanDatabase(root, dbName);
prepareDatabase(root, databaseUrl);
process.env.DATABASE_URL = databaseUrl;
register("./ts-loader.mjs", import.meta.url);
const { pruneExpiredTrash } = await import(
  pathToFileURL(path.join(root, "src/lib/trash-retention.ts")).href
);
const prisma = await testPrisma(root, databaseUrl);

try {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const user = await prisma.user.create({
    data: { email: "trash@example.test", name: "Trash", username: "trash", passwordHash: "x" },
  });
  const expiring = await prisma.workspace.create({
    data: { name: "Expires", ownerId: user.id },
  });
  const forever = await prisma.workspace.create({
    data: { name: "Forever", ownerId: user.id, trashRetentionDays: 0 },
  });
  check("new workspaces default to 30 days", expiring.trashRetentionDays === 30);

  const oldArchive = new Date(now.getTime() - 31 * 86_400_000);
  const recentArchive = new Date(now.getTime() - 29 * 86_400_000);
  const oldParent = await prisma.page.create({
    data: {
      workspaceId: expiring.id,
      type: "document",
      title: "Old parent",
      createdById: user.id,
      archivedAt: oldArchive,
    },
  });
  const oldChild = await prisma.page.create({
    data: {
      workspaceId: expiring.id,
      parentPageId: oldParent.id,
      type: "document",
      title: "Old child",
      createdById: user.id,
      archivedAt: oldArchive,
    },
  });
  const recent = await prisma.page.create({
    data: {
      workspaceId: expiring.id,
      type: "document",
      title: "Recent trash",
      createdById: user.id,
      archivedAt: recentArchive,
    },
  });
  const live = await prisma.page.create({
    data: {
      workspaceId: expiring.id,
      type: "document",
      title: "Live page",
      createdById: user.id,
    },
  });
  const keptForever = await prisma.page.create({
    data: {
      workspaceId: forever.id,
      type: "document",
      title: "Old but retained",
      createdById: user.id,
      archivedAt: oldArchive,
    },
  });

  const deleted = await pruneExpiredTrash(now);
  check("the sweep reports every expired page in the subtree", deleted === 2, String(deleted));
  const remainingIds = new Set(
    (await prisma.page.findMany({ select: { id: true } })).map((page) => page.id)
  );
  check("expired archived parent is purged", !remainingIds.has(oldParent.id));
  check("expired archived child is purged", !remainingIds.has(oldChild.id));
  check("recent trash remains restorable", remainingIds.has(recent.id));
  check("live pages are never purged", remainingIds.has(live.id));
  check("zero retention keeps trash forever", remainingIds.has(keptForever.id));

  const again = await pruneExpiredTrash(now);
  check("the sweep is idempotent", again === 0, String(again));
} finally {
  await prisma.$disconnect();
  cleanDatabase(root, dbName);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  • ${failure}`);
  process.exit(1);
}
