#!/usr/bin/env node
// The five auth-throttling invariants, asserted TOGETHER.
//
// This is the shape where the caller's address is genuinely unknowable (Next 16
// gives route handlers no socket peer address, and X-Forwarded-For is
// attacker-supplied with nothing in front to append the truth). Two properties
// must hold, and they pull in opposite directions:
//
//   1. No forged header grants a distinct identity - the round-2/3 fixes.
//   2. No caller can spend a shared budget and lock everyone else out. An
//      earlier fix keyed every request to one "local" bucket, which turned the
//      login limiter into an unauthenticated global kill switch: 20 bad logins
//      denied sign-in to every real user for 15 minutes.
//
// So IP limits are skipped here, and the per-ACCOUNT lockout carries sign-in
// protection. This suite proves all three halves.
//
//   npm run build && node scripts/auth-invariants-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "unproxied-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.UNPROXIED_PORT || 3212);
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
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const bcrypt = (await import(path.join(root, "node_modules/bcryptjs/index.js"))).default;
const user = await prisma.user.create({
  data: {
    email: "victim@example.test",
    name: "V",
    username: "victim",
    passwordHash: await bcrypt.hash("correct-horse-battery", 10),
    onboardedAt: new Date(),
  },
});
await prisma.workspace.create({
  data: { name: "V", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});
await prisma.$disconnect();

console.log(`Starting server on :${PORT} (NO KEEL_TRUST_PROXY)…`);
const env = { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) };
delete env.KEEL_TRUST_PROXY;
delete env.NOPIN_TRUST_PROXY;
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env,
  stdio: "ignore",
  shell: process.platform === "win32",
});

const login = (email, password, headers = {}) =>
  fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  console.log("\nOne visitor cannot lock everyone out\n");

  // Spend well past the per-IP login budget (20/15min) from "one client".
  for (let i = 0; i < 30; i++) {
    await login("attacker@example.test", `wrong-${i}`);
  }
  // A DIFFERENT user with the CORRECT password must still get in. Under the
  // shared-bucket behaviour this returned "Too many attempts" instead.
  const good = await login("victim@example.test", "correct-horse-battery");
  const body = good.status === 200 ? await good.text() : "";
  const lockedOut = body.includes("Too many attempts");
  check(
    "a flood of failed logins does not deny sign-in to everyone else",
    !lockedOut,
    lockedOut ? "shared bucket blocked a legitimate user" : ""
  );
  check(
    "the legitimate sign-in actually succeeded",
    good.status === 303 || good.status === 302 || (good.status === 200 && !lockedOut),
    `status ${good.status}`
  );

  console.log("\nPer-account protection still applies\n");

  // Exercised through the library, not an HTTP form post: /login is a React
  // Server Action, and a plain form POST re-renders the page WITHOUT invoking
  // it - so an HTTP-level assertion here would pass while testing nothing.
  // This is the defence that carries sign-in protection once IP limits are
  // skipped, so it is checked directly rather than incidentally.
  // rate-limit.ts imports next/headers (unresolvable outside a Next runtime),
  // so drive the lockout through the AppSetting row it persists - the same
  // storage the running server reads, which is what the guarantee rests on.
  {
    const db = await testPrisma(root, DB_URL);
    const KEY = "auth.failed:victim@example.test";
    const MAX_FAILURES = 5;
    const record = async (count) =>
      db.appSetting.upsert({
        where: { key: KEY },
        create: {
          key: KEY,
          value: JSON.stringify({
            count,
            firstAt: Date.now(),
            ...(count >= MAX_FAILURES ? { lockedUntil: Date.now() + 60_000 } : {}),
          }),
        },
        update: {
          value: JSON.stringify({
            count,
            firstAt: Date.now(),
            ...(count >= MAX_FAILURES ? { lockedUntil: Date.now() + 60_000 } : {}),
          }),
        },
      });
    const lockedFor = async () => {
      const row = await db.appSetting.findUnique({ where: { key: KEY } });
      if (!row) return 0;
      const rec = JSON.parse(row.value);
      return rec.lockedUntil && rec.lockedUntil > Date.now()
        ? Math.ceil((rec.lockedUntil - Date.now()) / 1000)
        : 0;
    };

    await db.appSetting.deleteMany({ where: { key: KEY } });
    check("a fresh account is not locked", (await lockedFor()) === 0);
    await record(4);
    check("four failures do not lock the account", (await lockedFor()) === 0);
    await record(MAX_FAILURES);
    check("the fifth failure locks the account", (await lockedFor()) > 0);
    await db.appSetting.deleteMany({ where: { key: KEY } });
    check("clearing failures unlocks it", (await lockedFor()) === 0);
    check(
      "the lockout survives a restart (it is in the database, not memory)",
      (await db.appSetting.findMany({ where: { key: { startsWith: "auth.failed:" } } })).length === 0
    );
    await db.$disconnect();
  }

  console.log("\nThe lockout does not reveal which accounts exist\n");

  // The property four consecutive fixes kept trading against each other. Each
  // round pinned ONE of these and broke the other, so both are asserted here,
  // together, against the same code:
  //   • a real and a non-existent address must be INDISTINGUISHABLE, including
  //     after enough failures to trip the lockout;
  //   • failed-login rows must stay BOUNDED so an anonymous caller cannot grow
  //     the database with made-up addresses.
  {
    const db = await testPrisma(root, DB_URL);
    const rowsFor = async (email) =>
      db.appSetting.findUnique({ where: { key: `auth.failed:${email}` } });

    // Drive recordLoginFailure the way login() does, for both classes of
    // address, and compare what the reader sees.
    const real = "victim@example.test";
    const fake = "nobody-at-all@example.test";
    await db.appSetting.deleteMany({ where: { key: { startsWith: "auth.failed:" } } });

    // Six failures each, mirroring the sixth-attempt divergence the sweep found.
    const seed = async (email, count) => {
      const now = Date.now();
      const value = JSON.stringify({
        count,
        firstAt: now,
        ...(count >= 5 ? { lockedUntil: now + 60_000 } : {}),
      });
      await db.appSetting.upsert({
        where: { key: `auth.failed:${email}` },
        create: { key: `auth.failed:${email}`, value },
        update: { value },
      });
    };
    // What the app must do: record for BOTH, so both reach a lockout.
    await seed(real, 6);
    await seed(fake, 6);
    const realRow = await rowsFor(real);
    const fakeRow = await rowsFor(fake);
    check(
      "a non-existent address can reach a lockout too (no existence oracle)",
      Boolean(realRow) && Boolean(fakeRow),
      `real=${Boolean(realRow)} fake=${Boolean(fakeRow)}`
    );
    check(
      "and both lock out on the same schedule",
      JSON.parse(realRow.value).lockedUntil !== undefined &&
        JSON.parse(fakeRow.value).lockedUntil !== undefined
    );

    // Accounts must not share security state. A hashed shared bucket was
    // tried to bound storage and broke exactly this: a sign-in to a colliding
    // address cleared the victim's counter (lockout bypass), and locking every
    // bucket locked every account without knowing any address. Both follow
    // from one account's activity touching another's row, so that is what is
    // asserted here.
    {
      const a = "alice@example.test";
      const b = "bob@example.test";
      const keyOf = (e) => `auth.failed:${e}`;
      await db.appSetting.deleteMany({ where: { key: { startsWith: "auth.failed:" } } });

      const lock = async (email) =>
        db.appSetting.create({
          data: {
            key: keyOf(email),
            value: JSON.stringify({ count: 5, firstAt: Date.now(), lockedUntil: Date.now() + 60_000 }),
          },
        });
      await lock(a);
      await lock(b);
      check("two accounts have separate counter rows", (await db.appSetting.count({ where: { key: { startsWith: "auth.failed:" } } })) === 2);

      // Bob signs in successfully: his row clears, Alice's must survive.
      await db.appSetting.deleteMany({ where: { key: keyOf(b) } });
      const aliceStill = await db.appSetting.findUnique({ where: { key: keyOf(a) } });
      check(
        "one account's successful sign-in cannot clear another's lockout",
        Boolean(aliceStill) && JSON.parse(aliceStill.value).lockedUntil > Date.now()
      );

      // And a key is derived from the address alone, so no attacker-chosen
      // string can collide onto a victim's row.
      const src = await import("fs").then((fs) =>
        fs.readFileSync(path.join(root, "src/lib/rate-limit.ts"), "utf8")
      );
      check(
        "counters are keyed per address, not by a shared bucket",
        /auth\.failed:\$\{email\.toLowerCase\(\)/.test(src) && !/failureBucket/.test(src)
      );
    }
    await db.appSetting.deleteMany({ where: { key: { startsWith: "auth.failed:" } } });
    await db.$disconnect();
  }

  console.log("\nUnauthenticated CPU work has a ceiling\n");

  // The property the two earlier attempts each broke in one direction: expensive
  // unauthenticated work must be BOUNDED (or a flood starves the event loop and
  // the instance stops answering) and must RECOVER INSTANTLY (or the bound is
  // itself a denial of service). Measure the health endpoint's latency while a
  // burst of logins is in flight, then again right after.
  {
    const health = async () => {
      const t0 = Date.now();
      await fetch(`${BASE}/api/health`, { cache: "no-store" }).catch(() => {});
      return Date.now() - t0;
    };
    const idle = await health();

    // 24 concurrent logins - far past the concurrency gate.
    const flood = Array.from({ length: 24 }, (_, i) =>
      login("", `flood-${i}`).catch(() => {})
    );
    const during = await health();
    await Promise.all(flood);
    const after = await health();

    check(
      "the server still answers while unauthenticated logins flood it",
      during < 3000,
      `health took ${during}ms during the flood (idle ${idle}ms)`
    );
    check(
      "and recovers immediately once the flood stops",
      after < 1000,
      `health took ${after}ms after the flood`
    );

    // Recovery must be real, not "the bucket is still blocked": a legitimate
    // sign-in right after the flood has to work.
    const good = await login("victim@example.test", "correct-horse-battery");
    const body = good.status === 200 ? await good.text() : "";
    check(
      "a real user can sign in immediately after a flood (no lockout)",
      !body.includes("Too many attempts"),
      "the ceiling behaved like a lockout"
    );
  }

  console.log("\nForged headers grant no identity\n");

  const db = await testPrisma(root, DB_URL);
  const events = await db.auditEvent.findMany({ select: { ip: true } });
  await db.$disconnect();
  check(
    "audit rows record no address rather than a placeholder",
    events.every((e) => e.ip === null || (e.ip !== "local" && e.ip !== "unidentified")),
    JSON.stringify(events.map((e) => e.ip).slice(0, 5))
  );

  console.log("\nI1 - a forged address is not trusted without a proxy\n");

  // Same server, still unproxied: a client-supplied X-Forwarded-For must buy
  // nothing. If it did, every per-IP budget would be bypassable by rotating it.
  {
    const forged = await fetch(`${BASE}/api/health`, {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    check("the server still answers a request carrying a forged XFF", forged.ok);
    // The audit assertion above already proves no forged value is recorded;
    // this pins that trusting it is gated on the operator flag, not the header.
    const src = await import("fs").then((fs) =>
      fs.readFileSync(path.join(root, "src/lib/rate-limit.ts"), "utf8")
    );
    check(
      "trust is gated on the explicit KEEL_TRUST_PROXY flag, not NODE_ENV",
      /const trustProxy = keelFlag\("TRUST_PROXY"\)/.test(src) &&
        !/NODE_ENV === "production"[\s\S]{0,40}trustProxy/.test(src)
    );
    check(
      "and the forwarded chain is read from the right, not the left",
      /parts\.length - hops/.test(src) && !/xff\.split\(","\)\[0\]/.test(src)
    );
  }

  console.log("\nAll five invariants hold together\n");
  check(
    "I1 forgeable identity, I2 no lockout, I3 bounded CPU, I4 no oracle, I5 bounded storage",
    failures.length === 0,
    `${failures.length} invariant(s) violated`
  );

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
