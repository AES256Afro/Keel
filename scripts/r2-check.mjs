#!/usr/bin/env node
// Does the R2 configuration actually work?
//
// Backup credentials fail silently by nature: nothing reads them until the
// first replication, and nobody notices a broken backup until they need to
// restore. This signs a real request and asks R2 to answer, so a typo surfaces
// now rather than on the worst day.
//
// Shape is checked first because the common mistakes have a signature - the
// Cloudflare dashboard shows the account ID far more prominently than the token
// credentials, so it tends to get pasted into all three fields.
//
//   node scripts/r2-check.mjs [path-to-env]      (default .env.prod)
import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.resolve(root, process.argv[2] || ".env.prod");

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

let raw;
try {
  raw = readFileSync(envPath, "utf8");
} catch {
  console.log(`\nNo env file at ${envPath}\n`);
  process.exit(1);
}

const env = {};
for (const line of raw.split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const endpoint = env.LITESTREAM_R2_ENDPOINT || "";
const bucket = env.LITESTREAM_R2_BUCKET || "";
const keyId = env.LITESTREAM_R2_ACCESS_KEY_ID || "";
const secret = env.LITESTREAM_R2_SECRET_ACCESS_KEY || "";

console.log(`\nR2 configuration (${path.relative(root, envPath)})\n`);

/* ---------------- Shape ---------------- */

const acct = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com\/?$/.exec(endpoint)?.[1];
check("endpoint is https://<account-id>.r2.cloudflarestorage.com", Boolean(acct), endpoint || "empty");
check("bucket name is set", bucket.length > 0);
check("access key id is 32 hex characters", /^[0-9a-f]{32}$/.test(keyId), `len ${keyId.length}`);
check("secret access key is 64 hex characters", /^[0-9a-f]{64}$/.test(secret), `len ${secret.length}`);

// The signature of the usual mistake.
check(
  "access key id is not the account id",
  !acct || keyId !== acct,
  keyId === acct ? "this is the account ID, not the token's Access Key ID" : ""
);
check(
  "secret is not the account id",
  !acct || secret !== acct,
  secret === acct ? "this is the account ID, not the token's Secret Access Key" : ""
);
check("access key id and secret are different values", !keyId || keyId !== secret);

if (failures.length) {
  console.log(`\n${passed} passed, ${failures.length} failed - skipping the live check\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  console.log(
    "\nThe Access Key ID and Secret Access Key appear only on the page shown\n" +
      "immediately after creating an R2 API token (R2 → Manage R2 API Tokens →\n" +
      "Create API token). The secret is displayed once; if that page is gone,\n" +
      "delete the token and create a new one.\n"
  );
  process.exit(1);
}

/* ---------------- Live ---------------- */

console.log("\nTalking to R2\n");

// Minimal SigV4 for one GET. Signing by hand rather than pulling in the AWS SDK
// (~20 MB) for a single request the installer may never otherwise need.
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

function sign({ method, host, pathname, query, region = "auto", service = "s3" }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256("");

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signature = hmac(
    hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request"),
    stringToSign
  ).toString("hex");

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

const host = `${acct}.r2.cloudflarestorage.com`;
const pathname = `/${bucket}`;
const query = "list-type=2&max-keys=1";

let res;
try {
  res = await fetch(`https://${host}${pathname}?${query}`, {
    headers: sign({ method: "GET", host, pathname, query }),
    signal: AbortSignal.timeout(15000),
  });
} catch (err) {
  check("R2 is reachable", false, err.message);
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}

const body = await res.text();
const errCode = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];

check("R2 is reachable", true);

if (res.ok) {
  check("the credentials are accepted", true);
  check("the bucket exists and is listable", true);
  const n = (body.match(/<Key>/g) || []).length;
  console.log(`\n  bucket "${bucket}" responded - ${n > 0 ? "has objects" : "currently empty"}`);
} else {
  const hint =
    {
      InvalidAccessKeyId: "the Access Key ID is wrong, or the token was deleted",
      SignatureDoesNotMatch: "the Secret Access Key is wrong",
      NoSuchBucket: `no bucket named "${bucket}" in this account`,
      AccessDenied: "the token lacks Object Read & Write on this bucket",
    }[errCode] || `HTTP ${res.status}`;
  check("the credentials are accepted", false, `${errCode || res.status}: ${hint}`);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
