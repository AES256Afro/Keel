#!/usr/bin/env node
// Attachments: upload, serving security, quotas, lifecycle.
//
// An attachment endpoint is a stored-XSS vector by default - upload evil.svg
// or an HTML file, get it served inline from the app's origin, and anyone who
// opens the link runs your script with their session. Most of this suite is
// therefore about what the server does with hostile bytes, not the happy path.
//
//   npm run build && node scripts/attachments-check.mjs
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs/promises";
import { request as httpRequest } from "http";
import path from "path";
import { register } from "node:module";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);
const DB_NAME = "attachments-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.ATTACH_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "keel-attachment-storage-"));

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

/* A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>`);
const HTML = Buffer.from(`<!doctype html><script>fetch('/api/workspace')</script>`);

cleanDatabase(root, DB_NAME);
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const owner = await prisma.user.create({
  data: { email: "a@example.test", name: "A", username: "a", passwordHash: "x" },
});
const ws = await prisma.workspace.create({
  data: { name: "A", ownerId: owner.id, members: { create: { userId: owner.id, role: "owner" } } },
});
const viewer = await prisma.user.create({
  data: { email: "view@example.test", name: "V", username: "view", passwordHash: "x" },
});
await prisma.workspaceMember.create({
  data: { workspaceId: ws.id, userId: viewer.id, role: "viewer" },
});
const outsider = await prisma.user.create({
  data: { email: "x@example.test", name: "X", username: "x", passwordHash: "x" },
});
const otherWs = await prisma.workspace.create({
  data: { name: "X", ownerId: outsider.id, members: { create: { userId: outsider.id, role: "owner" } } },
});

const tokens = {};
for (const [key, user] of [["owner", owner], ["viewer", viewer], ["outsider", outsider]]) {
  tokens[key] = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token: tokens[key], userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
  });
}

const mkPage = (workspaceId, createdById, title) =>
  prisma.page.create({
    data: {
      workspaceId,
      type: "document",
      title,
      content: "{}",
      plainText: "",
      createdById,
      sortOrder: 0,
    },
  });
const page = await mkPage(ws.id, owner.id, "Doc");
const foreignPage = await mkPage(otherWs.id, outsider.id, "Foreign");
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: DB_URL,
    NODE_ENV: "production",
    PORT: String(PORT),
    // Tight limits so the suite can actually hit them: 1 MB per file, 2 MB total.
    KEEL_MAX_ATTACHMENT_MB: "1",
    KEEL_ATTACHMENT_QUOTA_MB: "2",
    NOPIN_UPLOAD_DIR: uploadRoot,
  },
  stdio: "ignore",
  shell: process.platform === "win32",
});

const upload = (as, pageId, bytes, name, type = "application/octet-stream") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  form.append("pageId", pageId);
  return fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: {
      cookie: `keel_session=${tokens[as]}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
    body: form,
  });
};
const get = (as, id) =>
  fetch(`${BASE}/api/attachments/${id}`, {
    headers: { cookie: `keel_session=${tokens[as]}` },
  });

const rawChunkedUpload = (bytes, declaredLength) =>
  new Promise((resolve, reject) => {
    const boundary = "keel-bounded-upload";
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="pageId"\r\n\r\n${page.id}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const headers = {
      cookie: `keel_session=${tokens.owner}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...(declaredLength === undefined ? {} : { "Content-Length": String(declaredLength) }),
    };
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path: "/api/attachments", method: "POST", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write(prefix);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      req.write(bytes.subarray(offset, offset + 64 * 1024));
    }
    req.end(suffix);
  });

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  const {
    AttachmentUploadBusyError,
    withAttachmentUploadSlot,
  } = await import(pathToFileURL(path.join(root, "src/lib/attachment-upload-guard.ts")).href);
  const { withWorkspaceStorageLock } = await import(
    pathToFileURL(path.join(root, "src/lib/workspace-storage.ts")).href
  );
  let releaseUploads;
  const uploadGate = new Promise((resolve) => {
    releaseUploads = resolve;
  });
  const heldUploads = [1, 2].map(() => withAttachmentUploadSlot(() => uploadGate));
  let excessUploadError;
  try {
    await withAttachmentUploadSlot(async () => {});
  } catch (error) {
    excessUploadError = error;
  }
  check(
    "the global upload work cap sheds excess requests before body work begins",
    excessUploadError instanceof AttachmentUploadBusyError
  );
  releaseUploads();
  await Promise.all(heldUploads);

  let firstWorkspaceRelease;
  const firstWorkspaceGate = new Promise((resolve) => {
    firstWorkspaceRelease = resolve;
  });
  const workspaceOrder = [];
  const firstWorkspaceWork = withWorkspaceStorageLock("quota-race", async () => {
    workspaceOrder.push("first-start");
    await firstWorkspaceGate;
    workspaceOrder.push("first-end");
  });
  const secondWorkspaceWork = withWorkspaceStorageLock("quota-race", async () => {
    workspaceOrder.push("second-start");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check(
    "one workspace's quota section is serialized",
    workspaceOrder.join(",") === "first-start",
    workspaceOrder.join(",")
  );
  firstWorkspaceRelease();
  await Promise.all([firstWorkspaceWork, secondWorkspaceWork]);
  check(
    "the next quota section runs only after the first commits or refuses",
    workspaceOrder.join(",") === "first-start,first-end,second-start",
    workspaceOrder.join(",")
  );

  let sharedUsage = 6;
  const reserveAcrossStore = (kind) =>
    withWorkspaceStorageLock("cross-store-race", async () => {
      const observed = sharedUsage;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (observed + 4 > 10) return `${kind}-refused`;
      sharedUsage = observed + 4;
      return `${kind}-stored`;
    });
  const crossStore = await Promise.all([
    reserveAcrossStore("attachment"),
    reserveAcrossStore("onenote"),
  ]);
  check(
    "the shared workspace lock prevents attachment and OneNote quota decisions from racing",
    sharedUsage === 10 &&
      crossStore.filter((result) => result.endsWith("-stored")).length === 1 &&
      crossStore.filter((result) => result.endsWith("-refused")).length === 1,
    `${crossStore.join(",")}; usage=${sharedUsage}`
  );

  console.log("\nUpload and serve\n");

  const res = await upload("owner", page.id, PNG, "dot.png", "image/png");
  check("a PNG uploads", res.status === 201, `status ${res.status}`);
  const { attachment } = await res.json();
  check("the response carries a same-origin URL", attachment.url === `/api/attachments/${attachment.id}`);

  const served = await get("owner", attachment.id);
  const body = Buffer.from(await served.arrayBuffer());
  check("it serves back byte-identical", body.equals(PNG));
  check("as image/png", served.headers.get("content-type") === "image/png");
  check("inline", (served.headers.get("content-disposition") ?? "").startsWith("inline"));
  check("with nosniff", served.headers.get("x-content-type-options") === "nosniff");
  check(
    "with a sandboxing CSP",
    (served.headers.get("content-security-policy") ?? "").includes("sandbox")
  );
  check(
    "cacheable but private",
    (served.headers.get("cache-control") ?? "").includes("private") &&
      (served.headers.get("cache-control") ?? "").includes("immutable")
  );

  console.log("\nHostile bytes\n");

  const svgRes = await upload("owner", page.id, SVG, "evil.svg", "image/svg+xml");
  check("an SVG is accepted as a file", svgRes.status === 201, `status ${svgRes.status}`);
  const svgId = (await svgRes.json()).attachment.id;
  const svgServed = await get("owner", svgId);
  check(
    "but served as an opaque download, never inline SVG",
    svgServed.headers.get("content-type") === "application/octet-stream" &&
      (svgServed.headers.get("content-disposition") ?? "").startsWith("attachment"),
    `${svgServed.headers.get("content-type")} / ${svgServed.headers.get("content-disposition")}`
  );

  const spoofRes = await upload("owner", page.id, HTML, "fake.png", "image/png");
  const spoofId = (await spoofRes.json()).attachment.id;
  const spoofServed = await get("owner", spoofId);
  check(
    "HTML claiming to be a PNG is sniffed and downgraded to a download",
    spoofServed.headers.get("content-type") === "application/octet-stream" &&
      (spoofServed.headers.get("content-disposition") ?? "").startsWith("attachment"),
    spoofServed.headers.get("content-type")
  );

  const evil = 'x".html\r\nSet-Cookie: pwned=1';
  const nameRes = await upload("owner", page.id, PNG, evil, "image/png");
  const nameId = (await nameRes.json()).attachment.id;
  const nameServed = await get("owner", nameId);
  const disposition = nameServed.headers.get("content-disposition") ?? "";
  // filename="..." - the value between the delimiting quotes must contain no
  // CR, LF or quote, or the name injects headers / escapes the parameter.
  const value = /filename="([^]*)"$/.exec(disposition)?.[1] ?? "";
  check(
    "filenames cannot smuggle headers or quotes",
    nameServed.status === 200 && value !== "" && !/[\r\n"]/.test(value),
    JSON.stringify(disposition)
  );
  check("no header was injected", nameServed.headers.get("set-cookie") === null);

  console.log("\nFilenames beyond Latin-1\n");

  // Header values are ByteStrings: a code point above 0xFF in a bare
  // `filename="…"` throws while the Response is constructed, which used to
  // turn every GET of a CJK/emoji-named attachment into a permanent 500. The
  // route must serve RFC 6266/5987 instead: ASCII-only filename= fallback,
  // true name percent-encoded under filename*=UTF-8''.
  const utfName = "文档 “final” 😀.png";
  const utfRes = await upload("owner", page.id, PNG, utfName, "image/png");
  check("a CJK/emoji filename uploads", utfRes.status === 201, `status ${utfRes.status}`);
  const utfUp = (await utfRes.json()).attachment;
  check(
    "and the stored name kept its non-Latin-1 characters",
    /[^\x00-\xff]/.test(utfUp.name ?? ""),
    JSON.stringify(utfUp.name)
  );
  const utfServed = await get("owner", utfUp.id);
  check("its GET serves 200, not 500", utfServed.status === 200, `status ${utfServed.status}`);
  check(
    "byte-identical",
    utfServed.status === 200 && Buffer.from(await utfServed.arrayBuffer()).equals(PNG)
  );
  const utfDisposition = utfServed.headers.get("content-disposition") ?? "";
  check("still inline for a real PNG", utfDisposition.startsWith("inline"), utfDisposition);
  const utfFallback = /filename="([^"]*)"/.exec(utfDisposition)?.[1] ?? "";
  check(
    "the filename= fallback is printable ASCII",
    utfFallback !== "" && /^[\x20-\x7e]+$/.test(utfFallback),
    JSON.stringify(utfDisposition)
  );
  const utfStar = /filename\*=UTF-8''([^;]*)/.exec(utfDisposition)?.[1] ?? "";
  check(
    "filename* carries the true name percent-encoded",
    utfStar !== "" && decodeURIComponent(utfStar) === utfUp.name,
    JSON.stringify(utfDisposition)
  );

  console.log("\nLimits\n");

  const big = Buffer.alloc(1_200_000, 7); // over the 1 MB per-file cap
  const bigRes = await upload("owner", page.id, big, "big.bin");
  check("an over-cap file is refused with 413", bigRes.status === 413, `status ${bigRes.status}`);

  const beforeChunkedDb = await testPrisma(root, DB_URL);
  const beforeChunked = await beforeChunkedDb.attachment.count({
    where: { workspaceId: ws.id },
  });
  await beforeChunkedDb.$disconnect();
  const chunkedStatus = await rawChunkedUpload(Buffer.alloc(1_200_000, 8));
  const afterChunkedDb = await testPrisma(root, DB_URL);
  const afterChunked = await afterChunkedDb.attachment.count({ where: { workspaceId: ws.id } });
  await afterChunkedDb.$disconnect();
  check(
    "a chunked over-cap multipart body is stopped before form parsing",
    chunkedStatus === 413 && afterChunked === beforeChunked,
    `status ${chunkedStatus}, rows ${beforeChunked} -> ${afterChunked}`
  );

  const { readBoundedRequestBody, RequestBodyTooLargeError } = await import(
    pathToFileURL(path.join(root, "src/lib/bounded-request.ts")).href
  );
  let pulls = 0;
  let cancelled = false;
  const forged = new Request(`${BASE}/api/attachments`, {
    method: "POST",
    headers: { "Content-Length": "64" },
    body: new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls >= 100) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  });
  let bounded = false;
  try {
    await readBoundedRequestBody(forged, 1024 * 1024, "too large");
  } catch (err) {
    bounded = err instanceof RequestBodyTooLargeError;
  }
  check(
    "a forged small Content-Length is still capped while streaming",
    bounded && cancelled && pulls < 100,
    `bounded=${bounded} cancelled=${cancelled} pulls=${pulls}`
  );

  // Quota is 2 MB; two 900 KB files fit, the third does not.
  const fill = Buffer.alloc(900_000, 1);
  const f1 = await upload("owner", page.id, fill, "f1.bin");
  const f2 = await upload("owner", page.id, fill, "f2.bin");
  const f3 = await upload("owner", page.id, fill, "f3.bin");
  check(
    "uploads inside the quota succeed",
    f1.status === 201 && f2.status === 201,
    `${f1.status}, ${f2.status}`
  );
  check("the upload that would breach the quota is refused", f3.status === 413, `status ${f3.status}`);

  const oneNoteDir = path.join(uploadRoot, ws.id);
  await fs.mkdir(oneNoteDir, { recursive: true });
  await fs.writeFile(
    path.join(oneNoteDir, `onenote-${"a".repeat(64)}.png`),
    Buffer.alloc(350_000, 5)
  );
  const afterOneNote = await upload("owner", page.id, PNG, "after-onenote.png", "image/png");
  check(
    "ordinary uploads count existing valid OneNote assets against workspace quota",
    afterOneNote.status === 413,
    `status ${afterOneNote.status}`
  );

  const raceSeed = await upload("outsider", foreignPage.id, Buffer.alloc(600_000, 2), "race-seed.bin");
  const raceUploads = await Promise.all([
    upload("outsider", foreignPage.id, Buffer.alloc(800_000, 3), "race-a.bin"),
    upload("outsider", foreignPage.id, Buffer.alloc(800_000, 4), "race-b.bin"),
  ]);
  const raceDb = await testPrisma(root, DB_URL);
  const raceUsed = await raceDb.attachment.aggregate({
    where: { workspaceId: otherWs.id },
    _sum: { size: true },
  });
  await raceDb.$disconnect();
  check(
    "concurrent near-quota uploads cannot race past the workspace ceiling",
    raceSeed.status === 201 &&
      raceUploads.filter((response) => response.status === 201).length === 1 &&
      raceUploads.filter((response) => response.status === 413).length === 1 &&
      (raceUsed._sum.size ?? 0) === 1_400_000,
    `seed=${raceSeed.status} pair=${raceUploads.map((response) => response.status).join(",")} bytes=${raceUsed._sum.size}`
  );

  console.log("\nWho may do what\n");

  const viewerUp = await upload("viewer", page.id, PNG, "v.png", "image/png");
  check("a viewer cannot upload", viewerUp.status === 403, `status ${viewerUp.status}`);

  const crossUp = await upload("outsider", page.id, PNG, "x.png", "image/png");
  check(
    "uploading onto another workspace's page is refused",
    crossUp.status === 404 || crossUp.status === 403,
    `status ${crossUp.status}`
  );

  const crossGet = await get("outsider", attachment.id);
  check("another workspace cannot fetch the file", crossGet.status === 404, `status ${crossGet.status}`);

  const viewerGet = await get("viewer", attachment.id);
  check("a viewer in the workspace can view it", viewerGet.status === 200, `status ${viewerGet.status}`);

  const anonGet = await fetch(`${BASE}/api/attachments/${attachment.id}`);
  check("signed out gets nothing", anonGet.status === 401 || anonGet.status === 404, `status ${anonGet.status}`);

  const viewerDel = await fetch(`${BASE}/api/attachments/${attachment.id}`, {
    method: "DELETE",
    headers: {
      cookie: `keel_session=${tokens.viewer}`,
      Origin: BASE,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  check("a viewer cannot delete", viewerDel.status === 403, `status ${viewerDel.status}`);

  console.log("\nLifecycle\n");

  const db = await testPrisma(root, DB_URL);
  const before = await db.attachment.count({ where: { workspaceId: ws.id } });
  // Hard-delete the page - its files must go with it.
  await db.page.delete({ where: { id: page.id } });
  const after = await db.attachment.count({ where: { workspaceId: ws.id } });
  check(
    "hard-deleting a page cascades away its attachments",
    before > 0 && after === 0,
    `${before} → ${after}`
  );
  await db.$disconnect();
  void foreignPage;

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
} catch (err) {
  console.log(`\n\x1b[31mAborted:\x1b[0m ${err.message}\n`);
  failures.push(err.message);
} finally {
  server.kill();
  cleanDatabase(root, DB_NAME);
  await fs.rm(uploadRoot, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
