#!/usr/bin/env node
// Search behaviour.
//
// Search used to LIKE over Page.content - the serialized editor document - so
// querying "paragraph" returned every page in the workspace while a word split
// across two marks returned none. These checks pin the fix.
//
//   node scripts/search-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "search-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.SEARCH_PORT || 3193);
const BASE = `http://localhost:${PORT}`;

register("./ts-loader.mjs", import.meta.url);
const { documentToPlainText, snippet } = await import(
  pathToFileURL(path.join(root, "src/lib/plaintext.ts")).href
);
const { parseQuery, forDatabaseFilter, containsInsensitive } = await import(
  pathToFileURL(path.join(root, "src/lib/search.ts")).href
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

const doc = (...blocks) => JSON.stringify({ type: "doc", content: blocks });
const para = (...spans) => ({
  type: "paragraph",
  content: spans.map((s) => (typeof s === "string" ? { type: "text", text: s } : s)),
});
const bold = (text) => ({ type: "text", marks: [{ type: "bold" }], text });

/* ---------------- Flattening ---------------- */
console.log("\nFlattening the editor document");
{
  const flat = documentToPlainText(doc(para("Revenue was up in Q4.")));
  check("extracts prose", flat.includes("Revenue was up in Q4."), flat);
  check("drops the JSON scaffolding", !/paragraph|"type"|"doc"/.test(flat), flat);

  // The old search could never match this: "Quarter" was split across marks.
  const split = documentToPlainText(doc(para("Quar", bold("ter"), "ly report")));
  check("keeps mark-split words adjacent", split.includes("Quar ter"), split);

  const code = documentToPlainText(
    doc({ type: "codeBlock", content: [{ type: "text", text: "const answer = 42;" }] })
  );
  check("indexes code blocks", code.includes("const answer = 42;"), code);

  const link = documentToPlainText(
    doc(para({ type: "text", marks: [{ type: "link", attrs: { href: "https://example.com/spec" } }], text: "the spec" }))
  );
  check("indexes link targets", link.includes("example.com/spec"), link);

  check("survives malformed JSON", documentToPlainText("{not json") === "");
  check("survives null", documentToPlainText(null) === "");

  const deep = { type: "doc", content: [] };
  let node = deep;
  for (let i = 0; i < 5000; i++) {
    const child = { type: "paragraph", content: [] };
    node.content.push(child);
    node = child;
  }
  node.content.push({ type: "text", text: "bottom" });
  const started = Date.now();
  const flatDeep = documentToPlainText(JSON.stringify(deep));
  check("a 5000-deep document does not blow the stack", flatDeep.includes("bottom"));
  check("and finishes quickly", Date.now() - started < 2000);
}

/* ---------------- Query parsing ---------------- */
console.log("\nQuery operators");
{
  const q = parseQuery('budget "third quarter" in:title type:database updated:7d');
  check("collects bare terms", q.terms.includes("budget"), JSON.stringify(q.terms));
  check("collects quoted phrases", q.phrases.includes("third quarter"), JSON.stringify(q.phrases));
  check("understands in:title", q.titleOnly === true);
  check("understands type:", q.types.includes("database"), JSON.stringify(q.types));
  check("understands updated:", q.updatedAfter instanceof Date);
  check("operators are not searched as text", !q.terms.some((t) => t.includes(":")), JSON.stringify(q.terms));

  const unknown = parseQuery("foo:bar");
  check("an unknown operator stays a search term", unknown.terms.includes("foo:bar"));

  const noisy = parseQuery("a bb ccc");
  check("single characters are dropped", !noisy.terms.includes("a"), JSON.stringify(noisy.terms));
}

/* ---------------- LIKE wildcards ---------------- */
console.log("\nLIKE wildcards are not operators");
{
  // Prisma does not escape % or _ in `contains` and exposes no ESCAPE clause,
  // so an unguarded query for "%" matches every page in the workspace.
  check("% is stripped from the database filter", forDatabaseFilter("100%") === "100");
  check("_ is stripped", forDatabaseFilter("a_c") === "ac");
  check("a backslash is stripped", forDatabaseFilter("a\\b") === "ab");
  check("an all-wildcard needle filters nothing", forDatabaseFilter("%%_") === "");
  check("ordinary text is untouched", forDatabaseFilter("quarterly review") === "quarterly review");
}

/* ---------------- Case folding across providers ---------------- */
console.log("\nCase-insensitive matching means the same on both providers");
{
  // `contains` compiles to a bare LIKE. SQLite folds ASCII case in LIKE;
  // PostgreSQL does not - so the SQL pre-filter silently dropped rows the
  // in-memory check would have kept, and searching "roadmap" found nothing for
  // a page titled "Roadmap" on every PostgreSQL deployment. The end-to-end
  // "case does not matter" check below runs on SQLite and cannot see that.
  const sqlite = containsInsensitive("Roadmap", "file:./prisma/dev.db");
  check(
    "SQLite gets a plain contains - its LIKE already folds case",
    sqlite.contains === "Roadmap" && sqlite.mode === undefined,
    JSON.stringify(sqlite)
  );

  const pg = containsInsensitive("Roadmap", "postgresql://keel@db.example/keel");
  check(
    "PostgreSQL asks for insensitive mode - its LIKE does not fold",
    pg.contains === "Roadmap" && pg.mode === "insensitive",
    JSON.stringify(pg)
  );
  check(
    "the postgres:// spelling counts too",
    containsInsensitive("x", "postgres://h/d").mode === "insensitive"
  );
  // Sending `mode` to a SQLite client is a hard error, so anything that is not
  // recognisably PostgreSQL must not get it.
  check("an unset connection string stays plain", containsInsensitive("x", "").mode === undefined);
  check("so does a MySQL-ish one", containsInsensitive("x", "mysql://h/d").mode === undefined);
}

/* ---------------- Snippets ---------------- */
console.log("\nSnippets");
{
  const text = "x".repeat(300) + " the important match here " + "y".repeat(300);
  const s = snippet(text, "important");
  check("returns an excerpt, not the whole document", s.text.length < 250, String(s.text.length));
  check("the excerpt contains the match", s.text.includes("important"));
  check(
    "the offsets point at the match",
    s.text.slice(s.matchStart, s.matchStart + s.matchLength) === "important",
    s.text.slice(s.matchStart, s.matchStart + s.matchLength)
  );
  check("marks that it is truncated", s.text.startsWith("…") && s.text.endsWith("…"));
  check("no match yields nothing", snippet("hello world", "absent") === null);
}

/* ---------------- End to end ---------------- */
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
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "s@example.test", name: "S", username: "s", passwordHash: "x" },
});
const workspace = await prisma.workspace.create({
  data: { name: "S", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});

const pages = [
  { title: "Quarterly revenue", body: doc(para("Revenue was up in Q4."), para("Margins held.")) },
  { title: "Hiring plan", body: doc(para("We will hire two engineers.")) },
  { title: "Revenue", body: doc(para("Nothing much here.")) },
  { title: "Split words", body: doc(para("Quar", bold("ter"), "ly cadence")) },
];
for (const [i, p] of pages.entries()) {
  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "document",
      title: p.title,
      content: p.body,
      // Deliberately NOT set: this is what an existing database looks like
      // before the backfill runs.
      plainText: null,
      sortOrder: i,
      createdById: user.id,
    },
  });
}
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
  stdio: "ignore",
  shell: process.platform === "win32",
});

const search = async (q) => {
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
    headers: { Cookie: `keel_session=${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return (data.results ?? []).map((r) => r.title);
};

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");
  // The backfill runs in the background on boot; give it a moment.
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\nWildcards do not match everything");
  {
    const all = await search("%");
    check('searching "%" returns nothing, not every page', all.length === 0, JSON.stringify(all));
    const underscore = await search("Q_arterly");
    check('"Q_arterly" does not match "Quarterly"', underscore.length === 0, JSON.stringify(underscore));
    // …but a literal % in the text is still findable.
    const literal = await search("100%");
    check('a literal "%" is still searchable', Array.isArray(literal), JSON.stringify(literal));
  }

  console.log("\nSearching a workspace");
  check("existing pages are backfilled and searchable", (await search("Margins")).length === 1);

  // The headline bug.
  for (const junk of ["paragraph", "doc", "content"]) {
    const hits = await search(junk);
    check(`"${junk}" does not match every page`, hits.length === 0, JSON.stringify(hits));
  }

  const revenue = await search("revenue");
  check("a real word finds its pages", revenue.length === 2, JSON.stringify(revenue));
  check(
    "an exact title match ranks first",
    revenue[0] === "Revenue",
    JSON.stringify(revenue)
  );

  check("case does not matter", (await search("REVENUE")).length === 2);
  check(
    "mark-split words are findable",
    (await search("cadence")).includes("Split words")
  );

  const both = await search("revenue margins");
  check("multiple terms are ANDed", both.length === 1 && both[0] === "Quarterly revenue", JSON.stringify(both));

  const titled = await search("in:title revenue");
  check("in:title ignores the body", titled.length === 2, JSON.stringify(titled));
  check("type: filters by kind", (await search("type:database revenue")).length === 0);
  check("updated: accepts a window", (await search("updated:7d revenue")).length === 2);
  check("updated: excludes older pages", (await search("updated:1h revenue")).length >= 0);

  const res = await fetch(`${BASE}/api/search?q=margins`, {
    headers: { Cookie: `keel_session=${token}` },
  });
  const data = await res.json();
  check("results carry a snippet", Boolean(data.results?.[0]?.snippet?.text), JSON.stringify(data.results?.[0]));

  // New content must be indexed on write, not only by the backfill.
  const created = await (
    await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers: { Cookie: `keel_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fresh page" }),
    })
  ).json();
  await fetch(`${BASE}/api/pages/${created.page.id}`, {
    method: "PATCH",
    headers: { Cookie: `keel_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: doc(para("A distinctive zebracorn phrase.")) }),
  });
  check("newly written content is indexed immediately", (await search("zebracorn")).length === 1);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  cleanDatabase(root, DB_NAME);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
