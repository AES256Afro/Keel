#!/usr/bin/env node
// Exercise the file-backed cloud transfer path without real credentials.
// A local S3-compatible stub receives a multipart R2 upload, lists it, and
// streams it back. The source is larger than one upload chunk so a whole-file
// implementation cannot accidentally satisfy this check.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `: ${detail}` : ""}`);
  }
};

const bodyOf = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "keel-cloud-transfer-"));
const source = path.join(temp, "keel-test-2026-08-13T00-00-00.json");
const destination = path.join(temp, "download.json");
const bytes = Buffer.alloc(8 * 1024 * 1024 + 123, 0x5a);
Buffer.from("KEEL-CLOUD-SENTINEL").copy(bytes, bytes.length - 19);
await fs.writeFile(source, bytes, { mode: 0o600 });

const parts = new Map();
let stored = null;
let completeBody = "";
const key = `/bucket/keel-backups/${path.basename(source)}`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === key && url.searchParams.has("uploads")) {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("<InitiateMultipartUploadResult><UploadId>mock/upload+1</UploadId></InitiateMultipartUploadResult>");
    return;
  }
  if (req.method === "PUT" && url.pathname === key && url.searchParams.has("partNumber")) {
    const number = Number(url.searchParams.get("partNumber"));
    parts.set(number, await bodyOf(req));
    res.writeHead(200, { ETag: `\"part-${number}\"` });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === key && url.searchParams.has("uploadId")) {
    completeBody = (await bodyOf(req)).toString("utf8");
    stored = Buffer.concat([...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part));
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("<CompleteMultipartUploadResult/>");
    return;
  }
  if (req.method === "DELETE" && url.pathname === key && url.searchParams.has("uploadId")) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/bucket" && url.searchParams.get("list-type") === "2") {
    const size = stored?.length ?? 0;
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(
      `<ListBucketResult><Contents><Key>keel-backups/${path.basename(source)}</Key>` +
        `<Size>${size}</Size><LastModified>2026-08-13T00:00:00Z</LastModified></Contents></ListBucketResult>`
    );
    return;
  }
  if (req.method === "GET" && url.pathname === key && stored) {
    res.writeHead(200, { "Content-Length": String(stored.length) });
    res.end(stored);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  const cfg = {
    endpoint,
    bucket: "bucket",
    accessKeyId: "test-key",
    secretKey: "test-secret",
  };
  const { normalizeR2Config, r2Download, r2List, r2Upload, writeCloudResponseToFile } = await import(
    pathToFileURL(path.join(root, "src/lib/cloud.ts")).href
  );

  console.log("\nMultipart cloud transfer\n");
  await r2Upload(cfg, path.basename(source), source);
  check("a file larger than one chunk uploads as multiple parts", parts.size === 2, `${parts.size} parts`);
  check(
    "the completion request names every uploaded part in order",
    /<PartNumber>1<\/PartNumber>/.test(completeBody) &&
      /<PartNumber>2<\/PartNumber>/.test(completeBody) &&
      completeBody.indexOf("<PartNumber>1") < completeBody.indexOf("<PartNumber>2"),
    completeBody
  );
  check(
    "the committed object is byte-identical to the source",
    createHash("sha256").update(stored).digest("hex") === createHash("sha256").update(bytes).digest("hex")
  );

  const listed = await r2List(cfg);
  check("the uploaded object is listed as a Keel backup", listed.length === 1 && listed[0].name === path.basename(source));
  const response = await r2Download(cfg, listed[0].id);
  await writeCloudResponseToFile(response, destination);
  const downloaded = await fs.readFile(destination);
  check("the streamed download is byte-identical", downloaded.equals(bytes));

  check(
    "stored R2 endpoints are revalidated before use",
    normalizeR2Config({ ...cfg, endpoint: "http://127.0.0.1:9000" }) === null
  );
  check(
    "stored R2 bucket names cannot change the signed URL path",
    normalizeR2Config({ ...cfg, bucket: "../other-bucket" }) === null
  );

  let prefixError = "";
  try {
    await r2Download(cfg, "unrelated/private.txt");
  } catch (err) {
    prefixError = String(err?.message ?? err);
  }
  check("an R2 object outside the backup prefix is refused", prefixError.includes("outside the backup prefix"), prefixError);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
