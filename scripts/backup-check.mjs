#!/usr/bin/env node
// Backup round-trip test.
//
// Exercises the whole data-safety path end to end: create content → back up →
// list → restore → verify the content came back. Every one of these routes was
// missing from the repo while the Settings UI called them, so the feature was
// dead and nothing noticed. This is what notices.
//
//   node --experimental-strip-types --no-warnings scripts/backup-check.mjs
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { rmSync, existsSync, statSync } from "fs";
import path from "path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "backup-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);

// The fidelity section imports the app's TypeScript directly, and the prisma
// singleton binds DATABASE_URL at first import - set it before anything can.
process.env.DATABASE_URL = DB_URL;
register("./ts-loader.mjs", import.meta.url);
const BACKUP_DIR = path.join(root, ".backup-check");
// The in-process sections call runBackup()/backupDirFor() directly, and they
// must land in the same scratch folder the spawned server uses.
process.env.KEEL_BACKUP_DIR = BACKUP_DIR;
const PORT = Number(process.env.BACKUP_PORT || 3198);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
}

function cleanup() {
  cleanDatabase(root, DB_NAME);
  if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true });
}


async function waitFor(url, tries = 120) {
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
    data: { email: "op@example.test", name: "Op", username: "op", passwordHash: "x" },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "Ops", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
  });
  await prisma.$disconnect();
  return { user, workspace, token };
}

async function main() {
  cleanup();
  console.log("Preparing scratch database…");
  prepareDatabase(root, DB_URL);
  const { workspace, token } = await seed();

  console.log(`Starting server on :${PORT}…`);
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      PORT: String(PORT),
      KEEL_BACKUP_DIR: BACKUP_DIR,
      // The attachment-volume section restores its own backup two or three
      // times over; the quota rules themselves are checked in-process below,
      // where the env can be moved around per test.
      KEEL_ATTACHMENT_QUOTA_MB: "8192",
    },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  const req = (method, url, body, isForm = false) =>
    fetch(BASE + url, {
      method,
      redirect: "manual",
      headers: {
        Cookie: `keel_session=${token}`,
        ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });

  try {
    if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

    // ---- Content to back up -------------------------------------------------
    console.log("\nSeeding content");
    const MARKER = "sentinel-" + randomBytes(4).toString("hex");
    const page = await (await req("POST", "/api/pages", { title: MARKER })).json();
    check("created a page", Boolean(page.page?.id), JSON.stringify(page));
    await req("PATCH", `/api/pages/${page.page.id}`, {
      content: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: MARKER + "-body" }] }],
      }),
    });

    const dbPage = await (
      await req("POST", "/api/pages", { title: MARKER + "-db", type: "database" })
    ).json();
    check("created a database page", Boolean(dbPage.page?.id));

    // ---- Plain backup -------------------------------------------------------
    console.log("\nPlain backup");
    let res = await req("POST", "/api/workspace/backups", {});
    let data = await res.json().catch(() => ({}));
    check("POST /api/workspace/backups succeeds", res.status === 200, `${res.status} ${JSON.stringify(data)}`);
    check("returns the written file path", typeof data.file === "string" && data.file.endsWith(".json"), String(data.file));
    check("returns the refreshed backup list", Array.isArray(data.backups) && data.backups.length === 1);
    const plainName = data.backups?.[0]?.name;

    res = await req("GET", "/api/workspace/backups");
    data = await res.json().catch(() => ({}));
    check("GET /api/workspace/backups lists it", data.backups?.length === 1, JSON.stringify(data));

    // ---- Restore ------------------------------------------------------------
    console.log("\nRestore");
    res = await req("POST", "/api/workspace/backups/restore", { filename: plainName });
    data = await res.json().catch(() => ({}));
    check("restore succeeds", res.status === 200, `${res.status} ${JSON.stringify(data)}`);
    check("restored the root pages", data.restored >= 2, `restored=${data.restored}`);

    res = await req("GET", `/api/search?q=${MARKER}`);
    data = await res.json().catch(() => ({}));
    // Original + restored copy of each of the two pages.
    check("restored content is searchable", data.results?.length >= 4, `found ${data.results?.length}`);

    // ---- Path traversal is refused -----------------------------------------
    console.log("\nRestore rejects paths outside the workspace's backups");
    for (const bad of ["../../etc/passwd", "/etc/passwd", "keel-other-2020.json", ""]) {
      res = await req("POST", "/api/workspace/backups/restore", { filename: bad });
      check(`refuses filename ${JSON.stringify(bad)}`, res.status === 400, `got ${res.status}`);
    }

    // ---- Encrypted backup ---------------------------------------------------
    console.log("\nEncrypted backup");
    res = await req("POST", "/api/workspace/backups", { encrypt: true, passphrase: "correct horse" });
    data = await res.json().catch(() => ({}));
    check("encrypted backup succeeds", res.status === 200, `${res.status} ${JSON.stringify(data)}`);
    check("writes a .keelbak envelope", String(data.file).endsWith(".keelbak"), String(data.file));
    const encName = (data.backups ?? []).find((b) => b.name.endsWith(".keelbak"))?.name;

    res = await req("POST", "/api/workspace/backups", { encrypt: true });
    check("encrypted backup without a passphrase is refused", res.status === 400, `got ${res.status}`);

    res = await req("POST", "/api/workspace/backups/restore", { filename: encName });
    check("encrypted restore without a passphrase is refused", res.status === 400, `got ${res.status}`);

    res = await req("POST", "/api/workspace/backups/restore", {
      filename: encName,
      passphrase: "wrong horse",
    });
    check("encrypted restore with the wrong passphrase is refused", res.status === 400, `got ${res.status}`);

    res = await req("POST", "/api/workspace/backups/restore", {
      filename: encName,
      passphrase: "correct horse",
    });
    data = await res.json().catch(() => ({}));
    check("encrypted restore with the right passphrase works", res.status === 200, `${res.status} ${JSON.stringify(data)}`);

    // ---- Pre-rename backups still work -------------------------------------
    console.log("\nBackups written before the rename");
    {
      const { writeFileSync, mkdirSync } = await import("fs");
      // backupDirFor() namespaces by workspace when no custom folder is set.
      const wsDir = path.join(BACKUP_DIR, workspace.id);
      mkdirSync(wsDir, { recursive: true });
      const legacyName = `keel-${workspace.id.slice(0, 12)}-legacy.json`.replace(
        /^keel-/,
        "nopin-"
      );
      // A snapshot exactly as the old version wrote it: old filename prefix,
      // old format string.
      const legacy = JSON.parse(await (await req("POST", "/api/workspace/export", {})).text());
      legacy.format = "nopin-backup";
      writeFileSync(path.join(wsDir, legacyName), JSON.stringify(legacy));

      let res = await req("GET", "/api/workspace/backups");
      let data = await res.json().catch(() => ({}));
      check(
        "a pre-rename backup is still listed",
        (data.backups ?? []).some((b) => b.name === legacyName),
        JSON.stringify((data.backups ?? []).map((b) => b.name))
      );

      res = await req("POST", "/api/workspace/backups/restore", { filename: legacyName });
      data = await res.json().catch(() => ({}));
      check(
        "a pre-rename backup still restores",
        res.status === 200 && data.restored > 0,
        `${res.status} ${JSON.stringify(data)}`
      );
    }

    // ---- Cloud list degrades gracefully ------------------------------------
    console.log("\nCloud backups");
    res = await req("GET", "/api/cloud/backups");
    data = await res.json().catch(() => ({}));
    check("GET /api/cloud/backups returns [] when nothing is connected", res.status === 200 && Array.isArray(data.backups) && data.backups.length === 0, `${res.status} ${JSON.stringify(data)}`);

    // ---- Download export ----------------------------------------------------
    console.log("\nDownload export");
    res = await req("POST", "/api/workspace/export", {});
    check("export returns a snapshot", res.status === 200, `got ${res.status}`);
    const snapshot = JSON.parse(await res.text());
    check("snapshot has the right format", snapshot.format === "keel-backup", snapshot.format);
    check("snapshot contains the seeded page", JSON.stringify(snapshot.pages).includes(MARKER));

    // ---- backupDir confinement ---------------------------------------------
    console.log("\nBackup folder confinement");
    res = await req("PATCH", "/api/workspace", { backupDir: path.join(BACKUP_DIR, "nested") });
    check("a folder inside the backup root is accepted", res.status === 200, `got ${res.status}`);
    await req("PATCH", "/api/workspace", { backupDir: null });
    check("workspace id is still " + workspace.id.slice(0, 6), true);

    // ---- Snapshot fidelity: tree, layout, views, links ---------------------
    // In-process against the library - the code every restore path (backup
    // restore, import, cloud restore, duplicate) calls. The mind-map template
    // is the richest producer: parented records, saved views, record pages -
    // exactly the data a version-1 snapshot used to drop.
    console.log("\nSnapshot fidelity (record tree, layout, views, links)");
    const { createFromTemplate } = await import(
      pathToFileURL(path.join(root, "src/lib/templates.ts")).href
    );
    const {
      snapshotWorkspace,
      restoreSnapshot,
      encryptBackup,
      parseBackup,
      runBackup,
      backupDirFor,
    } = await import(pathToFileURL(path.join(root, "src/lib/backup.ts")).href);
    const { prisma } = await import(pathToFileURL(path.join(root, "src/lib/prisma.ts")).href);

    const fUser = await prisma.user.create({
      data: { email: "fidelity@example.test", name: "Fi", username: "fidelity", passwordHash: "x" },
    });
    const mkWs = (name) =>
      prisma.workspace.create({
        data: { name, ownerId: fUser.id, members: { create: { userId: fUser.id, role: "owner" } } },
      });
    const srcWs = await mkWs("Fidelity source");

    await createFromTemplate("mind-map", { workspaceId: srcWs.id, userId: fUser.id });
    const srcRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: srcWs.id } },
      include: { page: { select: { title: true } } },
    });
    const srcByTitle = (t) => srcRecords.find((r) => r.page.title === t);
    // Pin one node and fold another: the layout fields must survive the trip.
    await prisma.databaseRecord.update({
      where: { id: srcByTitle("How it works").id },
      data: { mapX: 320, mapY: -48 },
    });
    await prisma.databaseRecord.update({
      where: { id: srcByTitle("What could go wrong").id },
      data: { collapsed: true },
    });
    // A config that references ids by value: both kinds must be remapped to
    // the restored rows, not copied verbatim.
    const srcStatus = await prisma.databaseProperty.findFirst({
      where: { database: { workspaceId: srcWs.id }, name: "Status" },
    });
    const srcMapView = await prisma.databaseView.findFirst({
      where: { database: { workspaceId: srcWs.id }, name: "Map" },
    });
    await prisma.databaseView.update({
      where: { id: srcMapView.id },
      data: {
        config: JSON.stringify({
          groupByPropertyId: srcStatus.id,
          mindmap: { layout: "manual", rootRecordId: srcByTitle("The idea").id },
        }),
      },
    });
    // The linking page sorts BEFORE its target, so only a rebuild that runs
    // after every page exists can resolve the link.
    const docContent = (text) =>
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      });
    const mkDoc = (title, text, sortOrder) =>
      prisma.page.create({
        data: {
          workspaceId: srcWs.id,
          type: "document",
          title,
          content: docContent(text),
          plainText: text,
          sortOrder,
          createdById: fUser.id,
        },
      });
    await mkDoc("Crossing plan", "Depart per [[Harbour notes]] #voyage", 1);
    await mkDoc("Harbour notes", "Tides and moorings", 2);

    const fidelity = await snapshotWorkspace(srcWs.id);
    check("snapshot writes version 3", fidelity.version === 3, `version=${fidelity.version}`);
    check(
      "snapshot carries the record tree",
      fidelity.records.filter((r) => r.parentRecordId).length === 7,
      `${fidelity.records.filter((r) => r.parentRecordId).length} parented`
    );
    check("snapshot carries the views", fidelity.views?.length === 3, `${fidelity.views?.length}`);

    const dstWs = await mkWs("Fidelity restore");
    await restoreSnapshot(fidelity, { workspaceId: dstWs.id, userId: fUser.id });

    const dstRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: dstWs.id } },
      include: {
        page: { select: { title: true } },
        parent: { include: { page: { select: { title: true } } } },
      },
    });
    const dstByTitle = (t) => dstRecords.find((r) => r.page.title === t);
    check("all records restored", dstRecords.length === 8, `${dstRecords.length}`);
    check(
      "parented count survived",
      dstRecords.filter((r) => r.parentRecordId).length === 7,
      `${dstRecords.filter((r) => r.parentRecordId).length} parented`
    );
    check(
      "an edge two levels down points at the right parent",
      dstByTitle("First step")?.parent?.page.title === "How it works"
    );
    check(
      "pinned position survived",
      dstByTitle("How it works")?.mapX === 320 && dstByTitle("How it works")?.mapY === -48,
      `mapX=${dstByTitle("How it works")?.mapX} mapY=${dstByTitle("How it works")?.mapY}`
    );
    check("collapsed flag survived", dstByTitle("What could go wrong")?.collapsed === true);

    const dstViews = await prisma.databaseView.findMany({
      where: { database: { workspaceId: dstWs.id } },
      orderBy: { sortOrder: "asc" },
    });
    check("all three views restored", dstViews.length === 3, `${dstViews.length}`);
    check(
      "view types and order survived",
      dstViews.map((v) => v.type).join(",") === "mindmap,board,table",
      dstViews.map((v) => v.type).join(",")
    );
    check(
      "view names survived",
      dstViews.map((v) => v.name).join(",") === "Map,Board,All",
      dstViews.map((v) => v.name).join(",")
    );
    const dstStatus = await prisma.databaseProperty.findFirst({
      where: { database: { workspaceId: dstWs.id }, name: "Status" },
    });
    const mapConfig = JSON.parse(dstViews[0]?.config ?? "{}");
    check(
      "view config property id remapped to the restored property",
      mapConfig.groupByPropertyId === dstStatus?.id,
      dstViews[0]?.config
    );
    check(
      "view config record id remapped to the restored record",
      mapConfig.mindmap?.rootRecordId === dstByTitle("The idea")?.id &&
        mapConfig.mindmap?.layout === "manual",
      dstViews[0]?.config
    );

    const dstLinker = await prisma.page.findFirst({
      where: { workspaceId: dstWs.id, title: "Crossing plan" },
    });
    const dstTarget = await prisma.page.findFirst({
      where: { workspaceId: dstWs.id, title: "Harbour notes" },
    });
    const dstLinks = await prisma.pageLink.findMany({ where: { fromPageId: dstLinker?.id ?? "" } });
    check("restored wikilink has a PageLink row", dstLinks.length === 1, `${dstLinks.length}`);
    check("…resolved to the restored target page", dstLinks[0]?.toPageId === dstTarget?.id);
    const dstTags = await prisma.pageTag.findMany({ where: { pageId: dstLinker?.id ?? "" } });
    check("restored #tag has a PageTag row", dstTags.some((t) => t.tag === "voyage"));

    // ---- Old snapshots and unordered trees ---------------------------------
    console.log("\nSnapshot compatibility");
    const v1Page = (id, over) => ({
      id,
      parentPageId: null,
      type: "document",
      title: id,
      icon: null,
      content: null,
      sortOrder: 1,
      archivedAt: null,
      ...over,
    });
    // Built exactly as version 1 wrote it: no tree/layout fields, no views key.
    const legacyWs = await mkWs("Legacy restore");
    let legacyError = "";
    try {
      await restoreSnapshot(
        {
          format: "keel-backup",
          version: 1,
          exportedAt: new Date().toISOString(),
          workspace: { name: "Legacy" },
          pages: [
            v1Page("old-db", { type: "database", title: "Old db" }),
            v1Page("old-row", { type: "record", title: "Old row", parentPageId: "old-db" }),
          ],
          databases: [{ id: "d1", pageId: "old-db" }],
          properties: [
            { id: "pr1", databaseId: "d1", name: "Status", type: "text", settings: null, sortOrder: 1 },
          ],
          records: [{ id: "r1", databaseId: "d1", pageId: "old-row", sortOrder: 1 }],
          values: [{ recordId: "r1", propertyId: "pr1", value: '"open"' }],
        },
        { workspaceId: legacyWs.id, userId: fUser.id }
      );
    } catch (err) {
      legacyError = String(err?.message ?? err);
    }
    check("a version-1 snapshot still restores", legacyError === "", legacyError);
    const legacyRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: legacyWs.id } },
    });
    check(
      "legacy records restore as roots",
      legacyRecords.length === 1 && legacyRecords[0].parentRecordId === null
    );
    check(
      "legacy restore creates no views (the fallback set applies)",
      (await prisma.databaseView.count({ where: { database: { workspaceId: legacyWs.id } } })) === 0
    );
    check(
      "legacy values still restore",
      (await prisma.databaseValue.count({
        where: { record: { database: { workspaceId: legacyWs.id } } },
      })) === 1
    );

    // A child can precede its parent in the records array (sortOrder is not
    // topological), and a parent id can point outside the snapshot (a subtree
    // cut mid-tree). The first must still get its edge; the second must
    // degrade to a root rather than fail the restore.
    const orderWs = await mkWs("Order restore");
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Order" },
        pages: [
          v1Page("o-db", { type: "database", title: "Order db" }),
          v1Page("o-child", { type: "record", title: "Child", parentPageId: "o-db" }),
          v1Page("o-parent", { type: "record", title: "Parent", parentPageId: "o-db", sortOrder: 2 }),
          v1Page("o-cut", { type: "record", title: "Cut", parentPageId: "o-db", sortOrder: 3 }),
        ],
        databases: [{ id: "od1", pageId: "o-db" }],
        properties: [],
        records: [
          { id: "or-child", databaseId: "od1", pageId: "o-child", sortOrder: 1, parentRecordId: "or-parent" },
          { id: "or-parent", databaseId: "od1", pageId: "o-parent", sortOrder: 2 },
          { id: "or-cut", databaseId: "od1", pageId: "o-cut", sortOrder: 3, parentRecordId: "nowhere" },
        ],
        values: [],
        views: [],
      },
      { workspaceId: orderWs.id, userId: fUser.id }
    );
    const orderRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: orderWs.id } },
      include: {
        page: { select: { title: true } },
        parent: { include: { page: { select: { title: true } } } },
      },
    });
    const orderByTitle = (t) => orderRecords.find((r) => r.page.title === t);
    check(
      "a child listed before its parent still gets the edge",
      orderByTitle("Child")?.parent?.page.title === "Parent"
    );
    check(
      "a parent id outside the snapshot degrades to a root",
      orderByTitle("Cut")?.parentRecordId === null
    );

    // ---- A database nested under a record page ------------------------------
    // The deepest alternation the model allows: database → record → its page →
    // database → record → its page → ordinary note. The restore used to create
    // record pages after the databases loop, so the inner database found no
    // page in the map and was silently dropped - row, properties, records,
    // values and views - leaving a husk page. Both restore and the duplicate
    // path (a subtree snapshot restored beside the original) must carry it.
    console.log("\nDatabase nested under a record page");
    const nestWs = await mkWs("Nested source");
    const mkPage = (data) =>
      prisma.page.create({
        data: { workspaceId: nestWs.id, createdById: fUser.id, sortOrder: 0, ...data },
      });
    const outerDbPage = await mkPage({ type: "database", title: "Tasks" });
    const outerDb = await prisma.database.create({
      data: { workspaceId: nestWs.id, pageId: outerDbPage.id },
    });
    const outerProp = await prisma.databaseProperty.create({
      data: { databaseId: outerDb.id, name: "Stage", type: "text", sortOrder: 1 },
    });
    const outerRecPage = await mkPage({ type: "record", title: "Ship it", parentPageId: outerDbPage.id });
    const outerRec = await prisma.databaseRecord.create({
      data: { databaseId: outerDb.id, pageId: outerRecPage.id, sortOrder: 1 },
    });
    await prisma.databaseValue.create({
      data: { recordId: outerRec.id, propertyId: outerProp.id, value: '"doing"' },
    });
    const innerDbPage = await mkPage({ type: "database", title: "Checklist", parentPageId: outerRecPage.id });
    const innerDb = await prisma.database.create({
      data: { workspaceId: nestWs.id, pageId: innerDbPage.id },
    });
    const innerProp = await prisma.databaseProperty.create({
      data: { databaseId: innerDb.id, name: "Done", type: "checkbox", sortOrder: 1 },
    });
    const innerRecPage = await mkPage({ type: "record", title: "Buy rope", parentPageId: innerDbPage.id });
    const innerRec = await prisma.databaseRecord.create({
      data: { databaseId: innerDb.id, pageId: innerRecPage.id, sortOrder: 1 },
    });
    await prisma.databaseValue.create({
      data: { recordId: innerRec.id, propertyId: innerProp.id, value: "true" },
    });
    await prisma.databaseView.create({
      data: { databaseId: innerDb.id, name: "Inner board", type: "board", sortOrder: 1 },
    });
    await mkPage({
      type: "document",
      title: "NOTE-UNDER-NESTED-RECORD",
      parentPageId: innerRecPage.id,
      content: docContent("rope specs"),
      plainText: "rope specs",
    });

    const nDst = await mkWs("Nested restore");
    await restoreSnapshot(await snapshotWorkspace(nestWs.id), {
      workspaceId: nDst.id,
      userId: fUser.id,
    });
    const nDstPage = (title) => prisma.page.findFirst({ where: { workspaceId: nDst.id, title } });
    const rInnerDbPage = await nDstPage("Checklist");
    check("the nested database's page restored", Boolean(rInnerDbPage));
    const rInnerDb = rInnerDbPage
      ? await prisma.database.findUnique({ where: { pageId: rInnerDbPage.id } })
      : null;
    check("…with a Database row behind it, not as a husk", Boolean(rInnerDb));
    const rInnerProps = rInnerDb
      ? await prisma.databaseProperty.findMany({ where: { databaseId: rInnerDb.id } })
      : [];
    check("…its property restored", rInnerProps.length === 1 && rInnerProps[0].name === "Done");
    const rInnerRecs = rInnerDb
      ? await prisma.databaseRecord.findMany({
          where: { databaseId: rInnerDb.id },
          include: { page: true },
        })
      : [];
    check("…its record restored", rInnerRecs.length === 1 && rInnerRecs[0].page.title === "Buy rope");
    check(
      "…its record page parented under the nested database",
      rInnerRecs[0]?.page.parentPageId === rInnerDbPage?.id
    );
    check(
      "…its value restored",
      rInnerRecs.length === 1 &&
        (await prisma.databaseValue.count({ where: { recordId: rInnerRecs[0].id } })) === 1
    );
    check(
      "…its view restored",
      rInnerDb
        ? (await prisma.databaseView.count({ where: { databaseId: rInnerDb.id } })) === 1
        : false
    );
    const rNote = await nDstPage("NOTE-UNDER-NESTED-RECORD");
    check(
      "…a note under the nested record restored under it",
      Boolean(rNote) && rNote.parentPageId === rInnerRecs[0]?.page.id
    );

    // Duplicate uses the same snapshot/restore pair on a subtree, back into
    // the same workspace - the nested database must survive that trip too.
    const subtree = await snapshotWorkspace(nestWs.id, outerDbPage.id);
    await restoreSnapshot(subtree, {
      workspaceId: nestWs.id,
      userId: fUser.id,
      parentPageId: null,
      rootTitle: "Tasks (copy)",
      sortOrderBase: 1.5,
    });
    check(
      "duplicate created the retitled copy root",
      Boolean(await prisma.page.findFirst({ where: { workspaceId: nestWs.id, title: "Tasks (copy)" } }))
    );
    const checklistPages = await prisma.page.findMany({
      where: { workspaceId: nestWs.id, title: "Checklist" },
    });
    const copyChecklist = checklistPages.find((p) => p.id !== innerDbPage.id);
    check("duplicate carried the nested database's page", Boolean(copyChecklist));
    const copyInnerDb = copyChecklist
      ? await prisma.database.findUnique({ where: { pageId: copyChecklist.id } })
      : null;
    check("…with its Database row", Boolean(copyInnerDb));
    check(
      "…and its property, record, value and view",
      Boolean(copyInnerDb) &&
        (await prisma.databaseProperty.count({ where: { databaseId: copyInnerDb.id } })) === 1 &&
        (await prisma.databaseRecord.count({ where: { databaseId: copyInnerDb.id } })) === 1 &&
        (await prisma.databaseValue.count({
          where: { record: { databaseId: copyInnerDb.id } },
        })) === 1 &&
        (await prisma.databaseView.count({ where: { databaseId: copyInnerDb.id } })) === 1
    );

    // ---- Restore is atomic and validated up front ---------------------------
    console.log("\nAtomicity and validation");
    const atomWs = await mkWs("Atomic restore");
    let truncatedError = "";
    try {
      // A truncated file: the `values` section is gone entirely.
      await restoreSnapshot(
        {
          format: "keel-backup",
          version: 2,
          exportedAt: new Date().toISOString(),
          workspace: { name: "Truncated" },
          pages: [v1Page("t-page", { title: "Truncated page" })],
          databases: [],
          properties: [],
          records: [],
        },
        { workspaceId: atomWs.id, userId: fUser.id }
      );
    } catch (err) {
      truncatedError = String(err?.message ?? err);
    }
    check(
      "a snapshot missing a section is refused",
      truncatedError.includes("Not a valid Keel backup file"),
      truncatedError
    );
    check(
      "…before the first write",
      (await prisma.page.count({ where: { workspaceId: atomWs.id } })) === 0
    );

    let midwayError = "";
    try {
      // Structurally valid, but the duplicated value violates the
      // (recordId, propertyId) unique constraint - deep into the restore,
      // after pages, database, property and record have all been written.
      await restoreSnapshot(
        {
          format: "keel-backup",
          version: 2,
          exportedAt: new Date().toISOString(),
          workspace: { name: "Atomic" },
          pages: [
            v1Page("a-db", { type: "database", title: "Atomic db" }),
            v1Page("a-row", { type: "record", title: "Atomic row", parentPageId: "a-db" }),
          ],
          databases: [{ id: "ad1", pageId: "a-db" }],
          properties: [
            { id: "ap1", databaseId: "ad1", name: "P", type: "text", settings: null, sortOrder: 1 },
          ],
          records: [{ id: "ar1", databaseId: "ad1", pageId: "a-row", sortOrder: 1 }],
          values: [
            { recordId: "ar1", propertyId: "ap1", value: '"one"' },
            { recordId: "ar1", propertyId: "ap1", value: '"two"' },
          ],
        },
        { workspaceId: atomWs.id, userId: fUser.id }
      );
    } catch (err) {
      midwayError = String(err?.message ?? err);
    }
    check("a snapshot that fails mid-restore throws", midwayError !== "", "restore succeeded");
    check(
      "…and rolls back to zero rows, so a retry cannot duplicate",
      (await prisma.page.count({ where: { workspaceId: atomWs.id } })) === 0 &&
        (await prisma.database.count({ where: { workspaceId: atomWs.id } })) === 0 &&
        (await prisma.databaseRecord.count({
          where: { database: { workspaceId: atomWs.id } },
        })) === 0
    );

    // ---- Forbidden parent edges degrade, not restore ------------------------
    // The API path runs assertCanReparent on every reparent; a hand-edited (or
    // pre-guard) backup can claim cycles and cross-database parents. Those
    // edges must degrade to roots - the dangling-parent rule - not come back.
    console.log("\nCycle and cross-database parent edges");
    const edgeWs = await mkWs("Edge restore");
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Edges" },
        pages: [
          v1Page("e-db1", { type: "database", title: "Edge one" }),
          v1Page("e-db2", { type: "database", title: "Edge two", sortOrder: 2 }),
          v1Page("e-a", { type: "record", title: "Ring A", parentPageId: "e-db1" }),
          v1Page("e-b", { type: "record", title: "Ring B", parentPageId: "e-db1", sortOrder: 2 }),
          v1Page("e-x", { type: "record", title: "Crosser", parentPageId: "e-db2" }),
        ],
        databases: [
          { id: "ed1", pageId: "e-db1" },
          { id: "ed2", pageId: "e-db2" },
        ],
        properties: [],
        records: [
          { id: "er-a", databaseId: "ed1", pageId: "e-a", sortOrder: 1, parentRecordId: "er-b" },
          { id: "er-b", databaseId: "ed1", pageId: "e-b", sortOrder: 2, parentRecordId: "er-a" },
          { id: "er-x", databaseId: "ed2", pageId: "e-x", sortOrder: 1, parentRecordId: "er-a" },
        ],
        values: [],
        views: [],
      },
      { workspaceId: edgeWs.id, userId: fUser.id }
    );
    const edgeRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: edgeWs.id } },
      include: {
        page: { select: { title: true } },
        parent: { include: { page: { select: { title: true } } } },
      },
    });
    const edgeByTitle = (t) => edgeRecords.find((r) => r.page.title === t);
    check(
      "a cross-database parent degrades to a root",
      edgeByTitle("Crosser")?.parentRecordId === null
    );
    check(
      "of a two-record ring, the first edge survives",
      edgeByTitle("Ring A")?.parent?.page.title === "Ring B"
    );
    check(
      "…and the edge that would close the ring degrades to a root",
      edgeByTitle("Ring B")?.parentRecordId === null
    );

    // ---- Links prefer the restored set --------------------------------------
    // Importing beside a same-titled page must bind the restored [[link]] to
    // the restored copy; titles only the workspace has still resolve; and a
    // pre-existing dangling link resolves to a restored page of that title.
    console.log("\nLink resolution after restore");
    const linkWs = await mkWs("Link preference");
    const preexistingTarget = await prisma.page.create({
      data: {
        workspaceId: linkWs.id,
        type: "document",
        title: "Berth notes",
        plainText: "original berth notes",
        createdById: fUser.id,
        sortOrder: 1,
      },
    });
    const dangler = await prisma.page.create({
      data: {
        workspaceId: linkWs.id,
        type: "document",
        title: "Old logbook",
        content: docContent("see [[Tide tables]]"),
        plainText: "see [[Tide tables]]",
        createdById: fUser.id,
        sortOrder: 2,
      },
    });
    await prisma.pageLink.create({
      data: {
        workspaceId: linkWs.id,
        fromPageId: dangler.id,
        toPageId: null,
        targetTitle: "Tide tables",
      },
    });
    const fallbackTarget = await prisma.page.create({
      data: {
        workspaceId: linkWs.id,
        type: "document",
        title: "Rigging guide",
        plainText: "rigging",
        createdById: fUser.id,
        sortOrder: 3,
      },
    });
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Links" },
        pages: [
          v1Page("l-linker", {
            title: "Moor plan",
            content: docContent("Moor per [[Berth notes]] and [[Rigging guide]]"),
          }),
          v1Page("l-target", { title: "Berth notes", sortOrder: 2 }),
          v1Page("l-tides", { title: "Tide tables", sortOrder: 3 }),
        ],
        databases: [],
        properties: [],
        records: [],
        values: [],
      },
      { workspaceId: linkWs.id, userId: fUser.id }
    );
    const restoredLinker = await prisma.page.findFirst({
      where: { workspaceId: linkWs.id, title: "Moor plan" },
    });
    const restoredBerth = await prisma.page.findFirst({
      where: { workspaceId: linkWs.id, title: "Berth notes", id: { not: preexistingTarget.id } },
    });
    const linkerLinks = await prisma.pageLink.findMany({
      where: { fromPageId: restoredLinker?.id ?? "" },
    });
    check(
      "a restored link binds to the restored same-titled page, not the pre-existing one",
      Boolean(restoredBerth) &&
        linkerLinks.find((l) => l.targetTitle === "Berth notes")?.toPageId === restoredBerth.id,
      JSON.stringify(linkerLinks.map((l) => [l.targetTitle, l.toPageId]))
    );
    check(
      "a title only the workspace has still resolves workspace-wide",
      linkerLinks.find((l) => l.targetTitle === "Rigging guide")?.toPageId === fallbackTarget.id
    );
    const danglerLink = await prisma.pageLink.findFirst({ where: { fromPageId: dangler.id } });
    const restoredTides = await prisma.page.findFirst({
      where: { workspaceId: linkWs.id, title: "Tide tables" },
    });
    check(
      "a pre-existing dangling link resolves to the restored title",
      Boolean(restoredTides) && danglerLink?.toPageId === restoredTides.id,
      `toPageId=${danglerLink?.toPageId}`
    );

    // ---- Attachments travel in the snapshot ---------------------------------
    // Attachment bytes live only in DB rows; before version 3 a backup carried
    // the /api/attachments/<id> URLs but never the bytes, so a restore after
    // deletion (or on a fresh instance) meant every image 404s forever. Full
    // HTTP round trip: upload → embed → back up → hard-delete the original →
    // restore → the copy serves its own bytes from a fresh row.
    console.log("\nAttachment round trip (backup → restore)");
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(64),
    ]);
    const ATT_TITLE = "ATT-" + randomBytes(4).toString("hex");
    const attPage = await (await req("POST", "/api/pages", { title: ATT_TITLE })).json();
    const attForm = new FormData();
    attForm.append("file", new File([PNG], "boat.png"));
    attForm.append("pageId", attPage.page.id);
    res = await req("POST", "/api/attachments", attForm, true);
    data = await res.json().catch(() => ({}));
    check("uploaded an attachment", res.status === 201, `${res.status} ${JSON.stringify(data)}`);
    const oldAttId = data.attachment?.id;
    const oldAttUrl = `/api/attachments/${oldAttId}`;
    await req("PATCH", `/api/pages/${attPage.page.id}`, {
      content: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: ATT_TITLE + "-body" }] },
          { type: "image", attrs: { src: oldAttUrl } },
        ],
      }),
    });

    res = await req("POST", "/api/workspace/export", {});
    const attSnapshot = JSON.parse(await res.text());
    check("export writes version 3", attSnapshot.version === 3, `version=${attSnapshot.version}`);
    const snapAtt = (attSnapshot.attachments ?? []).find((a) => a.id === oldAttId);
    check(
      "the snapshot carries the attachment bytes, base64-encoded",
      Boolean(snapAtt) && Buffer.from(snapAtt.data, "base64").equals(PNG),
      JSON.stringify((attSnapshot.attachments ?? []).map((a) => a.id))
    );

    res = await req("POST", "/api/workspace/backups", {});
    data = await res.json().catch(() => ({}));
    check("backed up with the attachment on board", res.status === 200, `${res.status}`);
    const attBackup = path.basename(String(data.file));

    // Hard-delete the original attachment row: the old URL must 404, and only
    // a restore that carries bytes can bring the image back.
    res = await req("DELETE", oldAttUrl);
    check("deleted the original attachment", res.status === 200, `${res.status}`);

    res = await req("POST", "/api/workspace/backups/restore", { filename: attBackup });
    data = await res.json().catch(() => ({}));
    check("restore with attachments succeeds", res.status === 200, `${res.status} ${JSON.stringify(data)}`);

    const attPages = await prisma.page.findMany({
      where: { workspaceId: workspace.id, title: ATT_TITLE },
    });
    const attCopy = attPages.find((p) => p.id !== attPage.page.id);
    check("the page restored", Boolean(attCopy), `${attPages.length} pages`);
    const newAttId = ((attCopy?.content ?? "").match(/\/api\/attachments\/([A-Za-z0-9_-]+)/) ?? [])[1];
    check(
      "restored content points at a fresh attachment id",
      Boolean(newAttId) && newAttId !== oldAttId,
      `old=${oldAttId} new=${newAttId}`
    );
    check("…and no longer references the old id", !(attCopy?.content ?? "").includes(oldAttId));

    res = await req("GET", `/api/attachments/${newAttId}`);
    const servedBytes = Buffer.from(await res.arrayBuffer());
    check("the fresh id serves", res.status === 200, `${res.status}`);
    check("…the identical bytes", servedBytes.equals(PNG));
    check(
      "…as the re-sniffed type",
      res.headers.get("content-type") === "image/png",
      String(res.headers.get("content-type"))
    );
    res = await req("GET", oldAttUrl);
    check("the old id stays 404 (the bytes came from the file, not the row)", res.status === 404, `${res.status}`);
    const restoredAttRow = await prisma.attachment.findUnique({ where: { id: newAttId ?? "" } });
    check("the restored row hangs on the restored page", restoredAttRow?.pageId === attCopy?.id);
    check(
      "…with size and hash derived from the bytes",
      restoredAttRow?.size === PNG.length &&
        restoredAttRow?.sha256 === createHash("sha256").update(PNG).digest("hex")
    );

    // The encrypted envelope path must carry them too.
    const encWs = await mkWs("Encrypted attachments");
    const encPage = await prisma.page.create({
      data: { workspaceId: encWs.id, type: "document", title: "Enc att", createdById: fUser.id, sortOrder: 1 },
    });
    const encAtt = await prisma.attachment.create({
      data: {
        workspaceId: encWs.id, pageId: encPage.id, name: "chart.png", mime: "image/png",
        size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex"), data: PNG,
        createdById: fUser.id,
      },
    });
    await prisma.page.update({
      where: { id: encPage.id },
      data: { content: docContent(`img /api/attachments/${encAtt.id}`) },
    });
    const encEnvelope = await encryptBackup(await snapshotWorkspace(encWs.id), "hoist the colours");
    const encDst = await mkWs("Encrypted attachments restore");
    await restoreSnapshot(await parseBackup(encEnvelope, "hoist the colours"), {
      workspaceId: encDst.id,
      userId: fUser.id,
    });
    const encRestored = await prisma.attachment.findFirst({ where: { workspaceId: encDst.id } });
    check(
      "attachments survive the encrypted envelope",
      Boolean(encRestored) && Buffer.from(encRestored.data).equals(PNG) && encRestored.id !== encAtt.id
    );
    const encRestoredPage = await prisma.page.findFirst({
      where: { workspaceId: encDst.id, title: "Enc att" },
    });
    check(
      "…and the decrypted copy's content points at the fresh row",
      Boolean(encRestored) && (encRestoredPage?.content ?? "").includes(encRestored.id)
    );

    // ---- Duplicate is self-contained ----------------------------------------
    // A duplicate's images used to point at the ORIGINAL page's attachment
    // rows, so hard-deleting the original silently broke the surviving copy.
    console.log("\nDuplicate copies attachment rows");
    const dupWs = await mkWs("Duplicate attachments");
    const dupPage = await prisma.page.create({
      data: { workspaceId: dupWs.id, type: "document", title: "Rigging photos", createdById: fUser.id, sortOrder: 1 },
    });
    const dupAtt = await prisma.attachment.create({
      data: {
        workspaceId: dupWs.id, pageId: dupPage.id, name: "rig.png", mime: "image/png",
        size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex"), data: PNG,
        createdById: fUser.id,
      },
    });
    await prisma.page.update({
      where: { id: dupPage.id },
      data: { content: docContent(`see /api/attachments/${dupAtt.id}`) },
    });
    // Exactly what the duplicate route runs: subtree snapshot, restored beside
    // the original in the same workspace.
    await restoreSnapshot(await snapshotWorkspace(dupWs.id, dupPage.id), {
      workspaceId: dupWs.id,
      userId: fUser.id,
      parentPageId: null,
      rootTitle: "Rigging photos (copy)",
      sortOrderBase: 1.5,
    });
    const dupCopy = await prisma.page.findFirst({
      where: { workspaceId: dupWs.id, title: "Rigging photos (copy)" },
    });
    const dupCopyAtt = await prisma.attachment.findFirst({ where: { pageId: dupCopy?.id ?? "" } });
    check("the copy has its own attachment row", Boolean(dupCopyAtt) && dupCopyAtt.id !== dupAtt.id);
    check("…with identical bytes", Boolean(dupCopyAtt) && Buffer.from(dupCopyAtt.data).equals(PNG));
    check("…and the copy's content references it", Boolean(dupCopyAtt) && (dupCopy?.content ?? "").includes(dupCopyAtt.id));
    // Hard-delete the original page: its attachment cascades away, and the
    // copy must not notice.
    await prisma.page.delete({ where: { id: dupPage.id } });
    check(
      "the original's attachment cascaded away",
      (await prisma.attachment.count({ where: { id: dupAtt.id } })) === 0
    );
    const dupSurvivor = await prisma.attachment.findUnique({ where: { id: dupCopyAtt?.id ?? "" } });
    check(
      "the copy's attachment survives the original's hard delete",
      Boolean(dupSurvivor) && Buffer.from(dupSurvivor.data).equals(PNG)
    );

    // ---- Duplicate carries detached record pages ----------------------------
    // Trash-restoring a record page while its parent is still trashed detaches
    // it to the workspace root; views still show the record, but the subtree
    // snapshot used to walk only parent→child edges and silently dropped it
    // from the copy.
    console.log("\nDuplicate carries detached record pages");
    const detWs = await mkWs("Detached records");
    const detDbPage = await prisma.page.create({
      data: { workspaceId: detWs.id, type: "database", title: "Voyages", createdById: fUser.id, sortOrder: 1 },
    });
    const detDb = await prisma.database.create({ data: { workspaceId: detWs.id, pageId: detDbPage.id } });
    const detProp = await prisma.databaseProperty.create({
      data: { databaseId: detDb.id, name: "Port", type: "text", sortOrder: 1 },
    });
    const detAttachedPage = await prisma.page.create({
      data: { workspaceId: detWs.id, type: "record", title: "Attached voyage", parentPageId: detDbPage.id, createdById: fUser.id, sortOrder: 1 },
    });
    await prisma.databaseRecord.create({
      data: { databaseId: detDb.id, pageId: detAttachedPage.id, sortOrder: 1 },
    });
    // The trash-restore shape: a record page detached to the workspace root.
    const detDetachedPage = await prisma.page.create({
      data: { workspaceId: detWs.id, type: "record", title: "Detached voyage", parentPageId: null, createdById: fUser.id, sortOrder: 2 },
    });
    const detDetachedRec = await prisma.databaseRecord.create({
      data: { databaseId: detDb.id, pageId: detDetachedPage.id, sortOrder: 2 },
    });
    await prisma.databaseValue.create({
      data: { recordId: detDetachedRec.id, propertyId: detProp.id, value: '"Nassau"' },
    });
    await prisma.page.create({
      data: { workspaceId: detWs.id, type: "document", title: "DETACHED-LOG", parentPageId: detDetachedPage.id, createdById: fUser.id, sortOrder: 1 },
    });

    const detSnap = await snapshotWorkspace(detWs.id, detDbPage.id);
    check(
      "the subtree snapshot reaches the detached record page",
      detSnap.pages.some((p) => p.title === "Detached voyage"),
      JSON.stringify(detSnap.pages.map((p) => p.title))
    );
    check("…and its subtree", detSnap.pages.some((p) => p.title === "DETACHED-LOG"));
    check("…and its record row", detSnap.records.length === 2, `${detSnap.records.length}`);

    const detDst = await mkWs("Detached records restore");
    await restoreSnapshot(detSnap, { workspaceId: detDst.id, userId: fUser.id });
    const detCopyDbPage = await prisma.page.findFirst({
      where: { workspaceId: detDst.id, title: "Voyages" },
    });
    const detCopyRecs = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: detDst.id } },
      include: { page: true },
    });
    check("the copy has both records", detCopyRecs.length === 2, `${detCopyRecs.length}`);
    const detCopyDetached = detCopyRecs.find((r) => r.page.title === "Detached voyage");
    check(
      "the detached record's page is normalized under the database",
      Boolean(detCopyDetached) && detCopyDetached.page.parentPageId === detCopyDbPage?.id
    );
    check(
      "…its value came along",
      Boolean(detCopyDetached) &&
        (await prisma.databaseValue.count({ where: { recordId: detCopyDetached.id } })) === 1
    );
    const detCopyLog = await prisma.page.findFirst({
      where: { workspaceId: detDst.id, title: "DETACHED-LOG" },
    });
    check(
      "…and its child page hangs under it",
      Boolean(detCopyLog) && detCopyLog.parentPageId === detCopyDetached?.page.id
    );

    // ---- Page-parent cycles degrade instead of vanishing --------------------
    // Record-edge rings already degrade to roots; page rings used to make the
    // whole subtree unreachable from any root, so it silently never restored.
    console.log("\nPage-parent cycles degrade instead of vanishing");
    const cycleWs = await mkWs("Cycle restore");
    const cycleRes = await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Cycles" },
        pages: [
          v1Page("cy-a", { title: "Ring page A", parentPageId: "cy-b" }),
          v1Page("cy-b", { title: "Ring page B", parentPageId: "cy-a", sortOrder: 2 }),
          v1Page("cy-c", { title: "Ring child C", parentPageId: "cy-a", sortOrder: 3 }),
          v1Page("cy-root", { title: "Honest root", sortOrder: 4 }),
        ],
        databases: [],
        properties: [],
        records: [],
        values: [],
      },
      { workspaceId: cycleWs.id, userId: fUser.id }
    );
    const cyclePages = await prisma.page.findMany({ where: { workspaceId: cycleWs.id } });
    const cycleByTitle = (t) => cyclePages.find((p) => p.title === t);
    check("nothing in the ring is dropped", cyclePages.length === 4, `${cyclePages.length}`);
    check("the first ring member degrades to a root", cycleByTitle("Ring page A")?.parentPageId === null);
    check(
      "…its partner hangs beneath it",
      Boolean(cycleByTitle("Ring page B")) &&
        cycleByTitle("Ring page B").parentPageId === cycleByTitle("Ring page A")?.id
    );
    check(
      "…and the ring's child restores in place",
      Boolean(cycleByTitle("Ring child C")) &&
        cycleByTitle("Ring child C").parentPageId === cycleByTitle("Ring page A")?.id
    );
    check(
      "degraded pages count as restored roots",
      cycleRes.rootPageIds.length === 2,
      `${cycleRes.rootPageIds.length}`
    );

    // A child beneath a dropped orphan record page used to vanish with it.
    const orphanWs = await mkWs("Orphan child restore");
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Orphans" },
        pages: [
          v1Page("orph", { type: "record", title: "Orphan record page" }),
          v1Page("orph-child", { title: "Orphan survivor", parentPageId: "orph", sortOrder: 2 }),
        ],
        databases: [],
        properties: [],
        records: [{ id: "orph-r", databaseId: "gone", pageId: "orph", sortOrder: 1 }],
        values: [],
      },
      { workspaceId: orphanWs.id, userId: fUser.id }
    );
    const orphanPages = await prisma.page.findMany({ where: { workspaceId: orphanWs.id } });
    check(
      "an orphan record page itself stays dropped",
      !orphanPages.some((p) => p.title === "Orphan record page"),
      JSON.stringify(orphanPages.map((p) => p.title))
    );
    check(
      "…but its child degrades to a root instead of vanishing",
      orphanPages.find((p) => p.title === "Orphan survivor")?.parentPageId === null
    );

    // ---- Shape-valid hostile values are refused up front --------------------
    // Round 10's validator checked types only, so unparseable dates, hostile
    // documents and absurd row counts sailed into the transaction and died as
    // unclassified 500s. All of these must be the validator's clear 400.
    console.log("\nShape-valid hostile values are refused up front");
    const hostileWs = await mkWs("Hostile restore");
    const hostileBase = () => ({
      format: "keel-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      workspace: { name: "Hostile" },
      pages: [v1Page("h-1", { title: "Hostile" })],
      databases: [],
      properties: [],
      records: [],
      values: [],
    });
    const expect400 = async (name, snap) => {
      let message = "";
      try {
        await restoreSnapshot(snap, { workspaceId: hostileWs.id, userId: fUser.id });
      } catch (err) {
        message = String(err?.message ?? err);
      }
      check(name, message.includes("Not a valid Keel backup file"), message || "restore succeeded");
    };
    await expect400("an unparseable archivedAt is refused, not a mid-transaction 500", {
      ...hostileBase(),
      pages: [v1Page("h-1", { archivedAt: "the day the music died" })],
    });
    await expect400("a hostile document (marks: 5) is refused", {
      ...hostileBase(),
      pages: [
        v1Page("h-1", {
          content: JSON.stringify({ type: "doc", content: [{ type: "text", text: "x", marks: 5 }] }),
        }),
      ],
    });
    await expect400("a NaN sortOrder is refused", {
      ...hostileBase(),
      pages: [v1Page("h-1", { sortOrder: NaN })],
    });
    await expect400("an empty-string id is refused", { ...hostileBase(), pages: [v1Page("")] });
    await expect400("a malformed attachment row is refused", {
      ...hostileBase(),
      attachments: [{ id: "a1", pageId: "h-1", name: "f", mime: "x", size: 1, data: 12345 }],
    });
    await expect400("an implausible row count is refused before the transaction", {
      ...hostileBase(),
      values: new Array(2_000_001).fill({ recordId: "r", propertyId: "p", value: null }),
    });
    check(
      "no refused restore wrote anything",
      (await prisma.page.count({ where: { workspaceId: hostileWs.id } })) === 0
    );

    // A view config that parses to a primitive degrades to unset, like any
    // other garbage config - not a TypeError inside the transaction.
    const primWs = await mkWs("Primitive config restore");
    await restoreSnapshot(
      {
        ...hostileBase(),
        pages: [v1Page("pv-db", { type: "database", title: "Prim db" })],
        databases: [{ id: "pvd", pageId: "pv-db" }],
        views: [{ databaseId: "pvd", name: "Odd", type: "table", sortOrder: 1, config: "5" }],
      },
      { workspaceId: primWs.id, userId: fUser.id }
    );
    const primView = await prisma.databaseView.findFirst({
      where: { database: { workspaceId: primWs.id } },
    });
    check(
      "a primitive view config restores as unset",
      Boolean(primView) && primView.config === null,
      String(primView?.config)
    );

    // And over HTTP: the import route classifies hostile values as a 400.
    const hostileForm = new FormData();
    hostileForm.append(
      "file",
      new File(
        [JSON.stringify({ ...hostileBase(), pages: [v1Page("h-1", { archivedAt: "not a date" })] })],
        "evil.json"
      )
    );
    res = await req("POST", "/api/workspace/import", hostileForm, true);
    check("the import route returns 400 for hostile values", res.status === 400, `${res.status}`);

    // ---- A big valid import restores fast (batched, not row-at-a-time) ------
    // Row-at-a-time creates let a large valid import hold SQLite's write lock
    // for the whole 120s budget and then roll back - and a retry could never
    // do better. Batched, the same import is over in seconds.
    console.log("\nLarge import stays well inside the transaction budget");
    const bigPages = [];
    const bigRecords = [];
    const bigValues = [];
    for (let i = 0; i < 2000; i++) {
      // Chains of 10 exercise the ordered batch insert of parent edges.
      bigPages.push(
        v1Page(`big-doc-${i}`, {
          title: `Big doc ${i}`,
          parentPageId: i % 10 === 0 ? null : `big-doc-${i - 1}`,
          sortOrder: i,
          content: docContent(`big body ${i}`),
        })
      );
    }
    bigPages.push(v1Page("big-db", { type: "database", title: "Big db", sortOrder: 9999 }));
    for (let i = 0; i < 2000; i++) {
      bigPages.push(
        v1Page(`big-rec-page-${i}`, {
          type: "record",
          title: `Big row ${i}`,
          parentPageId: "big-db",
          sortOrder: i,
        })
      );
      bigRecords.push({
        id: `big-rec-${i}`,
        databaseId: "bigd",
        pageId: `big-rec-page-${i}`,
        sortOrder: i,
        parentRecordId: i % 2 === 1 ? `big-rec-${i - 1}` : null,
      });
      bigValues.push({ recordId: `big-rec-${i}`, propertyId: "bigp1", value: `"v${i}"` });
      bigValues.push({ recordId: `big-rec-${i}`, propertyId: "bigp2", value: String(i) });
    }
    const bigWs = await mkWs("Big import");
    const bigStart = performance.now();
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Big" },
        pages: bigPages,
        databases: [{ id: "bigd", pageId: "big-db" }],
        properties: [
          { id: "bigp1", databaseId: "bigd", name: "Alpha", type: "text", settings: null, sortOrder: 1 },
          { id: "bigp2", databaseId: "bigd", name: "Beta", type: "text", settings: null, sortOrder: 2 },
        ],
        records: bigRecords,
        values: bigValues,
        views: [{ databaseId: "bigd", name: "All", type: "table", sortOrder: 1, config: null }],
      },
      { workspaceId: bigWs.id, userId: fUser.id }
    );
    const bigMs = Math.round(performance.now() - bigStart);
    check(`4001 pages / 2000 records / 4000 values restored in ${bigMs}ms`, bigMs < 15_000, `${bigMs}ms`);
    check(
      "…every page landed",
      (await prisma.page.count({ where: { workspaceId: bigWs.id } })) === 4001
    );
    check(
      "…every record landed",
      (await prisma.databaseRecord.count({ where: { database: { workspaceId: bigWs.id } } })) === 2000
    );
    check(
      "…parent edges rode along in the batch",
      (await prisma.databaseRecord.count({
        where: { database: { workspaceId: bigWs.id }, parentRecordId: { not: null } },
      })) === 1000
    );
    check(
      "…every value landed",
      (await prisma.databaseValue.count({
        where: { record: { database: { workspaceId: bigWs.id } } },
      })) === 4000
    );

    // ---- A restore obeys the limits the write paths enforce ----------------
    // Import used to bypass every configured storage bound: an editor who is
    // refused a 51 MB upload could hand-build a backup carrying a 375 MB
    // attachment, or blow past the workspace quota, or write a page document
    // hundreds of times MAX_CONTENT. The caps are only caps if every way in
    // respects them.
    console.log("\nRestore obeys the same limits as the write paths");
    const { maxBackupUploadBytes } = await import(
      pathToFileURL(path.join(root, "src/lib/limits.ts")).href
    );
    const { attachmentQuotaBytes } = await import(
      pathToFileURL(path.join(root, "src/lib/attachments.ts")).href
    );
    check(
      "the upload cap genuinely exceeds a full workspace's own backup (quota x 4/3)",
      maxBackupUploadBytes() > (attachmentQuotaBytes() * 4) / 3,
      `cap=${Math.round(maxBackupUploadBytes() / 1048576)} MB quota=${Math.round(
        attachmentQuotaBytes() / 1048576
      )} MB`
    );
    check(
      "…and an encrypted one too (quota x 16/9, the envelope's second base64)",
      maxBackupUploadBytes() > (attachmentQuotaBytes() * 16) / 9
    );

    const attachmentSnapshot = (bytesOrB64, over = {}) => ({
      format: "keel-backup",
      version: 3,
      exportedAt: new Date().toISOString(),
      workspace: { name: "Limits" },
      pages: [
        v1Page("lim-page", {
          title: "Limit page",
          content: docContent("see /api/attachments/lim-att-1"),
        }),
      ],
      databases: [],
      properties: [],
      records: [],
      values: [],
      attachments: [
        {
          id: "lim-att-1",
          pageId: "lim-page",
          name: "big.bin",
          mime: "image/png",
          size: 1,
          data: Buffer.isBuffer(bytesOrB64) ? bytesOrB64.toString("base64") : bytesOrB64,
        },
      ],
      ...over,
    });

    // A PNG so the re-sniff keeps it inline-renderable; 2 MB so it is over the
    // caps set below and under them when they are restored to normal.
    const TWO_MB = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024, 0x5a),
    ]);

    const quotaWs = await mkWs("Quota refusal");
    process.env.KEEL_ATTACHMENT_QUOTA_MB = "1";
    let quotaError = "";
    try {
      await restoreSnapshot(attachmentSnapshot(TWO_MB), {
        workspaceId: quotaWs.id,
        userId: fUser.id,
      });
    } catch (err) {
      quotaError = String(err?.message ?? err);
    }
    delete process.env.KEEL_ATTACHMENT_QUOTA_MB;
    check(
      "a restore that would exceed the workspace attachment quota is refused",
      quotaError.includes("over its 1 MB limit"),
      quotaError || "restore succeeded"
    );
    check(
      "…before the first row is written",
      (await prisma.page.count({ where: { workspaceId: quotaWs.id } })) === 0 &&
        (await prisma.attachment.count({ where: { workspaceId: quotaWs.id } })) === 0
    );

    // Over the per-file cap: skipped and reported, not fatal - an old backup
    // written when the cap was higher must still restore everything else.
    const capWs = await mkWs("Per-file cap");
    process.env.KEEL_MAX_ATTACHMENT_MB = "1";
    const capReport = await restoreSnapshot(attachmentSnapshot(TWO_MB), {
      workspaceId: capWs.id,
      userId: fUser.id,
    });
    delete process.env.KEEL_MAX_ATTACHMENT_MB;
    check(
      "an attachment over the per-file cap is skipped and reported",
      capReport.skippedAttachments?.tooLarge === 1,
      JSON.stringify(capReport.skippedAttachments)
    );
    check(
      "…no row was written for it",
      (await prisma.attachment.count({ where: { workspaceId: capWs.id } })) === 0
    );
    check(
      "…but the rest of the snapshot restored",
      (await prisma.page.count({ where: { workspaceId: capWs.id } })) === 1
    );
    const capPage = await prisma.page.findFirst({ where: { workspaceId: capWs.id } });
    check(
      "…and its URL was left alone, not repointed at an id that will never exist",
      (capPage?.content ?? "").includes("/api/attachments/lim-att-1"),
      capPage?.content
    );

    // ---- Big pages: both directions of the content ceiling -----------------
    // A previous round enforced MAX_CONTENT - the SAVE limit - at
    // restoreSnapshot's door. That refused Keel's own backups whole (the
    // OneNote mirror writes page content with no cap, so a workspace can hold
    // such a row legitimately) and, because duplication shares this path,
    // turned duplicating a big page into a 500. Removing the check outright
    // would put back the hand-built hundred-megabyte document it was aimed at.
    // Both directions are therefore tested here; getting either one wrong is
    // worse than the bug that started it.
    console.log("\nBig pages restore, hand-built giant ones do not");
    const { MAX_CONTENT, MAX_RESTORED_CONTENT, MAX_NAME, MAX_TITLE, MAX_VALUE } = await import(
      pathToFileURL(path.join(root, "src/lib/limits.ts")).href
    );
    const { snapshotChunksOf, liveExportBytes, readBackupStream } = await import(
      pathToFileURL(path.join(root, "src/lib/backup.ts")).href
    );

    {
      // A document that lands at EXACTLY MAX_CONTENT: the save path refuses only
      // `> MAX_CONTENT`, so this is the largest page the editor can produce, and
      // it is a page that genuinely exists.
      const exactDoc = (() => {
        const shell = docContent("");
        return docContent("x".repeat(MAX_CONTENT - shell.length));
      })();
      check("built a document of exactly MAX_CONTENT", exactDoc.length === MAX_CONTENT, `${exactDoc.length}`);

      const hugeWs = await mkWs("Big pages");
      const hugePage = await prisma.page.create({
        data: {
          workspaceId: hugeWs.id,
          type: "document",
          title: "Biggest page",
          content: exactDoc,
          sortOrder: 1,
          createdById: fUser.id,
        },
      });
      // Exactly what /api/pages/<id>/duplicate does.
      let dupError = "";
      let dupIds = [];
      try {
        const { rootPageIds } = await restoreSnapshot(
          await snapshotWorkspace(hugeWs.id, hugePage.id),
          {
            workspaceId: hugeWs.id,
            userId: fUser.id,
            parentPageId: hugePage.parentPageId,
            rootTitle: `${hugePage.title} (copy)`,
            sortOrderBase: hugePage.sortOrder + 0.5,
          }
        );
        dupIds = rootPageIds;
      } catch (err) {
        dupError = String(err?.message ?? err);
      }
      const dupCopy = dupIds[0] ? await prisma.page.findUnique({ where: { id: dupIds[0] } }) : null;
      check(
        "a page at exactly MAX_CONTENT duplicates",
        dupCopy?.content === exactDoc && dupCopy?.title === "Biggest page (copy)",
        dupError || `${dupCopy?.content?.length} ${dupCopy?.title}`
      );

      // …and survives a real file: written by the streaming writer, read back by
      // the streaming reader, restored. This is "restoring a backup Keel itself
      // wrote always works", end to end.
      {
        const { writeFileSync, createReadStream } = await import("fs");
        const hugeFile = path.join(BACKUP_DIR, "big-page-roundtrip.json");
        const pieces = [];
        for await (const piece of snapshotChunksOf(await snapshotWorkspace(hugeWs.id), liveExportBytes())) {
          pieces.push(piece);
        }
        writeFileSync(hugeFile, pieces.join(""));
        const hugeDst = await mkWs("Big page restore target");
        let hugeErr = "";
        try {
          const read = await readBackupStream(createReadStream(hugeFile));
          await restoreSnapshot(read.snapshot, {
            workspaceId: hugeDst.id,
            userId: fUser.id,
            attachmentBytes: read.attachmentBytes,
          });
          await read.dispose();
        } catch (err) {
          hugeErr = String(err?.message ?? err);
        }
        const restoredHuge = await prisma.page.findMany({
          where: { workspaceId: hugeDst.id },
          select: { content: true },
        });
        check(
          "a backup carrying a MAX_CONTENT page restores from its own file",
          !hugeErr && restoredHuge.some((p) => p.content === exactDoc),
          hugeErr || `${restoredHuge.length} pages, lengths ${restoredHuge.map((p) => p.content?.length)}`
        );
      }

      // The other direction: a hand-built file whose document no writer here
      // could have produced is still refused, and refused before it writes.
      {
        const { writeFileSync } = await import("fs");
        const giant = docContent("x".repeat(MAX_RESTORED_CONTENT + 1024));
        const giantWs = await mkWs("Giant hand-built page");
        const giantFile = path.join(BACKUP_DIR, "giant-page.json");
        writeFileSync(
          giantFile,
          JSON.stringify({
            ...attachmentSnapshot(TWO_MB),
            attachments: [],
            pages: [v1Page("giant-page", { content: giant })],
          })
        );
        const { createReadStream } = await import("fs");
        let giantErr = "";
        try {
          const read = await readBackupStream(createReadStream(giantFile));
          await restoreSnapshot(read.snapshot, { workspaceId: giantWs.id, userId: fUser.id });
          await read.dispose();
        } catch (err) {
          giantErr = String(err?.message ?? err);
        }
        check(
          "a hand-built page document past the restore ceiling is refused",
          giantErr.includes("Not a valid Keel backup file"),
          giantErr || "restore succeeded"
        );
        check(
          "…and nothing was written",
          (await prisma.page.count({ where: { workspaceId: giantWs.id } })) === 0
        );
      }

    }

    // ---- The other three limit columns -------------------------------------
    // MAX_CONTENT was one column of four. Titles, property/view names and
    // database values had no ceiling on this path at all, so a hand-edited
    // file could put rows into SQLite that no API can produce. Each column is
    // handled the way its live write path handles an over-length value -
    // titles and names are sliced, values are refused - because doing anything
    // else creates a row the app has never had to render.
    console.log("\nRestore holds a FILE to the other limit columns");
    {
      const { writeFileSync, createReadStream } = await import("fs");
      const overWs = await mkWs("Over-length columns");
      const overFile = path.join(BACKUP_DIR, "over-length.json");
      writeFileSync(
        overFile,
        JSON.stringify({
          format: "keel-backup",
          version: 3,
          exportedAt: new Date().toISOString(),
          workspace: { name: "Over" },
          pages: [
            v1Page("ov-db-page", { title: "T".repeat(MAX_TITLE + 500), type: "database" }),
            v1Page("ov-rec-page", { title: "R".repeat(MAX_TITLE + 500), type: "record" }),
          ],
          databases: [{ id: "ov-db", pageId: "ov-db-page" }],
          properties: [
            {
              id: "ov-prop",
              databaseId: "ov-db",
              name: "N".repeat(MAX_NAME + 500),
              type: "text",
              settings: null,
              sortOrder: 0,
            },
            { id: "ov-prop2", databaseId: "ov-db", name: "Fits", type: "text", settings: null, sortOrder: 1 },
          ],
          records: [{ id: "ov-rec", databaseId: "ov-db", pageId: "ov-rec-page", sortOrder: 0 }],
          values: [
            // Over the cap (the quotes push it past) and exactly at it: the
            // first must go, the second must survive untouched.
            { recordId: "ov-rec", propertyId: "ov-prop", value: JSON.stringify("v".repeat(MAX_VALUE)) },
            { recordId: "ov-rec", propertyId: "ov-prop2", value: "v".repeat(MAX_VALUE) },
          ],
          views: [
            { databaseId: "ov-db", name: "V".repeat(MAX_NAME + 500), type: "table", sortOrder: 0, config: null },
          ],
        })
      );
      let overErr = "";
      try {
        const read = await readBackupStream(createReadStream(overFile));
        await restoreSnapshot(read.snapshot, { workspaceId: overWs.id, userId: fUser.id });
        await read.dispose();
      } catch (err) {
        overErr = String(err?.message ?? err);
      }
      check("an over-length file still restores rather than being refused", !overErr, overErr);
      const overPages = await prisma.page.findMany({ where: { workspaceId: overWs.id } });
      check(
        "…every page came in, with its title clamped to MAX_TITLE",
        overPages.length === 2 && overPages.every((p) => p.title.length === MAX_TITLE),
        `${overPages.length}: ${overPages.map((p) => p.title.length)}`
      );
      const overProp = await prisma.databaseProperty.findFirst({
        where: { database: { workspaceId: overWs.id } },
      });
      check(
        "…the property name is clamped to MAX_NAME",
        overProp?.name.length === MAX_NAME,
        `${overProp?.name.length}`
      );
      const overView = await prisma.databaseView.findFirst({
        where: { database: { workspaceId: overWs.id } },
      });
      check("…the view name too", overView?.name.length === MAX_NAME, `${overView?.name.length}`);
      const overValues = await prisma.databaseValue.findMany({
        where: { property: { database: { workspaceId: overWs.id } } },
      });
      check(
        "…the cell past MAX_VALUE was dropped rather than stored or truncated",
        overValues.length === 1,
        `${overValues.length}: ${overValues.map((v) => v.value?.length)}`
      );
      check(
        "…and the cell at exactly MAX_VALUE came through whole",
        overValues[0]?.value?.length === MAX_VALUE,
        `${overValues[0]?.value?.length}`
      );
    }

    // ---- A skipped attachment's URL stays exactly as dangling as it was ----
    // The remap table used to be built from every row in the file before any
    // skip decision, so an attachment with unreadable bytes left the restored
    // content pointing at a freshly minted id no row would ever carry - a
    // guaranteed 404 where doing nothing would have kept working.
    console.log("\nSkipped attachments leave their URLs alone");
    const danglingWs = await mkWs("Dangling attachment URLs");
    const danglingReport = await restoreSnapshot(attachmentSnapshot("!!!!"), {
      workspaceId: danglingWs.id,
      userId: fUser.id,
    });
    const danglingPage = await prisma.page.findFirst({ where: { workspaceId: danglingWs.id } });
    check(
      "an attachment whose bytes will not decode is reported as skipped",
      danglingReport.skippedAttachments?.empty === 1,
      JSON.stringify(danglingReport.skippedAttachments)
    );
    check(
      "…and the content URL still names the original id",
      (danglingPage?.content ?? "").includes("/api/attachments/lim-att-1"),
      danglingPage?.content
    );
    check(
      "…which is the only id it names",
      ((danglingPage?.content ?? "").match(/\/api\/attachments\/[A-Za-z0-9_-]+/g) ?? []).every(
        (u) => u === "/api/attachments/lim-att-1"
      )
    );

    // ---- Duplicate record ids cannot smuggle a cross-database parent -------
    // Records dedupe first-wins, but the edge check consulted a map built with
    // the Map constructor, which keeps the LAST row per id. Two records sharing
    // an id, one per database, therefore validated the child against the copy
    // that was skipped while the row that landed pointed into the other
    // database - the exact edge assertCanReparent makes unreachable via the API.
    console.log("\nDuplicate record ids cannot smuggle a cross-database parent");
    const dupIdWs = await mkWs("Duplicate record ids");
    await restoreSnapshot(
      {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "DupIds" },
        pages: [
          v1Page("di-db1", { type: "database", title: "Dup one" }),
          v1Page("di-db2", { type: "database", title: "Dup two", sortOrder: 2 }),
          v1Page("di-p1", { type: "record", title: "P in one", parentPageId: "di-db1" }),
          v1Page("di-p2", { type: "record", title: "P in two", parentPageId: "di-db2", sortOrder: 2 }),
          v1Page("di-c", { type: "record", title: "Child in two", parentPageId: "di-db2", sortOrder: 3 }),
        ],
        databases: [
          { id: "dd1", pageId: "di-db1" },
          { id: "dd2", pageId: "di-db2" },
        ],
        properties: [],
        records: [
          { id: "P", databaseId: "dd1", pageId: "di-p1", sortOrder: 1 },
          { id: "P", databaseId: "dd2", pageId: "di-p2", sortOrder: 2 },
          { id: "C", databaseId: "dd2", pageId: "di-c", sortOrder: 3, parentRecordId: "P" },
        ],
        values: [],
        views: [],
      },
      { workspaceId: dupIdWs.id, userId: fUser.id }
    );
    const dupIdRecords = await prisma.databaseRecord.findMany({
      where: { database: { workspaceId: dupIdWs.id } },
      include: { page: { select: { title: true } }, parent: true },
    });
    check(
      "the duplicate id is created once, first-wins",
      dupIdRecords.length === 2,
      dupIdRecords.map((r) => r.page.title).join(",")
    );
    check(
      "no restored record has a parent in another database",
      dupIdRecords.every((r) => !r.parent || r.parent.databaseId === r.databaseId),
      JSON.stringify(
        dupIdRecords.map((r) => [r.page.title, r.databaseId, r.parent?.databaseId ?? null])
      )
    );
    check(
      "…the crafted child degrades to a root",
      dupIdRecords.find((r) => r.page.title === "Child in two")?.parentRecordId === null
    );

    // ---- The scheduler stops hammering a workspace that cannot back up ----
    console.log("\nScheduled backups back off instead of retrying every tick");
    const { backupBackoff } = await import(
      pathToFileURL(path.join(root, "src/lib/backup.ts")).href
    );
    const HOUR = 60 * 60 * 1000;
    const TICK = 5 * 60 * 1000; // the scheduler's CHECK_EVERY_MS
    backupBackoff.reset();
    check("a workspace with no failures is ready", backupBackoff.ready("ws-1"));
    const firstWait = backupBackoff.fail("ws-1", TICK, 24 * HOUR);
    check("after one failure it is not retried on the next tick", !backupBackoff.ready("ws-1"));
    const secondWait = backupBackoff.fail("ws-1", TICK, 24 * HOUR);
    check(
      "the wait doubles with each failure",
      firstWait === TICK && secondWait === TICK * 2,
      `${firstWait} then ${secondWait}`
    );
    let capped = 0;
    for (let i = 0; i < 20; i++) capped = backupBackoff.fail("ws-1", TICK, 6 * HOUR);
    check(
      "…and is capped at the workspace's own backup interval",
      capped === 6 * HOUR,
      `${capped}`
    );
    backupBackoff.clear("ws-1");
    check("a success clears the backoff", backupBackoff.ready("ws-1"));

    // The other half: an impossible encryption is discovered BEFORE the
    // workspace is read, so a failing tick costs nothing.
    const noKeyWs = await mkWs("Encrypt with no passphrase");
    const noKeyRow = { id: noKeyWs.id, backupDir: null, backupKeep: 3, backupEncrypt: true };
    const savedPass = process.env.KEEL_BACKUP_PASSPHRASE;
    delete process.env.KEEL_BACKUP_PASSPHRASE;
    delete process.env.NOPIN_BACKUP_PASSPHRASE;
    let noKeyError = "";
    try {
      await runBackup(noKeyRow);
    } catch (err) {
      noKeyError = String(err?.message ?? err);
    }
    if (savedPass !== undefined) process.env.KEEL_BACKUP_PASSPHRASE = savedPass;
    check(
      "an encrypted backup with no passphrase fails with a clear message",
      noKeyError.includes("no passphrase is available"),
      noKeyError || "backup succeeded"
    );
    check(
      "…before any work: not even the backup folder was created",
      !existsSync(backupDirFor(noKeyRow)),
      backupDirFor(noKeyRow)
    );

    // ---- A pre-streaming (v1) encrypted envelope still opens ---------------
    // The streaming writer moved `tag` after `data`, because a streaming
    // cipher only knows the tag at the end. Every envelope written before that
    // has it before `data`, and those files must keep working forever.
    console.log("\nEncrypted backups written by the old writer still restore");
    {
      const { writeFileSync, mkdirSync } = await import("fs");
      const { scryptSync, createCipheriv } = await import("crypto");
      const legacySnapshot = {
        format: "keel-backup",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Legacy envelope" },
        pages: [v1Page("le-1", { title: "LEGACY-ENVELOPE-PAGE" })],
        databases: [],
        properties: [],
        records: [],
        values: [],
      };
      const salt = randomBytes(16);
      const kdf = { N: 16384, r: 8, p: 1 };
      const key = scryptSync("old horse", salt, 32, kdf);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(legacySnapshot), "utf8")),
        cipher.final(),
      ]);
      // Field order exactly as the old JSON.stringify(envelope) produced it.
      const envelope = JSON.stringify({
        format: "nopin-backup-encrypted",
        version: 1,
        kdf: { name: "scrypt", salt: salt.toString("base64"), ...kdf },
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: body.toString("base64"),
      });
      const wsDir = path.join(BACKUP_DIR, workspace.id);
      mkdirSync(wsDir, { recursive: true });
      const legacyEncName = `nopin-${workspace.id.slice(0, 12)}-oldenvelope.keelbak`;
      writeFileSync(path.join(wsDir, legacyEncName), envelope);

      res = await req("POST", "/api/workspace/backups/restore", {
        filename: legacyEncName,
        passphrase: "old horse",
      });
      data = await res.json().catch(() => ({}));
      check(
        "a v1 envelope (tag before data) still decrypts and restores",
        res.status === 200 && data.restored === 1,
        `${res.status} ${JSON.stringify(data)}`
      );
      check(
        "…and its page landed",
        Boolean(
          await prisma.page.findFirst({
            where: { workspaceId: workspace.id, title: "LEGACY-ENVELOPE-PAGE" },
          })
        )
      );
      res = await req("POST", "/api/workspace/backups/restore", {
        filename: legacyEncName,
        passphrase: "not the old horse",
      });
      check("…and the wrong passphrase is still refused", res.status === 400, `${res.status}`);
    }

    // ---- The streaming reader survives awkwardly shaped files -------------
    // The reader walks JSON structurally and decodes each attachment's base64
    // as it streams past, so the shapes that could break it are: a value that
    // spans several reads, `data` arriving before the id it belongs to, and
    // whitespace where a JSON.parse-everything reader never had to look.
    console.log("\nThe streaming reader handles awkward files");
    {
      const { writeFileSync, mkdirSync } = await import("fs");
      // Comfortably larger than the reader's 1 MB fill target, so its base64
      // crosses many reads.
      const SPAN = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(3 * 1024 * 1024),
      ]);
      const spanHash = createHash("sha256").update(SPAN).digest("hex");
      const HAND_TITLE = "HANDMADE-" + randomBytes(4).toString("hex");
      const handmade = {
        format: "keel-backup",
        version: 3,
        exportedAt: new Date().toISOString(),
        workspace: { name: "Handmade" },
        pages: [
          v1Page("hm-page", {
            title: HAND_TITLE,
            content: docContent("a /api/attachments/hm-good b /api/attachments/hm-bad"),
          }),
        ],
        databases: [],
        properties: [],
        records: [],
        values: [],
        attachments: [
          // `data` deliberately first, and `size` deliberately a lie: the
          // restore derives length, mime and hash from the bytes.
          {
            data: SPAN.toString("base64"),
            id: "hm-good",
            pageId: "hm-page",
            name: "span.png",
            mime: "text/html",
            size: 7,
          },
          { id: "hm-bad", pageId: "hm-page", name: "bad.bin", mime: "image/png", size: 9, data: "!!!!" },
        ],
      };
      const wsDir = path.join(BACKUP_DIR, workspace.id);
      mkdirSync(wsDir, { recursive: true });
      const handName = `keel-${workspace.id.slice(0, 12)}-handmade.json`;
      // Whitespace between every token pair the scanner has to step over.
      writeFileSync(path.join(wsDir, handName), JSON.stringify(handmade, null, 2));

      res = await req("POST", "/api/workspace/backups/restore", { filename: handName });
      data = await res.json().catch(() => ({}));
      check(
        "a pretty-printed v3 file with data-before-id restores",
        res.status === 200 && data.restored === 1,
        `${res.status} ${JSON.stringify(data)}`
      );
      const handPage = await prisma.page.findFirst({
        where: { workspaceId: workspace.id, title: HAND_TITLE },
      });
      const handAtts = await prisma.attachment.findMany({ where: { pageId: handPage?.id ?? "" } });
      check("…the multi-read attachment landed, and only it", handAtts.length === 1);
      check(
        "…byte-identical, with mime re-sniffed rather than believed",
        handAtts[0] &&
          createHash("sha256").update(Buffer.from(handAtts[0].data)).digest("hex") === spanHash &&
          handAtts[0].size === SPAN.length &&
          handAtts[0].mime === "image/png",
        `${handAtts[0]?.size} ${handAtts[0]?.mime}`
      );
      check(
        "…the good URL was remapped to the restored row",
        (handPage?.content ?? "").includes(`/api/attachments/${handAtts[0]?.id}`)
      );
      check(
        "…and the undecodable one was left pointing where it always pointed",
        (handPage?.content ?? "").includes("/api/attachments/hm-bad"),
        handPage?.content
      );
    }

    // ---- Authenticated encryption has to actually authenticate ------------
    // The streaming reader used to stop the instant it read the snapshot's
    // closing brace, leaving the decrypt generator suspended - so
    // setAuthTag/final(), the ONLY tag check on that path, never ran whenever
    // the reader's 1 MB fill happened to land on that brace. A forged tag was
    // accepted and a targeted ciphertext bit-flip (AES-GCM is CTR mode)
    // rewrote a restored page's title. The acceptance window is a function of
    // envelope size, so this sweeps sizes across the boundary rather than
    // testing one file; a single size proves nothing here.
    console.log("\nEncrypted restore authenticates before it writes anything");
    {
      const { writeFileSync, createReadStream } = await import("fs");
      const { encryptedChunks } = await import(
        pathToFileURL(path.join(root, "src/lib/backup.ts")).href
      );
      const PW = "authenticate me";
      const cryptoSnapshot = (pad) =>
        JSON.stringify({
          format: "keel-backup",
          version: 3,
          exportedAt: "2026-01-01T00:00:00.000Z",
          workspace: { name: "Crypto" },
          pages: [v1Page("crypt-page", { title: "Hello", content: docContent("y".repeat(pad)) })],
          databases: [],
          properties: [],
          records: [],
          values: [],
          views: [],
          attachments: [],
        });
      const envelope = async (json) => {
        const parts = [];
        async function* one() {
          yield json;
        }
        for await (const piece of encryptedChunks(one(), PW)) parts.push(piece);
        return JSON.parse(parts.join(""));
      };
      const rewrap = (env, data, tag) =>
        `{"format":"keel-backup-encrypted","version":2,"kdf":${JSON.stringify(env.kdf)},` +
        `"iv":${JSON.stringify(env.iv)},"data":"${data}","tag":${JSON.stringify(tag)}}`;
      const cryptoFile = path.join(BACKUP_DIR, "crypto-probe.keelbak");
      const readEnc = async (text) => {
        writeFileSync(cryptoFile, text);
        const read = await readBackupStream(createReadStream(cryptoFile), PW);
        await read.dispose();
        return read.snapshot;
      };

      // The verifier's acceptances clustered in ~32 KB windows about 1 MB
      // apart, so this range crosses one whole period.
      const forgedAccepted = [];
      const goodRejected = [];
      for (let pad = 1_040_000; pad <= 1_120_000; pad += 8192) {
        const env = await envelope(cryptoSnapshot(pad));
        try {
          await readEnc(rewrap(env, env.data, Buffer.alloc(16, 0xab).toString("base64")));
          forgedAccepted.push(pad);
        } catch {
          /* refused, which is the whole point */
        }
        try {
          const snap = await readEnc(rewrap(env, env.data, env.tag));
          if (snap.pages[0].title !== "Hello") goodRejected.push(`${pad}:${snap.pages[0].title}`);
        } catch (err) {
          goodRejected.push(`${pad}:${err?.message}`);
        }
      }
      check(
        "a forged GCM tag is refused at every envelope size across the fill boundary",
        forgedAccepted.length === 0,
        `accepted at pad=${forgedAccepted.join(",")}`
      );
      check(
        "…while every honest envelope at those same sizes still restores",
        goodRejected.length === 0,
        goodRejected.join(" | ")
      );

      // Tag left intact, one ciphertext byte flipped: CTR mode makes that a
      // targeted plaintext edit, so this is the tamper that matters.
      const flipPad = 1_048_192;
      const flipJson = cryptoSnapshot(flipPad);
      const flipEnv = await envelope(flipJson);
      const flipCt = Buffer.from(flipEnv.data, "base64");
      flipCt[flipJson.indexOf('"title":"Hello"') + 9] ^= 0x18; // 'H' -> 'P'
      let flipErr = "";
      let flipTitle = null;
      try {
        flipTitle = (await readEnc(rewrap(flipEnv, flipCt.toString("base64"), flipEnv.tag)))
          .pages[0].title;
      } catch (err) {
        flipErr = String(err?.message ?? err);
      }
      check(
        "a flipped ciphertext byte is refused, not restored as edited content",
        flipTitle === null && flipErr.includes("Wrong passphrase"),
        `title=${flipTitle} err=${flipErr}`
      );

      // And the guarantee that matters operationally: nothing lands.
      const tamperWs = await mkWs("Tampered restore target");
      let tamperErr = "";
      try {
        writeFileSync(cryptoFile, rewrap(flipEnv, flipCt.toString("base64"), flipEnv.tag));
        const read = await readBackupStream(createReadStream(cryptoFile), PW);
        await restoreSnapshot(read.snapshot, { workspaceId: tamperWs.id, userId: fUser.id });
        await read.dispose();
      } catch (err) {
        tamperErr = String(err?.message ?? err);
      }
      check(
        "…and no row is written when authentication fails",
        Boolean(tamperErr) && (await prisma.page.count({ where: { workspaceId: tamperWs.id } })) === 0,
        tamperErr
      );

      // scrypt cost parameters come out of the file. Unbounded, a 200-byte
      // upload pins a libuv thread for minutes.
      const kdfCases = [
        ["N far above anything Keel writes", { name: "scrypt", salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 1 << 21, r: 8, p: 1 }],
        ["p large enough to slip under Node's maxmem check", { name: "scrypt", salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 16384, r: 1, p: 4096 }],
        ["N not a power of two", { name: "scrypt", salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 16385, r: 8, p: 1 }],
        ["r of zero", { name: "scrypt", salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 16384, r: 0, p: 1 }],
      ];
      for (const [name, kdf] of kdfCases) {
        const started = performance.now();
        let kdfErr = "";
        try {
          await readEnc(
            `{"format":"keel-backup-encrypted","version":2,"kdf":${JSON.stringify(kdf)},` +
              `"iv":"AAAAAAAAAAAAAAAA","data":"AAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA=="}`
          );
        } catch (err) {
          kdfErr = String(err?.message ?? err);
        }
        const ms = Math.round(performance.now() - started);
        check(
          `an envelope asking for ${name} is refused without doing the work (${ms}ms)`,
          /scrypt parameters|key-derivation work/.test(kdfErr) && ms < 2000,
          kdfErr || "accepted"
        );
      }
    }

    // ---- The envelope cannot be stripped ----------------------------------
    // The tag check above is sound; this is the way around it. Whether a file
    // was treated as encrypted used to be decided by the FILE - its own
    // `format` header - and only one direction of that answer was checked. An
    // encrypted file with no passphrase was refused, but a PLAINTEXT file with
    // a passphrase was accepted and the passphrase silently dropped, which
    // skips the whole GCM path by construction. Backups are encrypted exactly
    // when the store is untrusted (a synced backup folder, a connected Drive),
    // so anyone who can write there could swap a .keelbak's bytes for a
    // plaintext snapshot of their own authorship: the padlock and the
    // passphrase prompt are filename tests, so the UI still showed both and
    // reported a clean encrypted restore of attacker-authored pages.
    console.log("\nA plaintext file cannot pose as an encrypted backup");
    {
      const { writeFileSync, mkdirSync, createReadStream } = await import("fs");
      const { encryptedChunks, backupFileStream } = await import(
        pathToFileURL(path.join(root, "src/lib/backup.ts")).href
      );
      const DPW = "correct horse";
      // Padded well past readBackupStream's 4096-character head buffer: below
      // it that loop drives the source to done on its own, which is also why a
      // small-file test would miss the descriptor leak checked further down.
      const plainJson = JSON.stringify({
        format: "keel-backup",
        version: 3,
        exportedAt: "2026-01-01T00:00:00.000Z",
        workspace: { name: "Downgrade" },
        pages: [
          v1Page("dg-page", { title: "ATTACKER PAGE", content: docContent("z".repeat(200_000)) }),
        ],
        databases: [],
        properties: [],
        records: [],
        values: [],
        views: [],
        attachments: [],
      });
      const seal = async (json, pw) => {
        const parts = [];
        async function* one() {
          yield json;
        }
        for await (const piece of encryptedChunks(one(), pw)) parts.push(piece);
        return parts.join("");
      };
      const sealed = await seal(plainJson, DPW);

      const dgDir = path.join(BACKUP_DIR, "downgrade");
      mkdirSync(dgDir, { recursive: true });
      const strippedFile = path.join(dgDir, "stripped.keelbak");
      writeFileSync(strippedFile, plainJson);

      const readErr = async (fn) => {
        try {
          const read = await fn();
          await read.dispose?.();
          return "";
        } catch (err) {
          return String(err?.message ?? err) || "threw";
        }
      };

      const streamErr = await readErr(() =>
        readBackupStream(createReadStream(strippedFile), DPW)
      );
      check(
        "a plaintext file offered with a passphrase is refused by the streaming reader",
        streamErr.includes("not encrypted"),
        streamErr || "ACCEPTED - the passphrase was silently ignored"
      );
      let parseErr = "";
      try {
        await parseBackup(plainJson, DPW);
      } catch (err) {
        parseErr = String(err?.message ?? err);
      }
      check(
        "…and by the buffered compatibility reader",
        parseErr.includes("not encrypted"),
        parseErr || "ACCEPTED - the passphrase was silently ignored"
      );
      check(
        "…saying the file was not authenticated, not that the passphrase was wrong",
        !/passphrase is required|Wrong passphrase/.test(streamErr + parseErr),
        `${streamErr} | ${parseErr}`
      );

      // The other half: the filename claim the UI makes is now re-derived from
      // the bytes. A backup file opened by name carries what its extension
      // says, so a swapped .keelbak is refused even when no passphrase was
      // typed at all - which is the state an API client, or a cancelled
      // prompt, leaves the server in.
      const dgWs = await mkWs("Downgrade by name");
      const dgWsDir = path.join(BACKUP_DIR, dgWs.id);
      mkdirSync(dgWsDir, { recursive: true });
      const encName = `keel-${dgWs.id.slice(0, 12)}-2026-01-01T00-00-00.keelbak`;
      const plainName = `keel-${dgWs.id.slice(0, 12)}-2026-01-02T00-00-00.json`;
      writeFileSync(path.join(dgWsDir, encName), plainJson); // bytes swapped
      writeFileSync(path.join(dgWsDir, plainName), plainJson); // honest .json
      const wsRef = { id: dgWs.id, backupDir: null };
      const byNameErr = await readErr(() =>
        readBackupStream(backupFileStream(wsRef, encName))
      );
      check(
        "a .keelbak whose bytes were swapped for plaintext is refused with no passphrase at all",
        byNameErr.includes("not encrypted"),
        byNameErr || "ACCEPTED - the padlock in the UI meant nothing"
      );
      const honestErr = await readErr(() =>
        readBackupStream(backupFileStream(wsRef, plainName))
      );
      check(
        "…while an honest .json backup with no passphrase still reads",
        honestErr === "",
        honestErr
      );

      // And the whole point of refusing: a genuine encrypted file is unchanged
      // by any of this, through both readers.
      writeFileSync(path.join(dgWsDir, encName), sealed);
      let goodTitle = null;
      let goodErr = "";
      try {
        const read = await readBackupStream(backupFileStream(wsRef, encName), DPW);
        goodTitle = read.snapshot.pages[0]?.title;
        await read.dispose();
      } catch (err) {
        goodErr = String(err?.message ?? err);
      }
      check(
        "a genuine encrypted backup still restores through the streaming reader",
        goodTitle === "ATTACKER PAGE",
        goodErr || `title=${goodTitle}`
      );
      let goodParsed = null;
      try {
        goodParsed = (await parseBackup(sealed, DPW)).pages[0]?.title;
      } catch (err) {
        goodParsed = String(err?.message ?? err);
      }
      check(
        "…and through the buffered one",
        goodParsed === "ATTACKER PAGE",
        String(goodParsed)
      );

      // A mangled KDF salt is an envelope problem. It used to be reported as
      // "Wrong passphrase" on the streaming path (readBackupStream rewrites
      // anything that is not an EnvelopeError) and as a raw Node TypeError on
      // the buffered one, because Buffer.from(salt) ran - arguments evaluate
      // left to right - before the only check on that field.
      const envObj = JSON.parse(sealed);
      for (const [name, salt] of [
        ["a non-string", 5],
        ["a missing", undefined],
      ]) {
        const broken = { ...envObj, kdf: { ...envObj.kdf } };
        if (salt === undefined) delete broken.kdf.salt;
        else broken.kdf.salt = salt;
        const brokenText = JSON.stringify(broken);
        const brokenFile = path.join(dgDir, "bad-salt.keelbak");
        writeFileSync(brokenFile, brokenText);
        let sErr = "";
        try {
          const read = await readBackupStream(createReadStream(brokenFile), DPW);
          await read.dispose();
        } catch (err) {
          sErr = String(err?.message ?? err);
        }
        let bErr = "";
        try {
          await parseBackup(brokenText, DPW);
        } catch (err) {
          bErr = `${err?.name}: ${err?.message}`;
        }
        check(
          `${name} scrypt salt is reported as a malformed header by the streaming reader`,
          sErr.includes("the encrypted header is malformed"),
          sErr || "accepted"
        );
        check(
          "…and by the buffered reader, as an envelope error rather than a TypeError",
          bErr.includes("the encrypted header is malformed") && !bErr.includes("TypeError"),
          bErr || "accepted"
        );
      }
    }

    // ---- Successful encrypted reads must not leak the source either -------
    // decryptStream stops pulling the instant the trailer's closing brace is
    // in hand, so `rejoined()` - and the fs read stream behind it - is left
    // suspended one next() short of done. Only the failure path closed the
    // source, so every SUCCESSFUL encrypted restore leaked a descriptor for
    // the life of the process; on the import route that descriptor pins the
    // multi-gigabyte upload spool the route has already unlinked.
    console.log("\nSuccessful encrypted reads do not leak descriptors or spools");
    {
      const { writeFileSync, createReadStream, readdirSync } = await import("fs");
      const os = await import("os");
      const { encryptedChunks } = await import(
        pathToFileURL(path.join(root, "src/lib/backup.ts")).href
      );
      const LPW = "close the door";
      // Carries an attachment so the spool directory is genuinely used, and is
      // comfortably over the 4096-character head buffer.
      const leakJson = JSON.stringify(attachmentSnapshot(TWO_MB));
      const parts = [];
      async function* one() {
        yield leakJson;
      }
      for await (const piece of encryptedChunks(one(), LPW)) parts.push(piece);
      const encLeakFile = path.join(BACKUP_DIR, "leak-success.keelbak");
      writeFileSync(encLeakFile, parts.join(""));

      const readOnce = async () => {
        const read = await readBackupStream(createReadStream(encLeakFile), LPW);
        const title = read.snapshot.pages[0]?.title;
        await read.dispose();
        return title;
      };
      const fdCount = () => {
        try {
          return readdirSync("/dev/fd").length;
        } catch {
          return -1;
        }
      };
      const spoolCount = () =>
        readdirSync(os.tmpdir()).filter((n) => n.startsWith("keel-restore-")).length;

      for (let i = 0; i < 5; i++) await readOnce(); // warm up
      const fdBefore = fdCount();
      const spoolBefore = spoolCount();
      let titles = 0;
      for (let i = 0; i < 40; i++) if ((await readOnce()) === "Limit page") titles++;
      const fdAfter = fdCount();
      const spoolAfter = spoolCount();
      check("40 successful encrypted reads all returned their snapshot", titles === 40, `${titles}`);
      check(
        `descriptor count is flat across them (${fdBefore} -> ${fdAfter})`,
        fdBefore < 0 || fdAfter - fdBefore <= 3,
        `${fdBefore} -> ${fdAfter}`
      );
      check(
        `…and every spool directory was removed (${spoolBefore} -> ${spoolAfter})`,
        spoolAfter <= spoolBefore,
        `${spoolBefore} -> ${spoolAfter}`
      );
    }

    // ---- The two readers have to accept the same files --------------------
    // The streaming scanner bounds a row's RAW JSON TEXT while it is still
    // looking for that row's end; applyFileLimits bounds the DECODED content
    // string. Both used MAX_RESTORED_CONTENT, which is not agreement but the
    // opposite: a page's content is itself JSON, so every quote in it is
    // escaped again inside the pages row. A ~30 MiB page - which the OneNote
    // mirror can write, having no content cap - restored through cloud restore
    // and was refused by import and on-disk restore.
    console.log("\nBoth readers accept the same files");
    {
      const { writeFileSync, createReadStream } = await import("fs");
      const { MAX_RESTORED_ROW } = await import(
        pathToFileURL(path.join(root, "src/lib/limits.ts")).href
      );
      // Quote-heavy text: each `"` is `\"` in the content string and `\\\"`
      // inside the row, so the row is about twice the content - the same
      // inflation a real document has, only deterministic.
      const shell = docContent("").length;
      const bigDoc = docContent('"'.repeat(Math.floor((MAX_RESTORED_CONTENT - 2 * 1024 * 1024 - shell) / 2)));
      const bigRow = v1Page("agree-page", { title: "Wide page", content: bigDoc });
      const rowText = JSON.stringify(bigRow);
      check(
        `a page inside MAX_RESTORED_CONTENT can still exceed it as a row (${Math.round(bigDoc.length / 1048576)} MB content, ${Math.round(rowText.length / 1048576)} MB row)`,
        bigDoc.length <= MAX_RESTORED_CONTENT && rowText.length > MAX_RESTORED_CONTENT,
        `${bigDoc.length} / ${rowText.length}`
      );
      const agreeText = JSON.stringify({
        format: "keel-backup",
        version: 3,
        exportedAt: "2026-01-01T00:00:00.000Z",
        workspace: { name: "Agree" },
        pages: [bigRow],
        databases: [],
        properties: [],
        records: [],
        values: [],
        views: [],
        attachments: [],
      });
      const agreeFile = path.join(BACKUP_DIR, "wide-row.json");
      writeFileSync(agreeFile, agreeText);
      let streamLen = null;
      let streamErr = "";
      try {
        const read = await readBackupStream(createReadStream(agreeFile));
        streamLen = read.snapshot.pages[0]?.content?.length;
        await read.dispose();
      } catch (err) {
        streamErr = String(err?.message ?? err);
      }
      let bufferLen = null;
      let bufferErr = "";
      try {
        bufferLen = (await parseBackup(agreeText)).pages[0]?.content?.length;
      } catch (err) {
        bufferErr = String(err?.message ?? err);
      }
      check(
        "the streaming reader accepts it",
        streamLen === bigDoc.length,
        streamErr || `${streamLen}`
      );
      check(
        "…and so does the buffered one, on the very same bytes",
        bufferLen === bigDoc.length,
        bufferErr || `${bufferLen}`
      );

      // The scanner still holds a memory line, far above anything Keel writes:
      // a row is buffered whole, so "accept whatever the file names" is not an
      // option. Streamed, so the test does not itself hold the row.
      let served = 0;
      async function* wideRowStream() {
        const head =
          '{"format":"keel-backup","version":3,"exportedAt":"2020-01-01T00:00:00.000Z",' +
          '"workspace":{"name":"x"},"pages":[{"id":"p","parentPageId":null,"type":"document",' +
          '"title":"';
        served += head.length;
        yield head;
        const mb = "T".repeat(1024 * 1024);
        for (let i = 0; i < 4096; i++) {
          served += mb.length;
          yield mb;
        }
        yield '","icon":null,"content":null,"sortOrder":1,"archivedAt":null}],"databases":[],' +
          '"properties":[],"records":[],"values":[]}';
      }
      let wideErr = "";
      try {
        const read = await readBackupStream(wideRowStream());
        await read.dispose();
      } catch (err) {
        wideErr = String(err?.message ?? err);
      }
      check(
        "a row past MAX_RESTORED_ROW is still refused, as the scanner's memory bound",
        wideErr.includes("a pages row is larger than this build can read"),
        wideErr || "accepted"
      );
      check(
        `…having read only what it needed (${Math.round(served / 1048576)} MB, bound ${Math.round(MAX_RESTORED_ROW / 1048576)} MB)`,
        served < MAX_RESTORED_ROW + 8 * 1024 * 1024,
        `${served}`
      );
    }

    // ---- Attachments whose page did not restore have to be counted --------
    // RestoreReport documents `empty` as "bytes that wouldn't decode, or a row
    // whose page wasn't restored", but the second case was a silent continue -
    // so Settings reported a clean restore and the audit row said
    // skippedEmpty: 0 while images were dropped.
    console.log("\nAn attachment with no restored page is reported, not just dropped");
    {
      const orphanWs = await mkWs("Orphaned attachment rows");
      const orphanReport = await restoreSnapshot(
        attachmentSnapshot(TWO_MB, { pages: [v1Page("some-other-page")] }),
        { workspaceId: orphanWs.id, userId: fUser.id }
      );
      check(
        "an attachment whose page is not in the restore is counted as skipped",
        orphanReport.skippedAttachments?.empty === 1,
        JSON.stringify(orphanReport.skippedAttachments)
      );
      check(
        "…and no attachment row was written",
        (await prisma.attachment.count({ where: { workspaceId: orphanWs.id } })) === 0
      );
    }

    // ---- A failed read must not leak the spool's file descriptor ----------
    // Every throw between spool.open() and spool.close() used to unwind past
    // the only close(), and dispose() unlinks the file without closing the
    // handle. On Node >= 24 the GC then turns that into a fatal
    // ERR_INVALID_STATE; below it, one leaked fd per failed import until
    // EMFILE. The failure is an ordinary one - a truncated or corrupt backup
    // is the case backups exist for.
    console.log("\nFailed imports do not leak file descriptors");
    {
      const { writeFileSync, createReadStream, readdirSync } = await import("fs");
      const leakFile = path.join(BACKUP_DIR, "leaky.json");
      // A backslash inside an attachment's `data`: throws mid-row, spool open.
      writeFileSync(
        leakFile,
        '{"format":"keel-backup","version":3,"exportedAt":"2020-01-01T00:00:00.000Z",' +
          '"workspace":{"name":"x"},"pages":[],"databases":[],"properties":[],"records":[],' +
          '"values":[],"attachments":[{"id":"a","pageId":"p","name":"n","mime":"image/png",' +
          '"size":1,"data":"AAAA\\\\AAAA"}]}'
      );
      const attempt = async () => {
        try {
          const read = await readBackupStream(createReadStream(leakFile));
          await read.dispose();
          return "";
        } catch (err) {
          return String(err?.message ?? err);
        }
      };
      const firstErr = await attempt();
      check(
        "a malformed attachment `data` is reported as a bad file",
        firstErr.includes("not plain base64"),
        firstErr
      );
      const fdCount = () => {
        try {
          return readdirSync("/dev/fd").length;
        } catch {
          return -1;
        }
      };
      for (let i = 0; i < 5; i++) await attempt(); // warm up
      const fdBefore = fdCount();
      for (let i = 0; i < 60; i++) await attempt();
      const fdAfter = fdCount();
      check(
        `descriptor count is flat across 60 failed imports (${fdBefore} -> ${fdAfter})`,
        fdBefore < 0 || fdAfter - fdBefore <= 3,
        `${fdBefore} -> ${fdAfter}`
      );
    }

    // ---- Row caps have to bite while the file is still arriving -----------
    // They used to run in assertSnapshotShape, on the finished object, so the
    // file they existed to refuse was already in the heap by the time they
    // refused it. This proves the reader stops early by counting the bytes it
    // was actually asked for.
    console.log("\nRow caps are enforced as rows stream in");
    {
      const CAP = 50_000; // databases
      const row = '{"id":"d0000000000000000000000","pageId":"p0000000000000000000000"}';
      let served = 0;
      async function* rowsStream() {
        const head =
          '{"format":"keel-backup","version":3,"exportedAt":"2020-01-01T00:00:00.000Z",' +
          '"workspace":{"name":"x"},"pages":[],"databases":[';
        served += head.length;
        yield head;
        for (let i = 0; i < CAP + 200_000; i++) {
          const piece = (i ? "," : "") + row;
          served += piece.length;
          yield piece;
        }
        const tail = '],"properties":[],"records":[],"values":[]}';
        served += tail.length;
        yield tail;
      }
      const whole = (CAP + 200_000) * (row.length + 1);
      let capErr = "";
      try {
        const read = await readBackupStream(rowsStream());
        await read.dispose();
      } catch (err) {
        capErr = String(err?.message ?? err);
      }
      check(
        "a section past its row cap is refused",
        capErr.includes("the databases section is implausibly large"),
        capErr || "accepted"
      );
      check(
        `…having read only what it needed (${Math.round(served / 1048576)} MB of ${Math.round(whole / 1048576)} MB)`,
        served < CAP * (row.length + 1) + 4 * 1024 * 1024,
        `${served} of ${whole}`
      );
    }

    // ---- Attachment volume: the ceiling that used to end backups ----------
    // Snapshot v3 base64s attachment bytes into the JSON, and the old writer
    // built that JSON with one JSON.stringify - which V8 refuses past
    // 536,870,888 characters. So a workspace holding more than ~400 MB of
    // attachments (a fifth of the default 2048 MB quota) could not be backed
    // up or exported at all, and an encrypted backup died at ~300 MB.
    //
    // KEEL_BIG_BACKUP_MB raises the volume; the default is small enough for
    // the everyday suite while still exercising multi-chunk streaming on both
    // the write and read sides.
    const bigMb = Number(process.env.KEEL_BIG_BACKUP_MB || 64);
    const CHUNK_MB = 32;
    console.log(`\nAttachment volume round trip (${bigMb} MB, KEEL_BIG_BACKUP_MB to raise)`);
    {
      // One buffer, reused for every filler row: the test must not itself hold
      // the volume it is testing.
      const filler = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(CHUNK_MB * 1024 * 1024, 0xa5),
      ]);
      const fillerHash = createHash("sha256").update(filler).digest("hex");
      const sentinel = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        randomBytes(1024 * 1024),
      ]);
      const sentinelHash = createHash("sha256").update(sentinel).digest("hex");
      const VOL_TITLE = "VOLUME-" + randomBytes(4).toString("hex");
      const volPage = await prisma.page.create({
        data: {
          workspaceId: workspace.id,
          type: "document",
          title: VOL_TITLE,
          createdById: fUser.id,
          sortOrder: 500,
        },
      });
      const rows = Math.max(1, Math.ceil(bigMb / CHUNK_MB));
      for (let i = 0; i < rows; i++) {
        await prisma.attachment.create({
          data: {
            workspaceId: workspace.id,
            pageId: volPage.id,
            name: `filler-${i}.png`,
            mime: "image/png",
            size: filler.length,
            sha256: fillerHash,
            data: filler,
            createdById: fUser.id,
          },
        });
      }
      const sentinelRow = await prisma.attachment.create({
        data: {
          workspaceId: workspace.id,
          pageId: volPage.id,
          name: "sentinel.png",
          mime: "image/png",
          size: sentinel.length,
          sha256: sentinelHash,
          data: sentinel,
          createdById: fUser.id,
        },
      });
      await prisma.page.update({
        where: { id: volPage.id },
        data: { content: docContent(`plate /api/attachments/${sentinelRow.id}`) },
      });
      const totalBytes = rows * filler.length + sentinel.length;
      check(
        `seeded ${Math.round(totalBytes / 1048576)} MB of attachments across ${rows + 1} rows`,
        true
      );

      // Export over HTTP, drained without ever holding the body.
      const exportStart = performance.now();
      res = await req("POST", "/api/workspace/export", {});
      let exported = 0;
      if (res.body) for await (const piece of res.body) exported += piece.length;
      const exportMs = Math.round(performance.now() - exportStart);
      check(
        `export streams ${Math.round(exported / 1048576)} MB in ${exportMs}ms without a RangeError`,
        res.status === 200 && exported > (totalBytes * 4) / 3,
        `${res.status} ${exported} bytes`
      );

      // Plain backup to disk, then restore it.
      const backupStart = performance.now();
      res = await req("POST", "/api/workspace/backups", {});
      data = await res.json().catch(() => ({}));
      const backupMs = Math.round(performance.now() - backupStart);
      check(
        `a ${Math.round(totalBytes / 1048576)} MB-attachment workspace backs up in ${backupMs}ms`,
        res.status === 200 && typeof data.file === "string",
        `${res.status} ${JSON.stringify(data).slice(0, 200)}`
      );
      const volBackup = path.basename(String(data.file));
      const volSize = existsSync(String(data.file)) ? statSync(String(data.file)).size : 0;
      check(
        "…to a file larger than a JS string can be, if it is a big enough workspace",
        volSize > (totalBytes * 4) / 3,
        `${volSize} bytes`
      );

      const before = await prisma.attachment.count({ where: { workspaceId: workspace.id } });
      res = await req("POST", "/api/workspace/backups/restore", { filename: volBackup });
      data = await res.json().catch(() => ({}));
      check(
        "…and restores",
        res.status === 200 && data.restored > 0,
        `${res.status} ${JSON.stringify(data).slice(0, 200)}`
      );
      const after = await prisma.attachment.count({ where: { workspaceId: workspace.id } });
      check(
        "…creating a fresh row for every attachment it carried",
        after === before * 2,
        `${before} -> ${after}`
      );
      const restoredSentinels = await prisma.attachment.findMany({
        where: { workspaceId: workspace.id, name: "sentinel.png", id: { not: sentinelRow.id } },
        select: { id: true, data: true, size: true, pageId: true },
      });
      check("…including the sentinel", restoredSentinels.length === 1, `${restoredSentinels.length}`);
      const restoredSentinel = restoredSentinels[0];
      check(
        "…byte-identical after the whole round trip",
        Boolean(restoredSentinel) &&
          restoredSentinel.size === sentinel.length &&
          createHash("sha256").update(Buffer.from(restoredSentinel.data)).digest("hex") ===
            sentinelHash
      );
      const restoredVolPage = restoredSentinel
        ? await prisma.page.findUnique({ where: { id: restoredSentinel.pageId } })
        : null;
      check(
        "…and the restored page's image URL points at the restored row",
        (restoredVolPage?.content ?? "").includes(`/api/attachments/${restoredSentinel?.id}`),
        restoredVolPage?.content
      );

      // The encrypted path hit the ceiling even earlier (the envelope base64s
      // the ciphertext), so it gets the same trip.
      const encStart = performance.now();
      res = await req("POST", "/api/workspace/backups", {
        encrypt: true,
        passphrase: "streams all the way down",
      });
      data = await res.json().catch(() => ({}));
      const encMs = Math.round(performance.now() - encStart);
      check(
        `the same workspace encrypts to a .keelbak in ${encMs}ms`,
        res.status === 200 && String(data.file).endsWith(".keelbak"),
        `${res.status} ${JSON.stringify(data).slice(0, 200)}`
      );
      const encVolBackup = path.basename(String(data.file));
      const encBefore = await prisma.attachment.count({ where: { workspaceId: workspace.id } });
      res = await req("POST", "/api/workspace/backups/restore", {
        filename: encVolBackup,
        passphrase: "streams all the way down",
      });
      data = await res.json().catch(() => ({}));
      check(
        "…and decrypts and restores",
        res.status === 200 && data.restored > 0,
        `${res.status} ${JSON.stringify(data).slice(0, 200)}`
      );
      const encAfter = await prisma.attachment.count({ where: { workspaceId: workspace.id } });
      check(
        "…with every attachment row again",
        encAfter === encBefore * 2,
        `${encBefore} -> ${encAfter}`
      );
      const encSentinels = await prisma.attachment.findMany({
        where: {
          workspaceId: workspace.id,
          name: "sentinel.png",
          id: { notIn: [sentinelRow.id, restoredSentinel?.id ?? ""] },
        },
        select: { data: true },
      });
      check(
        "…byte-identical through the cipher too",
        encSentinels.length === 2 &&
          encSentinels.every(
            (a) => createHash("sha256").update(Buffer.from(a.data)).digest("hex") === sentinelHash
          ),
        `${encSentinels.length} candidates`
      );

    }

    await prisma.$disconnect();
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    cleanup();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
