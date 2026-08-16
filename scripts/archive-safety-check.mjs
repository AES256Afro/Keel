#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const archivePattern = /^keel-[0-9]+\.[0-9]+\.[0-9]+-(?:linux|macos)-[a-z0-9]+$/;
const maxCompressedBytes = 1024 * 1024 * 1024;
const maxMembers = 100000;

function fixedTar(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  if (result.status !== 0 || result.signal || result.stderr.trim()) throw new Error("Release archive listing failed or emitted diagnostics");
  return result.stdout;
}

function archiveLines(output) {
  return output.split("\n").filter((line) => line.length > 0);
}

export function inspectReleaseArchive(archive, { tarBinary = "/usr/bin/tar", runTar = fixedTar } = {}) {
  const metadata = fs.lstatSync(archive);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maxCompressedBytes) throw new Error("Release archive must be one bounded regular file");
  const expectedRoot = path.basename(archive).replace(/\.tar\.gz$/, "");
  if (!archivePattern.test(expectedRoot) || `${expectedRoot}.tar.gz` !== path.basename(archive)) throw new Error("Release archive name is not a supported Keel platform artifact");

  const names = archiveLines(runTar(tarBinary, ["-tzf", archive]));
  if (names.length < 1 || names.length > maxMembers) throw new Error("Release archive member count is outside the fixed limit");
  for (const name of names) {
    if (name.length > 4096 || name.includes("\\") || name.startsWith("/") || name.includes("\0")) throw new Error("Release archive contains an unsafe member path");
    const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
    const components = normalized.split("/");
    if (!normalized || components.some((component) => component === "" || component === "." || component === "..") || components[0] !== expectedRoot) throw new Error("Release archive contains a path outside its exact root");
  }

  const verbose = archiveLines(runTar(tarBinary, ["-tvzf", archive]));
  if (verbose.length !== names.length) throw new Error("Release archive listing count changed between inspections");
  const rejectedTypes = verbose.filter((line) => !["-", "d"].includes(line[0]));
  if (rejectedTypes.length) throw new Error("Release archive contains a link or special member");
  return { safe: true, root: expectedRoot, members: names.length, regularFiles: verbose.filter((line) => line[0] === "-").length, directories: verbose.filter((line) => line[0] === "d").length, links: 0, specialMembers: 0 };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error("Archive safety inspection accepts exactly one release tarball path");
    process.exitCode = 64;
  } else {
    try {
      const result = inspectReleaseArchive(path.resolve(process.argv[2]));
      console.log(`Archive safety verified ${result.members} regular-or-directory members beneath ${result.root}; links and special members: 0`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
