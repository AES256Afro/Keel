#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoSensitiveArtifactPaths,
  findSensitiveArtifactPaths,
  scrubSensitiveArtifactPaths,
} from "./artifact-safety.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel-artifact-safety-"));

try {
  const nested = path.join(scratch, "server", "nested");
  fs.mkdirSync(path.join(nested, ".env.d"), { recursive: true });
  fs.writeFileSync(path.join(scratch, ".env"), "test fixture\n");
  fs.writeFileSync(path.join(nested, ".env.production"), "test fixture\n");
  fs.writeFileSync(path.join(nested, ".env.d", "credential"), "test fixture\n");
  fs.writeFileSync(
    path.join(nested, "keel.db.keel-server-secrets.key"),
    "test fixture\n"
  );
  fs.writeFileSync(path.join(nested, ".keel-private-patterns"), "test fixture\n");
  fs.writeFileSync(path.join(nested, "runtime.json"), "{}\n");

  const found = findSensitiveArtifactPaths(scratch).map((file) =>
    path.relative(scratch, file).split(path.sep).join("/")
  );
  assert.deepEqual(found.sort(), [
    ".env",
    "server/nested/.env.d",
    "server/nested/.env.production",
    "server/nested/.keel-private-patterns",
    "server/nested/keel.db.keel-server-secrets.key",
  ]);
  assert.throws(
    () => assertNoSensitiveArtifactPaths(scratch, "fixture artifact"),
    /contains a forbidden environment or managed-secret path/
  );

  scrubSensitiveArtifactPaths(scratch);
  assertNoSensitiveArtifactPaths(scratch, "fixture artifact");
  assert.equal(fs.existsSync(path.join(nested, "runtime.json")), true);

  const packageSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "package-release.mjs"),
    "utf8"
  );
  const desktopSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "desktop-build.mjs"),
    "utf8"
  );
  for (const [label, source] of [
    ["release", packageSource],
    ["desktop", desktopSource],
  ]) {
    assert.match(source, /scrubSensitiveArtifactPaths\(/, `${label} build must scrub`);
    assert.match(source, /assertNoSensitiveArtifactPaths\(/, `${label} build must fail closed`);
  }

  console.log("Artifact environment and managed-secret scrubbing checks passed.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
