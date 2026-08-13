#!/usr/bin/env node
// Onboarding, the setup guide, and the Azure backup target.
//
// The security-load-bearing piece is parseAzureSasUrl: the server fetches
// whatever URL it accepts, so the host validation is an SSRF boundary, not a
// formality. The rest proves the friendly path actually works: first sign-in
// lands on the welcome tour exactly once, the guide renders real breadcrumbs
// with this instance's own callback URLs, and the caps really did grow.
//
//   npm run build && node scripts/onboarding-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "onboarding-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.ONBOARD_PORT || 3204);
const BASE = `http://127.0.0.1:${PORT}`;

register("./ts-loader.mjs", import.meta.url);
const { parseAzureSasUrl } = await import(
  pathToFileURL(path.join(root, "src/lib/cloud.ts")).href
);
const { buildCapabilities, detectStatus, needsBackupAttention } = await import(
  pathToFileURL(path.join(root, "src/lib/setup-guide.ts")).href
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

console.log("\nAzure SAS validation (SSRF boundary)\n");

const GOOD = "https://mystore.blob.core.windows.net/keel-backups?sv=2022-11-02&sig=abc123";
check("a real container SAS URL passes", parseAzureSasUrl(GOOD) !== null);
check(
  "the parse splits base and query",
  parseAzureSasUrl(GOOD)?.base === "https://mystore.blob.core.windows.net/keel-backups"
);
check("http is refused", parseAzureSasUrl(GOOD.replace("https:", "http:")) === null);
check(
  "an arbitrary host is refused - the server fetches this URL",
  parseAzureSasUrl("https://internal-service.local/c?sv=1&sig=x") === null
);
check(
  "a lookalike suffix host is refused",
  parseAzureSasUrl("https://x.blob.core.windows.net.evil.test/c?sv=1&sig=x") === null
);
check(
  "a lookalike path on a foreign host is refused",
  parseAzureSasUrl("https://evil.test/x.blob.core.windows.net?sv=1&sig=x") === null
);
check(
  "a blob path (container/blob) is refused - container only",
  parseAzureSasUrl("https://a.blob.core.windows.net/c/deeper?sv=1&sig=x") === null
);
check("a missing sig is refused", parseAzureSasUrl("https://a.blob.core.windows.net/c?sv=1") === null);
check("a missing sv is refused", parseAzureSasUrl("https://a.blob.core.windows.net/c?sig=x") === null);
check("garbage is refused, not thrown", parseAzureSasUrl("not a url at all") === null);
check("userinfo trickery is refused", parseAzureSasUrl("https://a.blob.core.windows.net@evil.test/c?sv=1&sig=x") === null);

console.log("\nThe registry itself\n");

const caps = buildCapabilities("https://example.keel.test");
check("every capability has a payoff and at least one need", caps.every((c) => c.payoff && c.needs.length > 0));
check(
  "every need has plain-language 'what', a destination, and steps",
  caps.every((c) => c.needs.every((n) => n.what && n.destination && n.steps.length > 0))
);
check(
  "every external link is https",
  caps.every((c) => c.needs.every((n) => n.where.url.startsWith("https://") || n.where.url.startsWith("/")))
);
check(
  "the instance's own callback URL is baked into the Google steps",
  caps
    .find((c) => c.key === "google-signin")
    .needs[0].steps.some((s) => s.includes("https://example.keel.test/api/auth/google/callback"))
);
const status = await detectStatus({
  cloudProvider: null,
  cloudRefreshToken: null,
  cloudEmail: null,
  oneNoteRefreshToken: null,
});
check("detectStatus covers every capability", caps.every((c) => status[c.key]));
check("no cloud provider → backup attention", needsBackupAttention({ cloudProvider: null }) === true);
check("any provider → no nag", needsBackupAttention({ cloudProvider: "azure" }) === false);

/* ---------------- HTTP ---------------- */

cleanDatabase(root, DB_NAME);
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const fresh = await prisma.user.create({
  data: { email: "new@example.test", name: "New", username: "new", passwordHash: "x" },
});
const ws = await prisma.workspace.create({
  data: { name: "N", ownerId: fresh.id, members: { create: { userId: fresh.id, role: "owner" } } },
});
const viewer = await prisma.user.create({
  data: {
    email: "v@example.test", name: "V", username: "v", passwordHash: "x",
    onboardedAt: new Date(),
  },
});
await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: viewer.id, role: "viewer" } });
const tokens = {};
for (const [k, u] of [["fresh", fresh], ["viewer", viewer]]) {
  tokens[k] = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token: tokens[k], userId: u.id, expiresAt: new Date(Date.now() + 864e5) },
  });
}
await prisma.page.create({
  data: {
    workspaceId: ws.id, type: "document", title: "Existing", content: "{}",
    plainText: "", createdById: fresh.id, sortOrder: 0,
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
const as = (who) => ({
  headers: {
    cookie: `keel_session=${tokens[who]}`,
    Origin: BASE,
    "Sec-Fetch-Site": "same-origin",
  },
});

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  console.log("\nFirst sign-in lands on the tour, once\n");

  let res = await fetch(`${BASE}/`, { ...as("fresh"), redirect: "manual" });
  check(
    "a never-onboarded user is pointed at /welcome",
    res.status === 307 && (res.headers.get("location") ?? "").includes("/welcome"),
    `${res.status} → ${res.headers.get("location")}`
  );

  res = await fetch(`${BASE}/welcome`, as("fresh"));
  const welcome = await res.text();
  check("the welcome page renders", res.status === 200);
  check("it names the real database location", welcome.includes("nopin") || welcome.includes(".db") || welcome.includes("PostgreSQL"));
  check("it offers all five safety nets", ["backup-local", "backup-gdrive", "backup-onedrive", "backup-azure", "backup-r2"].every((k) => welcome.includes(`/setup#${k}`)));
  check("screenshots are welcome at 50 MB", welcome.includes("50 MB"));

  res = await fetch(`${BASE}/api/account/onboarded`, { method: "POST", ...as("fresh") });
  check("finishing the tour succeeds", res.status === 200);

  res = await fetch(`${BASE}/`, { ...as("fresh"), redirect: "manual" });
  check(
    "after finishing, home goes to notes, never the tour again",
    res.status === 307 && (res.headers.get("location") ?? "").includes("/p/"),
    `${res.status} → ${res.headers.get("location")}`
  );

  console.log("\nThe setup guide\n");

  res = await fetch(`${BASE}/setup`, as("fresh"));
  const setup = await res.text();
  check("the guide renders", res.status === 200);
  check(
    "this instance's own callback URL appears in the steps",
    setup.includes(`http://127.0.0.1:${PORT}/api/auth/google/callback`),
    "callback not derived from Host"
  );
  check(
    "console deep links are present",
    ["console.cloud.google.com", "portal.azure.com", "dash.cloudflare.com"].every((h) => setup.includes(h))
  );
  check("the R2 trap warning made it in", setup.includes("Token value"));
  check("the unencrypted-snapshots nudge shows", setup.includes("UNENCRYPTED"));

  const anon = await fetch(`${BASE}/setup`, { redirect: "manual" });
  check("signed out cannot read the guide", anon.status === 307);

  console.log("\nR2 connect route (SSRF guard)\n");

  res = await fetch(`${BASE}/api/cloud/r2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `keel_session=${tokens.fresh}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ endpoint: "http://169.254.169.254", bucket: "x", accessKeyId: "x", secretKey: "x" }),
  });
  check("an internal endpoint is rejected before any fetch", res.status === 400, `status ${res.status}`);

  res = await fetch(`${BASE}/api/cloud/r2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `keel_session=${tokens.fresh}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ endpoint: "https://evil.tld/x", bucket: "x", accessKeyId: "x", secretKey: "x" }),
  });
  check("a non-R2 https host is rejected", res.status === 400, `status ${res.status}`);

  console.log("\nAzure connect route\n");

  res = await fetch(`${BASE}/api/cloud/azure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `keel_session=${tokens.fresh}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ sasUrl: "https://internal.service/c?sv=1&sig=x" }),
  });
  check("a non-Azure URL is rejected at the route", res.status === 400, `status ${res.status}`);

  res = await fetch(`${BASE}/api/cloud/azure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `keel_session=${tokens.viewer}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ sasUrl: GOOD }),
  });
  check("a viewer cannot connect backup targets", res.status === 403, `status ${res.status}`);

  console.log("\nBigger attachments by default\n");

  const page = await (async () => {
    const db = await testPrisma(root, DB_URL);
    const p = await db.page.findFirst({ where: { workspaceId: ws.id } });
    await db.$disconnect();
    return p;
  })();
  // 15 MB - over the old 10 MB default, comfortably under the new 50 MB.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(15 * 1024 * 1024, 3),
  ]);
  const form = new FormData();
  form.append("file", new File([png], "big-screenshot.png", { type: "image/png" }));
  form.append("pageId", page.id);
  res = await fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: {
      cookie: `keel_session=${tokens.fresh}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: form,
  });
  check("a 15 MB screenshot uploads with default caps", res.status === 201, `status ${res.status}`);

  console.log("\nRedirects survive proxies (the container-hostname leak)\n");

  // The bug this guards: behind Tailscale Serve → Docker, the app's view of
  // its own host is the container id. An absolute Location built from it sent
  // browsers to http://89e559d8d1fe:3000/… - ERR_NAME_NOT_RESOLVED from
  // clicking "Today". Same-origin redirects must be relative, whatever lie
  // the Host header tells.
  res = await fetch(`${BASE}/today?d=2026-08-04`, {
    headers: { cookie: `keel_session=${tokens.fresh}`, host: "89e559d8d1fe:3000" },
    redirect: "manual",
  });
  let loc = res.headers.get("location") ?? "";
  check(
    "Today redirects relative even behind a lying Host header",
    res.status === 307 && loc.startsWith("/p/"),
    `${res.status} → ${loc}`
  );
  check("the container hostname never reaches the browser", !loc.includes("89e559d8d1fe"));

  res = await fetch(`${BASE}/today`, {
    headers: { host: "89e559d8d1fe:3000" },
    redirect: "manual",
  });
  loc = res.headers.get("location") ?? "";
  check("the signed-out bounce is relative too", loc === "/login", loc);

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
