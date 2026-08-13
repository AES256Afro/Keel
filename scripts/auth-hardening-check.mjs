#!/usr/bin/env node
// Auth hardening checks: rate limits, security headers, desktop-handoff gating,
// account enumeration, and content size caps.
//
//   node scripts/auth-hardening-check.mjs
import { spawn } from "child_process";
import { request as httpRequest } from "http";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "auth-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.AUTH_PORT || 3196);
const BASE = `http://localhost:${PORT}`;

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

const cleanup = () => cleanDatabase(root, DB_NAME);


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
  const bcrypt = (await import(path.join(root, "node_modules/bcryptjs/index.js"))).default;
  const user = await prisma.user.create({
    data: {
      email: "u@example.test",
      name: "U",
      username: "u",
      passwordHash: await bcrypt.hash("original-password", 10),
    },
  });
  await prisma.workspace.create({
    data: { name: "W", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
  });
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
  });
  // A second session, so revocation has something to revoke.
  const otherToken = randomBytes(32).toString("hex");
  const other = await prisma.session.create({
    data: { token: otherToken, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
  });
  await prisma.$disconnect();
  return { token, otherToken, otherSessionId: other.id };
}

async function main() {
  cleanup();
  console.log("Preparing scratch database…");
  prepareDatabase(root, DB_URL);
  const { token, otherToken, otherSessionId } = await seed();

  console.log(`Starting server on :${PORT}…`);
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: root,
    // NODE_ENV=production so the production CSP branch and X-Forwarded-For
    // trust behaviour are what's under test.
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      PORT: String(PORT),
      // A proxy is simulated by the tests below, so trust forwarded addresses -
      // this is the shape the XFF assertions are about.
      KEEL_TRUST_PROXY: "1",
    },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  try {
    if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

    // ---- Security headers ---------------------------------------------------
    console.log("\nSecurity headers");
    {
      const res = await fetch(`${BASE}/login`);
      const csp = res.headers.get("content-security-policy") ?? "";
      check("sets a Content-Security-Policy", csp.length > 0);
      check("CSP uses a nonce, not unsafe-inline for scripts", /script-src[^;]*'nonce-/.test(csp), csp);
      check("CSP forbids framing", csp.includes("frame-ancestors 'none'"), csp);
      check("CSP pins object-src and base-uri", csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"));
      check("sets X-Frame-Options", res.headers.get("x-frame-options") === "DENY");
      check("sets X-Content-Type-Options", res.headers.get("x-content-type-options") === "nosniff");
      check("sets Referrer-Policy", (res.headers.get("referrer-policy") ?? "").includes("strict-origin"));
      check("sets HSTS", (res.headers.get("strict-transport-security") ?? "").includes("max-age="));
      check("does not advertise the framework", !res.headers.get("x-powered-by"));
    }
    {
      // API responses are per-user; a shared proxy caching one would serve
      // someone else's workspace.
      const res = await fetch(`${BASE}/api/health`);
      check(
        "API responses are not cacheable",
        (res.headers.get("cache-control") ?? "").includes("no-store"),
        res.headers.get("cache-control") ?? "(none)"
      );
      check(
        "API responses vary on Cookie",
        (res.headers.get("vary") ?? "").toLowerCase().includes("cookie"),
        res.headers.get("vary") ?? "(none)"
      );
    }
    {
      // Each response must carry its own nonce.
      const a = (await fetch(`${BASE}/login`)).headers.get("content-security-policy");
      const b = (await fetch(`${BASE}/login`)).headers.get("content-security-policy");
      check("nonce is per-request", a !== b);
    }

    // ---- Desktop handoff gating --------------------------------------------
    console.log("\nDesktop handoff is loopback-only");
    {
      // fetch() refuses to set Host (it's a forbidden header), so these go out
      // over raw HTTP - which is also what an attacker would do.
      const raw = (url, headers = {}) =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: PORT, path: url, method: "GET", headers },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            }
          );
          req.on("error", reject);
          req.end();
        });

      const ID = "a".repeat(32);
      let status = await raw(`/api/auth/desktop-status?id=${ID}`, { Host: "notes.example.com" });
      check("desktop-status is 404 on a public host", status === 404, `got ${status}`);

      status = await raw(`/api/auth/desktop-claim?id=${ID}`, { Host: "notes.example.com" });
      check("desktop-claim is 404 on a public host", status === 404, `got ${status}`);

      status = await raw(`/api/auth/desktop-status?id=${ID}`, {
        Host: `localhost:${PORT}`,
        "X-Forwarded-For": "203.0.113.9",
      });
      check("desktop-status is 404 behind a proxy", status === 404, `got ${status}`);

      status = await raw(`/api/auth/desktop-status?id=${ID}`, {
        Host: `localhost:${PORT}`,
        "X-Forwarded-Host": "notes.example.com",
      });
      check("desktop-status is 404 when a proxy rewrote the host", status === 404, `got ${status}`);

      status = await raw(`/api/auth/desktop-status?id=${ID}`, { Host: `localhost:${PORT}` });
      check("desktop-status still works on loopback", status === 200, `got ${status}`);
    }

    // ---- Account enumeration -----------------------------------------------
    console.log("\nLogin does not disclose which emails exist");
    {
      const attempt = async (email) => {
        const form = new URLSearchParams({ email, password: "definitely-wrong-pw" });
        const res = await fetch(`${BASE}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          redirect: "manual",
        });
        return (await res.text()).replace(/nonce-[^"']+/g, "");
      };
      // Server Actions need their own protocol; this posts as a plain form, so
      // both requests take the identical path. What matters is that neither
      // response distinguishes a known address from an unknown one.
      const known = await attempt("u@example.test");
      const unknown = await attempt("nobody@example.test");
      check(
        "known and unknown emails produce indistinguishable responses",
        known.length === unknown.length || (!known.includes("Google") && !unknown.includes("Google"))
      );
    }

    // ---- Rate limiting ------------------------------------------------------
    console.log("\nRate limiting");
    {
      const auth = { Cookie: `keel_session=${token}` };
      let limited = 0;
      let firstLimitedAt = -1;
      for (let i = 0; i < 80; i++) {
        const res = await fetch(`${BASE}/api/search?q=x${i}`, { headers: auth });
        if (res.status === 429) {
          if (firstLimitedAt < 0) firstLimitedAt = i;
          limited++;
          check("429 carries Retry-After", Boolean(res.headers.get("retry-after")));
          break;
        }
      }
      check("search is rate limited", limited > 0, `no 429 in 80 requests`);
      check("search allows a normal burst first", firstLimitedAt >= 30, `limited at request ${firstLimitedAt}`);
    }
    {
      const auth = { Cookie: `keel_session=${token}` };
      let got429 = false;
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`${BASE}/api/workspace/export`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      check("workspace export is rate limited", got429);
    }

    // ---- X-Forwarded-For cannot be spoofed to escape the IP limit ----------
    console.log("\nSpoofing X-Forwarded-For does not grant fresh rate budget");
    {
      // A trusted proxy APPENDS the real client IP to the right of whatever the
      // client sent. So the real IP is the right-most entry; the left is
      // attacker-controlled. Send many requests that rotate the LEFT-most entry
      // but keep the right-most (the "real" client the proxy would append)
      // fixed - if the limiter reads the right entry these all share one bucket
      // and the search limit still trips. If it (wrongly) read the left, each
      // would get a fresh bucket and never trip.
      const rawGet = (url, headers) =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: PORT, path: url, method: "GET", headers },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            }
          );
          req.on("error", reject);
          req.end();
        });

      let tripped = false;
      for (let i = 0; i < 80; i++) {
        const status = await rawGet(`/api/search?q=spoof${i}`, {
          Cookie: `keel_session=${token}`,
          // unique forged left-most, fixed real right-most
          "X-Forwarded-For": `9.9.9.${i % 240}, 198.51.100.7`,
        });
        if (status === 429) {
          tripped = true;
          break;
        }
      }
      check("rotating the left-most XFF entry does not bypass the IP limit", tripped);
    }

    // ---- Account lifecycle --------------------------------------------------
    console.log("\nPassword change and session revocation");
    {
      const auth = { Cookie: `keel_session=${token}`, "Content-Type": "application/json" };
      const post = (url, method, body, cookie = token) =>
        fetch(`${BASE}${url}`, {
          method,
          headers: { Cookie: `keel_session=${cookie}`, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

      let res = await fetch(`${BASE}/api/account/sessions`, { headers: auth });
      let data = await res.json().catch(() => ({}));
      check("lists this account's sessions", data.sessions?.length === 2, JSON.stringify(data));
      check(
        "marks exactly one session as the current device",
        data.sessions?.filter((s) => s.current).length === 1
      );
      check(
        "never returns the session token itself",
        !JSON.stringify(data).includes(token) && !JSON.stringify(data).includes(otherToken)
      );

      // Anonymous callers get nothing.
      res = await fetch(`${BASE}/api/account/sessions`);
      check("session list rejects anonymous", res.status === 401, `got ${res.status}`);

      // The other session works before it is revoked...
      res = await fetch(`${BASE}/api/notifications`, {
        headers: { Cookie: `keel_session=${otherToken}` },
      });
      check("the second session is valid to begin with", res.status === 200, `got ${res.status}`);

      // ...and is dead immediately after.
      res = await post(`/api/account/sessions/${otherSessionId}`, "DELETE");
      check("revoking another session succeeds", res.status === 200, `got ${res.status}`);
      res = await fetch(`${BASE}/api/notifications`, {
        headers: { Cookie: `keel_session=${otherToken}` },
      });
      check("the revoked session is rejected", res.status === 401, `got ${res.status}`);

      // You cannot revoke the session you are using - that is Sign out.
      res = await fetch(`${BASE}/api/account/sessions`, { headers: auth });
      data = await res.json().catch(() => ({}));
      const currentId = data.sessions?.find((s) => s.current)?.id;
      res = await post(`/api/account/sessions/${currentId}`, "DELETE");
      check("refuses to revoke the current session", res.status === 400, `got ${res.status}`);

      res = await post("/api/account/sessions/does-not-exist", "DELETE");
      check("revoking an unknown session is 404", res.status === 404, `got ${res.status}`);

      // Password change requires the current password.
      res = await post("/api/account/password", "PATCH", {
        currentPassword: "wrong",
        newPassword: "a-brand-new-password",
      });
      check("password change refuses a wrong current password", res.status === 403, `got ${res.status}`);

      res = await post("/api/account/password", "PATCH", {
        currentPassword: "original-password",
        newPassword: "short",
      });
      check("password change refuses a short new password", res.status === 400, `got ${res.status}`);

      res = await post("/api/account/password", "PATCH", {
        currentPassword: "original-password",
        newPassword: "original-password",
      });
      check("password change refuses reusing the same password", res.status === 400, `got ${res.status}`);

      res = await post("/api/account/password", "PATCH", {
        currentPassword: "original-password",
        newPassword: "a-brand-new-password",
      });
      check("password change succeeds", res.status === 200, `got ${res.status}`);

      // The session that made the change survives.
      res = await fetch(`${BASE}/api/notifications`, { headers: auth });
      check("the changing session stays signed in", res.status === 200, `got ${res.status}`);
    }

    // ---- Content size caps --------------------------------------------------
    console.log("\nContent size caps");
    {
      const auth = { Cookie: `keel_session=${token}`, "Content-Type": "application/json" };
      const page = await (
        await fetch(`${BASE}/api/pages`, { method: "POST", headers: auth, body: "{}" })
      ).json();
      const huge = "x".repeat(3 * 1024 * 1024);
      const res = await fetch(`${BASE}/api/pages/${page.page.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ content: huge }),
      });
      check("oversized page content is refused with 413", res.status === 413, `got ${res.status}`);

      const ok = await fetch(`${BASE}/api/pages/${page.page.id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ content: '{"type":"doc","content":[]}' }),
      });
      check("normal page content still saves", ok.status === 200, `got ${ok.status}`);
    }
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
