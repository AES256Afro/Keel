import fs from "node:fs";
import path from "node:path";

const MANAGED_SECRET_KEY_SUFFIX = ".keel-server-secrets.key";
const PRIVATE_PATTERN_FILE = ".keel-private-patterns";

function containedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSensitiveArtifactName(name) {
  return (
    name.startsWith(".env") ||
    name.endsWith(MANAGED_SECRET_KEY_SUFFIX) ||
    name === PRIVATE_PATTERN_FILE
  );
}

function collectSensitiveArtifactPaths(directory, found) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (isSensitiveArtifactName(entry.name)) {
      found.push(full);
    } else if (entry.isDirectory()) {
      collectSensitiveArtifactPaths(full, found);
    }
  }
}

export function findSensitiveArtifactPaths(directory) {
  const found = [];
  collectSensitiveArtifactPaths(directory, found);
  return found;
}

export function scrubSensitiveArtifactPaths(directory) {
  for (const sensitivePath of findSensitiveArtifactPaths(directory)) {
    fs.rmSync(sensitivePath, { recursive: true, force: true });
  }
}

function collectArtifactLinks(entryPath, found) {
  let metadata;
  try { metadata = fs.lstatSync(entryPath); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    found.push(entryPath);
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of fs.readdirSync(entryPath)) collectArtifactLinks(path.join(entryPath, entry), found);
}

export function findArtifactLinks(entryPath) {
  const found = [];
  collectArtifactLinks(entryPath, found);
  return found;
}

export function assertArtifactSymlinkTargetsContained(directory, artifactLabel) {
  const root = fs.realpathSync(directory);
  const invalid = [];
  for (const linkPath of findArtifactLinks(directory)) {
    let target;
    try {
      const rawTarget = fs.readlinkSync(linkPath);
      const unresolved = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget);
      target = fs.realpathSync(unresolved);
    } catch {
      invalid.push(linkPath);
      continue;
    }
    if (!containedPath(root, target)) invalid.push(linkPath);
  }
  if (invalid.length === 0) return;
  throw new Error(`${artifactLabel} contains a broken or escaping symbolic link: ${invalid.map((file) => path.relative(directory, file)).join(", ")}`);
}

export function copyArtifactTreeDereferenced(from, to, artifactLabel) {
  assertArtifactSymlinkTargetsContained(from, artifactLabel);
  const sourceRoot = fs.realpathSync(from);
  const activeDirectories = new Set();

  function copyEntry(source, destination) {
    const sourceMetadata = fs.lstatSync(source);
    if (sourceMetadata.isSymbolicLink()) {
      const rawTarget = fs.readlinkSync(source);
      const unresolved = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(source), rawTarget);
      const target = fs.realpathSync(unresolved);
      if (!containedPath(sourceRoot, target)) throw new Error(`${artifactLabel} symbolic link escaped during materialization`);
      copyEntry(target, destination);
      return;
    }
    if (sourceMetadata.isDirectory()) {
      const identity = fs.realpathSync(source);
      if (activeDirectories.has(identity)) throw new Error(`${artifactLabel} contains a symbolic-link directory cycle`);
      activeDirectories.add(identity);
      fs.mkdirSync(destination, { recursive: true, mode: sourceMetadata.mode & 0o777 });
      for (const entry of fs.readdirSync(source)) copyEntry(path.join(source, entry), path.join(destination, entry));
      fs.chmodSync(destination, sourceMetadata.mode & 0o777);
      activeDirectories.delete(identity);
      return;
    }
    if (!sourceMetadata.isFile()) throw new Error(`${artifactLabel} contains an unsupported special file`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, sourceMetadata.mode & 0o777);
  }

  copyEntry(from, to);
}

export function assertNoArtifactLinks(directory, artifactLabel) {
  const found = findArtifactLinks(directory);
  if (found.length === 0) return;
  throw new Error(`${artifactLabel} contains a symbolic link after assembly: ${found.map((file) => path.relative(directory, file)).join(", ")}`);
}

export function assertNoSensitiveArtifactPaths(directory, artifactLabel) {
  const found = findSensitiveArtifactPaths(directory);
  if (found.length === 0) return;

  throw new Error(
    `${artifactLabel} contains a forbidden environment or managed-secret path: ${found
      .map((file) => path.relative(directory, file))
      .join(", ")}`
  );
}
