#!/usr/bin/env node
// In-app restart: the full contract, including the part where the process
// actually dies.
//
// The mechanism is deliberate exit + supervisor resurrection. The test plays
// the supervisor itself: ask the server to restart, confirm the response got
// out BEFORE the exit, confirm the exit code is the documented one, start the
// server again the way systemd would, and confirm the boot id changed - which
// is exactly the signal the Settings UI polls for.
//
//   npm run build && node scripts/restart-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "restart-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.RESTART_PORT || 3207);
const BASE = `http://127.0.0.1:${PORT}`;

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

cleanDatabase(root, DB_NAME);
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
// First registered account = instance owner (no KEEL_OWNER_EMAIL in the test env).
const owner = await prisma.user.create({
  data: { email: "boss@example.test", name: "Boss", username: "boss", passwordHash: "x", onboardedAt: new Date() },
});
await prisma.workspace.create({
  data: { name: "B", ownerId: owner.id, members: { create: { userId: owner.id, role: "owner" } } },
});
const other = await prisma.user.create({
  data: { email: "other@example.test", name: "O", username: "other", passwordHash: "x", onboardedAt: new Date() },
});
await prisma.workspace.create({
  data: { name: "O", ownerId: other.id, members: { create: { userId: other.id, role: "owner" } } },
});
const tokens = {};
for (const [k, u] of [["owner", owner], ["other", other]]) {
  tokens[k] = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token: tokens[k], userId: u.id, expiresAt: new Date(Date.now() + 864e5) },
  });
}
await prisma.$disconnect();

const ENV = {
  ...process.env,
  DATABASE_URL: DB_URL,
  NODE_ENV: "production",
  PORT: String(PORT),
  KEEL_SUPERVISED: "1",
};

function startServer() {
  return spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: root,
    env: ENV,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

async function waitFor(url, tries = 160) {
  while (tries-- > 0) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const as = (who) => ({ headers: { cookie: `keel_session=${tokens[who]}` } });

let server = startServer();
try {
  const first = await waitFor(`${BASE}/api/health`);
  if (!first) throw new Error("server did not start");
  const bootA = (await first.json()).boot;
  check("health advertises a boot id", typeof bootA === "string" && bootA.length > 0);

  console.log("\nWho may restart\n");

  let res = await fetch(`${BASE}/api/admin/server`, as("owner"));
  const info = await res.json();
  check("the instance owner reads server info", res.status === 200, `status ${res.status}`);
  check("version, uptime and supervision are reported", Boolean(info.version) && info.uptimeSeconds >= 0 && info.supervised === true);

  res = await fetch(`${BASE}/api/admin/server`, as("other"));
  check("a non-instance-owner cannot read it", res.status === 403, `status ${res.status}`);

  res = await fetch(`${BASE}/api/admin/restart`, { method: "POST", ...as("other") });
  check("a non-instance-owner cannot restart", res.status === 403, `status ${res.status}`);
  res = await fetch(`${BASE}/api/admin/restart`, { method: "POST" });
  check("anonymous cannot restart", res.status === 401 || res.status === 403, `status ${res.status}`);

  const alive = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  check("denied restarts left the server running", alive);

  console.log("\nThe restart itself\n");

  const exitPromise = new Promise((resolve) => server.once("exit", resolve));
  res = await fetch(`${BASE}/api/admin/restart`, { method: "POST", ...as("owner") });
  const body = await res.json().catch(() => null);
  check("the owner's restart is accepted, response arrives before the exit", res.status === 200 && body?.ok === true);
  check("the response says it will come back", body?.supervised === true, JSON.stringify(body));

  const code = await Promise.race([
    exitPromise,
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  check("the process exits with the documented code (87)", code === 87, `exit ${code}`);

  // Play supervisor: bring it back, like systemd Restart=always would.
  server = startServer();
  const again = await waitFor(`${BASE}/api/health`);
  check("the resurrected server serves again", Boolean(again));
  const bootB = again ? (await again.json()).boot : null;
  check("and it has a NEW boot id - the signal the UI polls for", Boolean(bootB) && bootB !== bootA, `${bootA} vs ${bootB}`);

  const db = await testPrisma(root, DB_URL);
  const entry = await db.auditEvent.findFirst({ where: { action: "server.restart" } });
  check("the restart is in the audit log", Boolean(entry));
  await db.$disconnect();

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
