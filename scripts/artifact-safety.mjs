import fs from "node:fs";
import path from "node:path";

const MANAGED_SECRET_KEY_SUFFIX = ".keel-server-secrets.key";
const PRIVATE_PATTERN_FILE = ".keel-private-patterns";

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

export function assertNoSensitiveArtifactPaths(directory, artifactLabel) {
  const found = findSensitiveArtifactPaths(directory);
  if (found.length === 0) return;

  throw new Error(
    `${artifactLabel} contains a forbidden environment or managed-secret path: ${found
      .map((file) => path.relative(directory, file))
      .join(", ")}`
  );
}
