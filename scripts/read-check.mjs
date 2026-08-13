#!/usr/bin/env node
// Sequence reading: /read/<id> renders a page and its subtree as one scroll.
//
// The rendering path is new attack surface: stored document JSON is request
// data (any signed-in client can PATCH it), and this is the first place it is
// rendered outside the editor. The unit half hammers the sanitizers; the HTTP
// half proves order, scoping and that hostile hrefs never reach the response
// as links.
//
//   npm run build && node scripts/read-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "read-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.READ_PORT || 3202);
const BASE = `http://127.0.0.1:${PORT}`;

register("./ts-loader.mjs", import.meta.url);
const { safeHref, safeImageSrc, parseDoc } = await import(
  pathToFileURL(path.join(root, "src/lib/richtext.ts")).href
);

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

console.log("\nSanitizers\n");

check("https passes", safeHref("https://example.com/a?b=c") === "https://example.com/a?b=c");
check("http passes", safeHref("http://example.com") === "http://example.com");
check("mailto passes", safeHref("mailto:a@b.c") === "mailto:a@b.c");
check("app-relative passes", safeHref("/p/abc") === "/p/abc");
check("fragment passes", safeHref("#s-1") === "#s-1");
check("bare host passes as relative", safeHref("example.com/x") === "example.com/x");
check("javascript: dies", safeHref("javascript:alert(1)") === null);
check("JavaScript: dies regardless of case", safeHref("JaVaScRiPt:alert(1)") === null);
check("javascript with whitespace dies", safeHref("  javascript:alert(1)") === null);
check("vbscript: dies", safeHref("vbscript:x") === null);
check("data: dies", safeHref("data:text/html,<script>1</script>") === null);
check("blob: dies", safeHref("blob:https://x/y") === null);
check("file: dies", safeHref("file:///etc/passwd") === null);
check("empty is null", safeHref("") === null);
check("non-strings are null", safeHref(42) === null && safeHref(null) === null);
check("absurdly long urls are null", safeHref("https://x/" + "a".repeat(3000)) === null);

check("attachment src passes", safeImageSrc("/api/attachments/cm123abc") === "/api/attachments/cm123abc");
check("external img src dies", safeImageSrc("https://evil.test/x.png") === null);
check("data: img src dies", safeImageSrc("data:image/png;base64,AAAA") === null);
check("traversal img src dies", safeImageSrc("/api/attachments/../../secret") === null);

check("valid doc parses", parseDoc('{"type":"doc","content":[]}') !== null);
check("garbage returns null, not a throw", parseDoc("{nope") === null);
check("null returns null", parseDoc(null) === null);
check("a non-doc object returns null", parseDoc('"str"') === null);

/* ---------------- The route ---------------- */

const doc = (blocks) => JSON.stringify({ type: "doc", content: blocks });
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });

cleanDatabase(root, DB_NAME);
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "r@example.test", name: "R", username: "r", passwordHash: "x" },
});
const ws = await prisma.workspace.create({
  data: { name: "R", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

const mk = (title, content, parentPageId = null, extra = {}) =>
  prisma.page.create({
    data: {
      workspaceId: ws.id,
      type: "document",
      title,
      content,
      plainText: "",
      createdById: user.id,
      parentPageId,
      sortOrder: extra.sortOrder ?? 0,
      ...extra,
    },
  });

const book = await mk("The Plan", doc([para("PROLOGUE-TEXT")]));
const ch1 = await mk("Chapter One", doc([para("CH1-TEXT")]), book.id, { sortOrder: 1 });
const ch2 = await mk(
  "Chapter Two",
  doc([
    para("CH2-TEXT"),
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "CLICK-ME",
          marks: [{ type: "link", attrs: { href: "javascript:alert(document.cookie)" } }],
        },
      ],
    },
  ]),
  book.id,
  { sortOrder: 2 }
);
const nested = await mk("A section of chapter one", doc([para("NESTED-TEXT")]), ch1.id, { sortOrder: 1 });
await mk("Archived draft", doc([para("ARCHIVED-TEXT")]), book.id, {
  sortOrder: 3,
  archivedAt: new Date(),
});
// A database under the book: working surface, not prose - must not appear.
const dbPage = await prisma.page.create({
  data: {
    workspaceId: ws.id,
    type: "database",
    title: "Tasks under book",
    content: "{}",
    plainText: "",
    createdById: user.id,
    parentPageId: book.id,
    sortOrder: 4,
  },
});
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
  stdio: "ignore",
  shell: process.platform === "win32",
});

async function waitFor(url, tries = 160) {
  while (tries-- > 0) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  console.log("\nThe reading view\n");

  const res = await fetch(`${BASE}/read/${book.id}`, {
    headers: { cookie: `keel_session=${token}` },
  });
  const html = await res.text();
  check("the view renders", res.status === 200, `status ${res.status}`);
  check("the root page's body is there", html.includes("PROLOGUE-TEXT"));
  check("children follow", html.includes("CH1-TEXT") && html.includes("CH2-TEXT"));
  check("grandchildren are stitched under their parent", html.includes("NESTED-TEXT"));
  check(
    "depth-first: the nested section reads before chapter two",
    html.indexOf("NESTED-TEXT") < html.indexOf("CH2-TEXT"),
    "order wrong"
  );
  check("archived pages are left out", !html.includes("ARCHIVED-TEXT"));
  // The sidebar legitimately lists every page, so scope the assertion to the
  // reading sections themselves.
  check("databases are not read as sections", !html.includes(`data-read-section="${dbPage.id}"`));
  check("the document sections all are", [book, ch1, ch2, nested].every((p) => html.includes(`data-read-section="${p.id}"`)));

  check(
    "the hostile link's text survives",
    html.includes("CLICK-ME")
  );
  check(
    "but javascript: appears nowhere in the response",
    !html.toLowerCase().includes("javascript:alert"),
    "the href got through"
  );

  const anon = await fetch(`${BASE}/read/${book.id}`, { redirect: "manual" });
  check("signed out is redirected away", anon.status === 307, `status ${anon.status}`);

  const outsiderToken = randomBytes(32).toString("hex");
  const db = await testPrisma(root, DB_URL);
  const outsider = await db.user.create({
    data: { email: "o@example.test", name: "O", username: "o", passwordHash: "x" },
  });
  await db.workspace.create({
    data: { name: "O", ownerId: outsider.id, members: { create: { userId: outsider.id, role: "owner" } } },
  });
  await db.session.create({
    data: { token: outsiderToken, userId: outsider.id, expiresAt: new Date(Date.now() + 864e5) },
  });
  await db.$disconnect();

  const cross = await fetch(`${BASE}/read/${book.id}`, {
    headers: { cookie: `keel_session=${outsiderToken}` },
  });
  check("another workspace's reader gets a 404", cross.status === 404, `status ${cross.status}`);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.message}\n`);
  failures.push(err.message);
} finally {
  server.kill();
  cleanDatabase(root, DB_NAME);
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
