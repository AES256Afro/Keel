#!/usr/bin/env node
// Public page capability-link contracts: hashed at rest, scoped, expiring and revocable.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbName = "page-share-check";
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

function rejects(operation) {
  return operation().then(() => false, () => true);
}

cleanDatabase(root, dbName);
prepareDatabase(root, databaseUrl);
process.env.DATABASE_URL = databaseUrl;
register("./ts-loader.mjs", import.meta.url);

const {
  hashPageShareToken,
  issuePageShare,
  pageShareExpiry,
  pageShareStatus,
  resolvePageShare,
  revokePageShare,
  validPageShareToken,
} = await import(pathToFileURL(path.join(root, "src/lib/page-share.ts")).href);
const prisma = await testPrisma(root, databaseUrl);

try {
  const user = await prisma.user.create({
    data: { email: "owner@example.test", name: "Owner", username: "owner", passwordHash: "x" },
  });
  const workspace = await prisma.workspace.create({ data: { name: "Shared", ownerId: user.id } });
  const page = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "document",
      title: "Public draft",
      content: '{"type":"doc","content":[]}',
      createdById: user.id,
    },
  });

  const first = await issuePageShare({ pageId: page.id, createdById: user.id, expiresInDays: 7 });
  check("generated token has the strict capability format", validPageShareToken(first.token));
  check("generated path contains the capability token", first.path === `/share/${first.token}`);
  const stored = await prisma.pageShare.findUniqueOrThrow({ where: { pageId: page.id } });
  check("the database stores only the SHA-256 digest", stored.tokenHash === hashPageShareToken(first.token));
  check("the plaintext token is absent from the stored row", !JSON.stringify(stored).includes(first.token));
  check("a valid capability resolves its exact document", (await resolvePageShare(first.token))?.page.id === page.id);
  check("an altered capability does not resolve", (await resolvePageShare(`${first.token.slice(0, -1)}A`)) === null);
  check("active status never returns the capability", !JSON.stringify(await pageShareStatus(page.id)).includes("keel_share_"));

  const second = await issuePageShare({ pageId: page.id, createdById: user.id, expiresInDays: null });
  check("regeneration immediately invalidates the old link", (await resolvePageShare(first.token)) === null);
  check("the replacement link resolves", (await resolvePageShare(second.token))?.page.id === page.id);
  check("a no-expiry link reports no expiry", (await pageShareStatus(page.id)).expiresAt === null);

  check("revocation reports a removed link", await revokePageShare(page.id));
  check("revocation invalidates the link", (await resolvePageShare(second.token)) === null);
  check("repeated revocation is idempotent", !(await revokePageShare(page.id)));

  const short = await issuePageShare({ pageId: page.id, createdById: user.id, expiresInDays: 1 });
  const beforeExpiry = new Date(new Date(short.expiresAt).getTime() - 1);
  const afterExpiry = new Date(new Date(short.expiresAt).getTime() + 1);
  check("a link resolves immediately before expiry", (await resolvePageShare(short.token, beforeExpiry)) !== null);
  check("an expired link fails closed", (await resolvePageShare(short.token, afterExpiry)) === null);

  await prisma.page.update({ where: { id: page.id }, data: { archivedAt: new Date() } });
  check("trashing a page disables its public link", (await resolvePageShare(short.token)) === null);
  await prisma.page.update({ where: { id: page.id }, data: { archivedAt: null, externalSource: "onenote" } });
  check("turning a page into an external mirror disables its link", (await resolvePageShare(short.token)) === null);
  check("unsupported expiries are rejected", await rejects(async () => pageShareExpiry(365)));

  await prisma.page.delete({ where: { id: page.id } });
  check("deleting a page cascades its share row", (await prisma.pageShare.count()) === 0);
} finally {
  await prisma.$disconnect();
  cleanDatabase(root, dbName);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  • ${failure}`);
  process.exit(1);
}
