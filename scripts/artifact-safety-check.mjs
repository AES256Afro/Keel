#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertArtifactSymlinkTargetsContained,
  assertNoArtifactLinks,
  assertNoSensitiveArtifactPaths,
  copyArtifactTreeDereferenced,
  findArtifactLinks,
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

  const source = path.join(scratch, "link-source");
  const copy = path.join(scratch, "link-copy");
  fs.mkdirSync(path.join(source, "real"), { recursive: true });
  fs.writeFileSync(path.join(source, "real", "runtime.js"), "safe fixture\n");
  fs.symlinkSync(path.join(source, "real"), path.join(source, "absolute-contained-link"));
  assert.equal(findArtifactLinks(source).length, 1);
  assert.doesNotThrow(() => assertArtifactSymlinkTargetsContained(source, "contained fixture"));
  copyArtifactTreeDereferenced(source, copy, "contained fixture");
  assertNoArtifactLinks(copy, "dereferenced fixture");
  assert.equal(fs.readFileSync(path.join(copy, "absolute-contained-link", "runtime.js"), "utf8"), "safe fixture\n");

  const outside = path.join(scratch, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(source, "escaping-link"));
  assert.throws(() => assertArtifactSymlinkTargetsContained(source, "escaping fixture"), /broken or escaping symbolic link/);
  assert.throws(() => assertNoArtifactLinks(source, "linked fixture"), /contains a symbolic link after assembly/);
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
  assert.match(packageSource, /copyArtifactTreeDereferenced\(standalone, server/, "release build must dereference only contained standalone links");
  assert.match(packageSource, /assertNoArtifactLinks\(out, "release"\)/, "release build must reject every assembled link");
  assert.match(packageSource, /archive-safety-check\.mjs/, "release build must inspect the completed tarball before publication");

  console.log("Artifact environment and managed-secret scrubbing checks passed.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
