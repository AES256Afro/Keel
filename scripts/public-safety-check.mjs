#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root }
).toString().split("\0").filter(Boolean);
const files = [...new Set(listed)].filter((name) => fs.existsSync(path.join(root, name)));
const errors = [];

// Project-specific private identifiers must never be embedded in this tracked
// guard: doing so would publish the very metadata it is meant to catch. Local
// operators and CI can provide newline-separated literal strings through an
// ignored file or environment variable instead. Literal matching is enough
// here and avoids treating privately supplied values as executable regexes.
const privatePatternFile = path.join(root, ".keel-private-patterns");
const privateLiterals = [
  ...(fs.existsSync(privatePatternFile)
    ? fs.readFileSync(privatePatternFile, "utf8").split(/\r?\n/)
    : []),
  ...(process.env.KEEL_PRIVATE_PATTERNS ?? "").split(/\r?\n/),
]
  .map((value) => value.trim())
  .filter((value) => value && !value.startsWith("#"));

const forbiddenPaths = [
  { pattern: /(^|\/)\.env(?:\.|$)/, allow: /\.example$/, reason: "runtime environment file" },
  { pattern: /(^|\/)[^/]*\.keel-server-secrets\.key$/, reason: "managed-credential master key" },
  { pattern: /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx)$/i, reason: "database or private-key material" },
  { pattern: /^(?:backups|node_modules|\.next|dist|dist-desktop)(\/|$)/, reason: "runtime or build artifact" },
];

const forbiddenContent = [
  { pattern: /tail[0-9a-f]{8,}\.ts\.net/i, reason: "private tailnet hostname" },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, reason: "absolute macOS user path" },
];

for (const name of files) {
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(name) && !(rule.allow?.test(name))) {
      errors.push(`${name}: forbidden ${rule.reason}`);
    }
  }

  const full = path.join(root, name);
  const stat = fs.statSync(full);
  if (stat.size > 10 * 1024 * 1024) errors.push(`${name}: tracked file exceeds 10 MB`);
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (text.includes("\u2014")) errors.push(`${name}: contains a Unicode em dash`);
  const lowerText = text.toLowerCase();
  for (const literal of privateLiterals) {
    if (lowerText.includes(literal.toLowerCase())) {
      errors.push(`${name}: contains an operator-supplied private identifier`);
    }
  }
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(text)) errors.push(`${name}: contains ${rule.reason}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.license !== "BUSL-1.1") errors.push("package.json: license must be BUSL-1.1");
for (const required of ["LICENSE", "LICENSING.md", "SECURITY.md", "CONTRIBUTING.md", "TRADEMARKS.md"]) {
  if (!files.includes(required)) errors.push(`${required}: required publication file is missing`);
}

console.log(`Checked ${files.length} publication files.`);
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log("Public-release path, content, artifact, and license guards passed.");
