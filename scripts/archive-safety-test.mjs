#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectReleaseArchive } from "./archive-safety-check.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel-archive-safety-"));

try {
  const goodRoot = path.join(scratch, "keel-1.2.6-linux-x64");
  fs.mkdirSync(path.join(goodRoot, "server"), { recursive: true });
  fs.writeFileSync(path.join(goodRoot, "server", "server.js"), "safe fixture\n");
  const goodArchive = path.join(scratch, "keel-1.2.6-linux-x64.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", goodArchive, "-C", scratch, path.basename(goodRoot)]);
  assert.deepEqual(inspectReleaseArchive(goodArchive), { safe: true, root: "keel-1.2.6-linux-x64", members: 3, regularFiles: 1, directories: 2, links: 0, specialMembers: 0 });

  const linkRoot = path.join(scratch, "keel-1.2.6-macos-arm64");
  fs.mkdirSync(path.join(linkRoot, "server"), { recursive: true });
  fs.writeFileSync(path.join(linkRoot, "server", "target.js"), "target\n");
  fs.symlinkSync("target.js", path.join(linkRoot, "server", "linked.js"));
  const linkArchive = path.join(scratch, "keel-1.2.6-macos-arm64.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", linkArchive, "-C", scratch, path.basename(linkRoot)]);
  assert.throws(() => inspectReleaseArchive(linkArchive), /link or special member/);

  const renamedArchive = path.join(scratch, "release.tar.gz");
  fs.copyFileSync(goodArchive, renamedArchive);
  assert.throws(() => inspectReleaseArchive(renamedArchive), /name is not a supported/);
  console.log("Release archive path, root, link, special-member, and naming checks passed.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
