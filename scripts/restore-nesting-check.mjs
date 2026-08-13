#!/usr/bin/env node
// Regression: a page nested UNDER a database record's page must survive a
// snapshot → restore round trip. The restore walk skipped record pages (they
// are recreated in the records loop) but never walked their children, so any
// ordinary sub-page filed under a database row was silently dropped on every
// restore, import, and subtree duplicate. Found by the sweep; guarded here.
//
//   node --experimental-strip-types --no-warnings scripts/restore-nesting-check.mjs
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "restore-nesting-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);

// The backup lib imports the app's prisma singleton, which binds DATABASE_URL
// at first import - set it before that import, and drive everything through
// that same client so seed and snapshot share one database.
cleanDatabase(root, DB_NAME);
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);
process.env.DATABASE_URL = DB_URL;

register("./ts-loader.mjs", import.meta.url);
const { snapshotWorkspace, restoreSnapshot } = await import(
  pathToFileURL(path.join(root, "src/lib/backup.ts")).href
);
const { prisma } = await import(pathToFileURL(path.join(root, "src/lib/prisma.ts")).href);

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

try {
  const user = await prisma.user.create({
    data: { email: "b@example.test", name: "B", username: "b", passwordHash: "x" },
  });
  const src = await prisma.workspace.create({
    data: { name: "Src", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });

  // A database, one record, and - the case that regressed - an ordinary
  // document page filed under that record's page, with its own child.
  const mk = (data) =>
    prisma.page.create({
      data: { workspaceId: src.id, content: "{}", plainText: "", createdById: user.id, sortOrder: 0, ...data },
    });
  const dbPage = await mk({ type: "database", title: "Projects" });
  const database = await prisma.database.create({ data: { workspaceId: src.id, pageId: dbPage.id } });
  const recordPage = await mk({ type: "record", title: "Apollo", parentPageId: dbPage.id });
  await prisma.databaseRecord.create({ data: { databaseId: database.id, pageId: recordPage.id, sortOrder: 0 } });
  const nested = await mk({
    type: "document",
    title: "MEETING-UNDER-RECORD",
    parentPageId: recordPage.id,
    content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "NESTED-BODY" }] }] }),
  });
  await mk({ type: "document", title: "DEEPER-STILL", parentPageId: nested.id });

  const snapshot = await snapshotWorkspace(src.id);
  check(
    "snapshot captured the page nested under the record",
    snapshot.pages.some((p) => p.title === "MEETING-UNDER-RECORD"),
    `${snapshot.pages.length} pages`
  );

  // Restore into a fresh workspace and confirm the nested subtree came back.
  const dst = await prisma.workspace.create({
    data: { name: "Dst", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });
  await restoreSnapshot(snapshot, { workspaceId: dst.id, userId: user.id });

  const restored = await prisma.page.findMany({
    where: { workspaceId: dst.id },
    select: { title: true, content: true, parentPageId: true },
  });
  const byTitle = new Map(restored.map((p) => [p.title, p]));

  check("the record page restored", byTitle.has("Apollo"));
  check("the page nested under the record restored", byTitle.has("MEETING-UNDER-RECORD"));
  check("its body came with it", (byTitle.get("MEETING-UNDER-RECORD")?.content ?? "").includes("NESTED-BODY"));
  check("the grandchild restored too", byTitle.has("DEEPER-STILL"));
  check(
    "the nested page is parented to the restored record, not orphaned",
    byTitle.get("MEETING-UNDER-RECORD")?.parentPageId === restored.find((p) => p.title === "Apollo")?.parentPageId
      ? false
      : byTitle.get("MEETING-UNDER-RECORD")?.parentPageId != null
  );

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.stack || err.message}\n`);
  failures.push(err.message);
} finally {
  await prisma.$disconnect();
  cleanDatabase(root, DB_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
