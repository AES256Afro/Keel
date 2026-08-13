#!/usr/bin/env node
// Templates: do they produce what they promise?
//
// A template that silently drops its views or its hierarchy still "works" -
// you get a database, just a flat one in a table view - so nothing fails and
// nobody notices. That is exactly how the mind map view ended up shipping with
// no template that opened in it. These assert the promised shape.
//
//   node --experimental-strip-types --no-warnings scripts/templates-check.mjs
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { register } from "node:module";
import { cleanDatabase, prepareDatabase, testDatabaseUrl } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "templates-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);

cleanDatabase(root, DB_NAME);
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);
process.env.DATABASE_URL = DB_URL;
register("./ts-loader.mjs", import.meta.url);

const { TEMPLATES, createFromTemplate } = await import(
  pathToFileURL(path.join(root, "src/lib/templates.ts")).href
);
const { prisma } = await import(pathToFileURL(path.join(root, "src/lib/prisma.ts")).href);
const { getDatabaseDTO } = await import(pathToFileURL(path.join(root, "src/lib/pages.ts")).href);

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

try {
  const user = await prisma.user.create({
    data: { email: "t@example.test", name: "T", username: "t", passwordHash: "x" },
  });
  const ws = await prisma.workspace.create({
    data: { name: "T", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });

  // A page that predates every template: template pages must append AFTER it,
  // the way all other creation paths do - not pin to the top at sortOrder 0.
  const seed = await prisma.page.create({
    data: {
      workspaceId: ws.id,
      type: "document",
      title: "Existing page",
      content: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      plainText: "",
      sortOrder: 1,
      createdById: user.id,
      editedById: user.id,
    },
  });

  console.log("\nEvery template applies cleanly\n");
  const applied = new Map();
  for (const t of TEMPLATES) {
    const res = await createFromTemplate(t.key, { workspaceId: ws.id, userId: user.id });
    applied.set(t.key, res.pageId);
    check(`${t.name} applies`, Boolean(res?.pageId));
  }

  console.log("\nTemplate pages append to the sidebar, not pin to the top\n");
  {
    const pages = await prisma.page.findMany({
      where: { id: { in: [...applied.values()] } },
      select: { id: true, sortOrder: true },
    });
    const orderById = new Map(pages.map((p) => [p.id, p.sortOrder]));
    const orders = TEMPLATES.map((t) => orderById.get(applied.get(t.key)));
    check(
      "every template page lands after the page that was already there",
      orders.every((o) => o > seed.sortOrder),
      `sortOrders ${orders.join(", ")} vs existing ${seed.sortOrder}`
    );
    check(
      "templates applied in sequence keep their application order",
      orders.every((o, i) => i === 0 || o > orders[i - 1])
    );
  }

  console.log("\nDeclared views and hierarchy actually land\n");
  for (const t of TEMPLATES) {
    if (!t.views?.length && !t.records?.some((r) => r.parent)) continue;
    const page = await prisma.page.findUnique({
      where: { id: applied.get(t.key) },
      include: {
        database: {
          include: { views: { orderBy: { sortOrder: "asc" } }, records: true, properties: true },
        },
      },
    });
    const db = page?.database;

    if (t.views?.length) {
      check(
        `${t.name}: all ${t.views.length} declared views exist`,
        db?.views.length === t.views.length,
        `${db?.views.length ?? 0} created`
      );
      // The first view is what opens - a template that declares a mind map but
      // opens in a table has not delivered what it promised.
      check(
        `${t.name}: opens in "${t.views[0].name}" (${t.views[0].type})`,
        db?.views[0]?.type === t.views[0].type && db?.views[0]?.name === t.views[0].name,
        `got ${db?.views[0]?.type}`
      );
      // A declared group-by must land as the created property's ID - a name,
      // or nothing, means the board only groups right by fallback luck.
      for (const declared of t.views) {
        if (!declared.config?.groupBy) continue;
        const created = db?.views.find((v) => v.name === declared.name);
        const config = created?.config ? JSON.parse(created.config) : {};
        const target = db?.properties.find((p) => p.name === declared.config.groupBy);
        check(
          `${t.name}: "${declared.name}" groups by ${declared.config.groupBy}'s property id`,
          Boolean(target) && config.groupByPropertyId === target?.id,
          `stored ${JSON.stringify(config.groupByPropertyId)}`
        );
      }
    }

    const wantParents = (t.records ?? []).filter((r) => r.parent).length;
    if (wantParents) {
      const withParent = (db?.records ?? []).filter((r) => r.parentRecordId).length;
      check(
        `${t.name}: ${wantParents} records are parented (real hierarchy, not a flat list)`,
        withParent === wantParents,
        `${withParent} parented`
      );
    }
  }

  console.log("\nThe mind map template specifically\n");
  {
    const page = await prisma.page.findUnique({
      where: { id: applied.get("mind-map") },
      include: { database: { include: { views: { orderBy: { sortOrder: "asc" } }, records: true } } },
    });
    const db = page.database;
    check("it exists and is a database", Boolean(db));
    check("it opens in the mind map view", db.views[0].type === "mindmap", db.views[0]?.type);
    check("it also offers a board and a table over the same rows",
      db.views.some((v) => v.type === "board") && db.views.some((v) => v.type === "table"));

    const roots = db.records.filter((r) => !r.parentRecordId);
    check("exactly one root node (the centre of the map)", roots.length === 1, `${roots.length} roots`);
    // A map whose branches are all one deep is a list with extra steps.
    const byId = new Map(db.records.map((r) => [r.id, r]));
    const depthOf = (r) => {
      let d = 0;
      let cur = r;
      while (cur?.parentRecordId && d < 20) {
        cur = byId.get(cur.parentRecordId);
        d++;
      }
      return d;
    };
    const maxDepth = Math.max(...db.records.map(depthOf));
    check("the map is more than one level deep", maxDepth >= 2, `depth ${maxDepth}`);
    check("no record is its own ancestor", db.records.every((r) => depthOf(r) < 20));
  }

  console.log("\nA poisoned settings row degrades instead of crashing the database page\n");
  {
    // The write path now rejects these, but a row poisoned before that gate
    // (or edited by hand) must still RENDER: settings.options that isn't an
    // array of {id, name} objects degrades on read, it doesn't throw.
    const page = await prisma.page.findUnique({
      where: { id: applied.get("bug-tracker") },
      include: { database: { include: { properties: true } } },
    });
    const db = page.database;
    const status = db.properties.find((p) => p.name === "Status");
    await prisma.databaseProperty.update({
      where: { id: status.id },
      data: { settings: JSON.stringify({ options: 42 }) },
    });
    const severity = db.properties.find((p) => p.name === "Severity");
    await prisma.databaseProperty.update({
      where: { id: severity.id },
      data: {
        settings: JSON.stringify({
          options: [{ id: "ok", name: "OK", color: "green" }, "boom", { id: 7 }, null],
        }),
      },
    });

    let dto = null;
    let threw = null;
    try {
      dto = await getDatabaseDTO(db.id);
    } catch (err) {
      threw = err;
    }
    check("getDatabaseDTO still returns the database", Boolean(dto) && !threw, threw?.message ?? "");
    const dtoStatus = dto?.properties.find((p) => p.name === "Status");
    check(
      "non-array options degrade to an empty list",
      Array.isArray(dtoStatus?.settings.options) && dtoStatus.settings.options.length === 0,
      JSON.stringify(dtoStatus?.settings.options)
    );
    const dtoSeverity = dto?.properties.find((p) => p.name === "Severity");
    check(
      "junk entries are dropped, real options survive",
      Array.isArray(dtoSeverity?.settings.options) &&
        dtoSeverity.settings.options.length === 1 &&
        dtoSeverity.settings.options[0].id === "ok",
      JSON.stringify(dtoSeverity?.settings.options)
    );
  }

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
