#!/usr/bin/env node
// Authorization smoke test.
//
// Seeds a throwaway database with four identities and asserts what each one can
// reach. This exists because the instance-owner/workspace-owner confusion (any
// invited viewer was a full instance admin) shipped undetected - the class of
// bug a route-by-route authorization matrix catches and nothing else does.
//
//   node scripts/authz-check.mjs
//
// Runs its own server on a scratch database and cleans up after itself.
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "authz-check";
// SQLite scratch file locally; the real DATABASE_URL when CI points this at
// PostgreSQL, so the same matrix covers both dialects.
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.AUTHZ_PORT || 3199);
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

const cleanDb = () => cleanDatabase(root, DB_NAME);


async function waitFor(url, tries = 120) {
  while (tries-- > 0) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Seed users + sessions directly, so the matrix doesn't depend on the UI. */
async function seed() {
  const prisma = await testPrisma(root, DB_URL);

  const mk = async (email, name) => {
    const user = await prisma.user.create({
      data: { email, name, username: email.split("@")[0], passwordHash: "x" },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: `${name}'s Workspace`,
        ownerId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const token = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
    });
    return { user, workspace, token };
  };

  // Registered first => the instance owner under the fallback rule.
  const owner = await mk("owner@example.test", "Owner");
  const editor = await mk("editor@example.test", "Editor");
  const viewer = await mk("viewer@example.test", "Viewer");
  const stranger = await mk("stranger@example.test", "Stranger");

  await prisma.workspaceMember.create({
    data: { workspaceId: owner.workspace.id, userId: editor.user.id, role: "editor" },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: owner.workspace.id, userId: viewer.user.id, role: "viewer" },
  });

  // A page in the owner's workspace, for cross-workspace isolation checks.
  const page = await prisma.page.create({
    data: {
      workspaceId: owner.workspace.id,
      type: "document",
      title: "Owner private page",
      content: '{"type":"doc","content":[{"type":"paragraph"}]}',
      createdById: owner.user.id,
    },
  });

  await prisma.$disconnect();
  return { owner, editor, viewer, stranger, page };
}

/**
 * @param token   session token, or null for anonymous
 * @param wsId    active workspace to act in. Members belong to several
 *                workspaces and default to their OWN (where they are owner), so
 *                testing a viewer's restrictions means pinning them to the
 *                workspace they were invited into - that's the keel-workspace
 *                cookie the switcher sets.
 */
const req = (token, method, url, body, wsId) => {
  const cookies = [];
  if (token) cookies.push(`keel_session=${token}`);
  if (wsId) cookies.push(`keel-workspace=${wsId}`);
  return fetch(BASE + url, {
    method,
    redirect: "manual",
    headers: {
      ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
};

async function main() {
  cleanDb();
  console.log("Preparing scratch database…");
  prepareDatabase(root, DB_URL);
  const ids = await seed();

  console.log(`Starting server on :${PORT}…`);
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  try {
    if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

    const OWNER = ids.owner.token;
    const EDITOR = ids.editor.token;
    const VIEWER = ids.viewer.token;
    const STRANGER = ids.stranger.token;

    // ---- Instance-wide routes: ONLY the instance owner ----------------------
    console.log("\nInstance-wide routes (instance owner only)");
    const instanceRoutes = [
      ["GET", "/api/instance/access", undefined],
      ["PATCH", "/api/instance/access", { allowedEmails: [], signupDisabled: false }],
      ["GET", "/api/instance/tunnel", undefined],
      ["GET", "/api/admin/news", undefined],
      ["POST", "/api/admin/news", { title: "x" }],
      ["GET", "/api/admin/projects", undefined],
      ["POST", "/api/admin/projects", { title: "x" }],
      ["POST", "/api/admin/projects/import", { username: "octocat" }],
      ["GET", "/api/instance/audit", undefined],
    ];
    for (const [method, url, body] of instanceRoutes) {
      for (const [label, token] of [
        ["viewer", VIEWER],
        ["editor", EDITOR],
        ["other-workspace owner", STRANGER],
      ]) {
        const res = await req(token, method, url, body);
        check(`${method} ${url} refuses ${label}`, res.status === 403, `got ${res.status}`);
      }
      const res = await req(OWNER, method, url, body);
      check(`${method} ${url} allows the instance owner`, res.status !== 403, `got ${res.status}`);
    }

    // ---- Anonymous access ---------------------------------------------------
    console.log("\nAnonymous access");
    for (const [method, url] of [
      ["GET", "/api/instance/access"],
      ["GET", "/api/admin/news"],
      ["GET", "/api/search?q=a"],
      ["GET", "/api/notifications"],
      ["POST", "/api/pages"],
      ["POST", "/api/workspace/export"],
    ]) {
      const res = await req(null, method, url, method === "POST" ? {} : undefined);
      check(`${method} ${url} rejects anonymous`, res.status === 401, `got ${res.status}`);
    }

    // ---- Viewers are read-only ---------------------------------------------
    // Pinned to the workspace they were INVITED into, where their role is viewer.
    const WS = ids.owner.workspace.id;
    console.log("\nView-only members cannot write");
    for (const [method, url, body] of [
      ["POST", "/api/pages", { title: "nope" }],
      ["PATCH", `/api/pages/${ids.page.id}`, { title: "nope" }],
      ["DELETE", `/api/pages/${ids.page.id}`, undefined],
      ["POST", `/api/pages/${ids.page.id}/comments`, { body: "nope" }],
      ["POST", "/api/workspace/import", undefined],
    ]) {
      const res = await req(VIEWER, method, url, body, WS);
      check(`${method} ${url} refuses a viewer`, res.status === 403, `got ${res.status}`);
    }
    {
      const res = await req(VIEWER, "GET", `/api/pages/${ids.page.id}/comments`, undefined, WS);
      check("a viewer CAN read comments", res.status === 200, `got ${res.status}`);
    }
    {
      const res = await req(EDITOR, "PATCH", `/api/pages/${ids.page.id}`, { title: "ok" }, WS);
      check("an editor CAN edit a page in that workspace", res.status === 200, `got ${res.status}`);
    }

    // ---- Workspace isolation ------------------------------------------------
    console.log("\nCross-workspace isolation");
    {
      const res = await req(STRANGER, "PATCH", `/api/pages/${ids.page.id}`, { title: "pwned" });
      check("a stranger cannot edit another workspace's page", res.status === 404, `got ${res.status}`);
    }
    {
      const res = await req(STRANGER, "GET", `/api/pages/${ids.page.id}/comments`);
      check("a stranger cannot read another workspace's comments", res.status === 404, `got ${res.status}`);
    }
    {
      // Regression: POST /api/pages used to accept a parentPageId from any workspace.
      const res = await req(STRANGER, "POST", "/api/pages", {
        title: "child",
        parentPageId: ids.page.id,
      });
      check(
        "POST /api/pages rejects a cross-workspace parentPageId",
        res.status === 404,
        `got ${res.status}`
      );
    }
    {
      const res = await req(STRANGER, "POST", "/api/workspace/switch", {
        workspaceId: ids.owner.workspace.id,
      });
      check("a stranger cannot switch into another workspace", res.status === 404, `got ${res.status}`);
    }

    // ---- The audit trail records privileged actions ------------------------
    console.log("\nAudit trail");
    {
      // Do something privileged, then check it was written.
      await req(OWNER, "PATCH", "/api/instance/access", {
        allowedEmails: ["owner@example.test"],
        signupDisabled: true,
      });
      const res = await req(OWNER, "GET", "/api/instance/audit");
      const data = await res.json().catch(() => ({}));
      const events = data.events ?? [];
      check("the audit endpoint returns events", res.status === 200 && events.length > 0, `${res.status}`);

      const entry = events.find((e) => e.action === "access.update");
      check("an allowlist change is recorded", Boolean(entry), JSON.stringify(events.slice(0, 3)));
      check("the record names the actor", entry?.actor?.includes("owner"), entry?.actor);
      check(
        "the record carries the new setting",
        entry?.detail?.signupDisabled === true,
        JSON.stringify(entry?.detail)
      );
      check(
        "the trail never contains a session token",
        !JSON.stringify(events).includes(OWNER)
      );

      // Restore an open allowlist so later checks aren't locked out.
      await req(OWNER, "PATCH", "/api/instance/access", {
        allowedEmails: [],
        signupDisabled: false,
      });
    }

    // ---- Workspace-scoped owner routes stay workspace-scoped ---------------
    console.log("\nWorkspace-scoped owner routes");
    {
      // The stranger owns their OWN workspace, so this must succeed - it is
      // scoped to their workspace, not the instance.
      const res = await req(STRANGER, "GET", "/api/workspace/members");
      check("a workspace owner can list their own members", res.status === 200, `got ${res.status}`);
    }
    {
      const res = await req(VIEWER, "GET", "/api/workspace/members", undefined, WS);
      check("a viewer cannot list another workspace's members", res.status === 403, `got ${res.status}`);
    }
    {
      const res = await req(EDITOR, "PATCH", "/api/workspace", { name: "renamed" }, WS);
      check("an editor cannot rename someone else's workspace", res.status === 403, `got ${res.status}`);
    }
    {
      const res = await req(EDITOR, "GET", "/api/instance/access", undefined, WS);
      check(
        "acting inside the owner's workspace does NOT grant instance powers",
        res.status === 403,
        `got ${res.status}`
      );
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    cleanDb();
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
  cleanDb();
  process.exit(1);
});
