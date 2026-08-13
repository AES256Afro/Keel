#!/usr/bin/env node

// Portable CLI regression checks for the SQLite managed-secret master key.
// The database and key must move together without key material entering output,
// permissive files, symlinks, or an unrelated destination bundle.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "keel.mjs");
const cliSource = fs.readFileSync(cli, "utf8");
const desktopBuild = fs.readFileSync(path.join(root, "scripts", "desktop-build.mjs"), "utf8");
const releaseBuild = fs.readFileSync(path.join(root, "scripts", "package-release.mjs"), "utf8");
const artifactSafety = fs.readFileSync(path.join(root, "scripts", "artifact-safety.mjs"), "utf8");
const dockerIgnore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel-cli-secret-portability-"));
const keyA = Buffer.alloc(32, 0x2a);
const keyB = Buffer.alloc(32, 0x6b);
const secretForms = [
  keyA.toString("base64url"),
  keyA.toString("hex"),
  keyB.toString("base64url"),
  keyB.toString("hex"),
];

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function makeHome(name, database = null, key = null, environmentKey = null) {
  const home = path.join(scratch, name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = ["PORT=65439"];
  if (environmentKey) env.push(`KEEL_SERVER_SECRET_KEY=${environmentKey.toString("base64url")}`);
  fs.writeFileSync(path.join(home, ".env"), `${env.join("\n")}\n`, { mode: 0o600 });
  if (database !== null) fs.writeFileSync(path.join(home, "keel.db"), database);
  if (key) writeKey(path.join(home, ".keel-server-secrets.key"), key);
  return home;
}

function writeKey(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${key.toString("base64url")}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function readKey(file) {
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
}

function modeIs600(file) {
  return process.platform === "win32" || (fs.statSync(file).mode & 0o777) === 0o600;
}

function modeIs700(file) {
  return process.platform === "win32" || (fs.statSync(file).mode & 0o777) === 0o700;
}

function runCli(home, args) {
  const env = { ...process.env, KEEL_HOME: home, PORT: "65439" };
  for (const name of [
    "KEEL_SERVER_SECRET_KEY",
    "NOPIN_SERVER_SECRET_KEY",
    "KEEL_ENV_FILE",
    "NOPIN_ENV_FILE",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  check(
    `${args[0]} output contains no managed-secret key material`,
    secretForms.every((secret) => !output.includes(secret))
  );
  return { ...result, output };
}

function databaseBackups(home) {
  return fs
    .readdirSync(home)
    .filter(
      (name) =>
        name.startsWith("keel.db.pre-import-") &&
        !name.endsWith("-wal") &&
        !name.endsWith("-shm") &&
        !name.endsWith(".keel-server-secrets.key")
    )
    .map((name) => path.join(home, name));
}

try {
  console.log("\nCLI managed-secret portability\n");

  check(
    "detached CLI logs are forced to mode 0600",
    cliSource.includes('fs.openSync(LOG_FILE, "a", 0o600)') &&
      cliSource.includes("fs.fchmodSync(log, 0o600)")
  );
  check(
    "the CLI reserves and repairs its live SQLite database at mode 0600",
    cliSource.includes("process.umask(0o077)") &&
      cliSource.includes('fs.openSync(DB_FILE, "a", 0o600)') &&
      cliSource.includes("fs.fchmodSync(database, 0o600)")
  );

  check(
    "shared artifact guard recognizes live and exported managed-secret keys",
    artifactSafety.includes('const MANAGED_SECRET_KEY_SUFFIX = ".keel-server-secrets.key"') &&
      artifactSafety.includes("name.endsWith(MANAGED_SECRET_KEY_SUFFIX)")
  );
  check(
    "desktop assembly scrubs traced environment and managed-secret paths",
    desktopBuild.includes("scrubSensitiveArtifactPaths(standalone)")
  );
  check(
    "desktop assembly recursively refuses a key anywhere in the server bundle",
    desktopBuild.includes('assertNoSensitiveArtifactPaths(standalone, "desktop server bundle")')
  );
  check(
    "release assembly recursively refuses a key anywhere in its artifact",
    releaseBuild.includes('assertNoSensitiveArtifactPaths(out, "release")')
  );
  check(
    "Docker build context excludes live and exported managed-secret keys at any depth",
    dockerIgnore.split(/\r?\n/).includes("**/.keel-server-secrets.key") &&
      dockerIgnore.split(/\r?\n/).includes("**/*.keel-server-secrets.key")
  );

  const homeA = makeHome("home-a", "DATABASE-A", keyA);
  const exportsDir = path.join(scratch, "exports");
  fs.mkdirSync(exportsDir);
  const exported = path.join(exportsDir, "keel-a.db");
  const exportedKey = `${exported}.keel-server-secrets.key`;
  let result = runCli(homeA, ["export", exported]);
  check("export succeeds", result.status === 0, result.output);
  check("export copies the database", fs.readFileSync(exported, "utf8") === "DATABASE-A");
  check("exported note database is mode 0600", modeIs600(exported));
  check("export writes a database-specific key companion", readKey(exportedKey).equals(keyA));
  check("exported key companion is mode 0600", modeIs600(exportedKey));

  const privateUploadsHome = makeHome("private-uploads", "DATABASE-UPLOADS");
  const sourceUploads = path.join(privateUploadsHome, "uploads", "workspace-a");
  fs.mkdirSync(sourceUploads, { recursive: true });
  fs.writeFileSync(path.join(sourceUploads, "image.png"), "IMAGE", { mode: 0o644 });
  const privateExport = path.join(exportsDir, "private.db");
  result = runCli(privateUploadsHome, ["export", privateExport]);
  check("export with uploads succeeds", result.status === 0, result.output);
  check("exported uploads root is mode 0700", modeIs700(`${privateExport}.uploads`));
  check(
    "exported uploads subdirectories are mode 0700",
    modeIs700(path.join(`${privateExport}.uploads`, "workspace-a"))
  );
  check(
    "exported upload files are mode 0600",
    modeIs600(path.join(`${privateExport}.uploads`, "workspace-a", "image.png"))
  );

  const conflictExport = path.join(exportsDir, "conflict.db");
  fs.writeFileSync(conflictExport, "DO-NOT-OVERWRITE");
  writeKey(`${conflictExport}.keel-server-secrets.key`, keyB);
  result = runCli(homeA, ["export", conflictExport]);
  check("export refuses a different destination key", result.status !== 0);
  check(
    "a key conflict is detected before the destination database changes",
    fs.readFileSync(conflictExport, "utf8") === "DO-NOT-OVERWRITE"
  );
  check("export key conflict message gives an explicit recovery choice", /choose another target|remove that companion/.test(result.output));

  const homeWithEnvironmentKey = makeHome("home-environment", "DATABASE-ENV", keyB, keyA);
  const environmentExport = path.join(exportsDir, "environment.db");
  result = runCli(homeWithEnvironmentKey, ["export", environmentExport]);
  check("export with an environment master key succeeds", result.status === 0, result.output);
  check(
    "the environment master key wins over a stale local sidecar",
    readKey(`${environmentExport}.keel-server-secrets.key`).equals(keyA)
  );

  const dockerDir = path.join(scratch, "docker-a");
  result = runCli(homeA, ["to-docker", dockerDir]);
  const dockerKey = path.join(dockerDir, "data", ".keel-server-secrets.key");
  check("to-docker succeeds", result.status === 0, result.output);
  check("to-docker copies the database", fs.readFileSync(path.join(dockerDir, "data", "keel.db"), "utf8") === "DATABASE-A");
  check("to-docker installs the runtime key beside the database", readKey(dockerKey).equals(keyA));
  check("to-docker key is mode 0600", modeIs600(dockerKey));
  check("to-docker environment copy is mode 0600", modeIs600(path.join(dockerDir, ".env.keel")));
  check(
    "to-docker keeps its host-side import seed private",
    process.platform === "win32" || (fs.statSync(path.join(dockerDir, "data")).mode & 0o777) === 0o700
  );
  const generatedCompose = fs.readFileSync(path.join(dockerDir, "docker-compose.yml"), "utf8");
  check(
    "to-docker imports through a read-only seed into a named volume",
    generatedCompose.includes("./data:/staged:ro") &&
      generatedCompose.includes("keel-data:/data") &&
      !generatedCompose.includes("./data:/data")
  );
  check(
    "to-docker bootstrap repairs volume ownership before the node app starts",
    generatedCompose.includes("chown -R 1000:1000 /data") &&
      generatedCompose.includes("condition: service_completed_successfully")
  );
  check(
    "to-docker refuses to merge into an unexpected non-empty volume",
    generatedCompose.includes("Refusing to import into a non-empty unmarked Keel volume")
  );
  check(
    "to-docker preserves dollar signs in environment values",
    generatedCompose.includes("format: raw")
  );
  check(
    "generated Compose contains no managed-secret key material",
    secretForms.every((secret) => !generatedCompose.includes(secret))
  );
  const generatedIgnore = fs.readFileSync(path.join(dockerDir, ".gitignore"), "utf8");
  check(
    "to-docker excludes its private seed and environment from source control",
    generatedIgnore.split(/\r?\n/).includes("data/") &&
      generatedIgnore.split(/\r?\n/).includes(".env.keel") &&
      modeIs600(path.join(dockerDir, ".gitignore"))
  );
  const composeAvailable = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  }).status === 0;
  if (composeAvailable) {
    const composeCheck = spawnSync(
      "docker",
      ["compose", "-f", path.join(dockerDir, "docker-compose.yml"), "config", "--quiet"],
      { cwd: dockerDir, encoding: "utf8" }
    );
    check(
      "generated to-docker Compose passes Docker's parser",
      composeCheck.status === 0,
      `${composeCheck.stdout ?? ""}${composeCheck.stderr ?? ""}`.trim()
    );
  }

  const conflictDocker = path.join(scratch, "docker-conflict");
  fs.mkdirSync(path.join(conflictDocker, "data"), { recursive: true });
  fs.writeFileSync(path.join(conflictDocker, "data", "keel.db"), "DOCKER-DO-NOT-OVERWRITE");
  writeKey(path.join(conflictDocker, "data", ".keel-server-secrets.key"), keyB);
  result = runCli(homeA, ["to-docker", conflictDocker]);
  check("to-docker refuses a different destination key", result.status !== 0);
  check(
    "to-docker detects a key conflict before replacing its database",
    fs.readFileSync(path.join(conflictDocker, "data", "keel.db"), "utf8") ===
      "DOCKER-DO-NOT-OVERWRITE"
  );

  const homeB = makeHome("home-b", "DATABASE-B", keyB);
  result = runCli(homeB, ["import", exported]);
  check("import succeeds", result.status === 0, result.output);
  check("import restores the database", fs.readFileSync(path.join(homeB, "keel.db"), "utf8") === "DATABASE-A");
  check(
    "import atomically installs the matching runtime key",
    readKey(path.join(homeB, ".keel-server-secrets.key")).equals(keyA)
  );
  check("imported runtime key is mode 0600", modeIs600(path.join(homeB, ".keel-server-secrets.key")));
  const firstBackups = databaseBackups(homeB);
  check("import preserves the outgoing database", firstBackups.length === 1, firstBackups.join(", "));
  const priorDatabase = firstBackups[0];
  check(
    "import preserves the outgoing key with its database backup",
    readKey(`${priorDatabase}.keel-server-secrets.key`).equals(keyB)
  );
  check("backed-up key companion is mode 0600", modeIs600(`${priorDatabase}.keel-server-secrets.key`));

  result = runCli(homeB, ["import", priorDatabase]);
  check("a pre-import backup is itself portable", result.status === 0, result.output);
  check("restoring the backup restores its database", fs.readFileSync(path.join(homeB, "keel.db"), "utf8") === "DATABASE-B");
  check("restoring the backup restores its key", readKey(path.join(homeB, ".keel-server-secrets.key")).equals(keyB));

  const legacyDatabase = path.join(exportsDir, "legacy-without-key.db");
  fs.writeFileSync(legacyDatabase, "LEGACY-DATABASE");
  result = runCli(homeB, ["import", legacyDatabase]);
  check("a legacy database without a key companion still imports", result.status === 0, result.output);
  check("legacy import keeps the current key rather than deleting it", readKey(path.join(homeB, ".keel-server-secrets.key")).equals(keyB));
  check("legacy import reports its key behavior", result.output.includes("current local key was kept"));

  const hiddenFallbackDirectory = path.join(scratch, "hidden-fallback");
  fs.mkdirSync(hiddenFallbackDirectory);
  const arbitraryDatabase = path.join(hiddenFallbackDirectory, "arbitrary.db");
  fs.writeFileSync(arbitraryDatabase, "ARBITRARY-DATABASE");
  writeKey(path.join(hiddenFallbackDirectory, ".keel-server-secrets.key"), keyA);
  const arbitraryHome = makeHome("home-arbitrary");
  result = runCli(arbitraryHome, ["import", arbitraryDatabase]);
  check("an arbitrary database does not inherit a directory-wide hidden key", result.status === 0, result.output);
  check(
    "hidden-key fallback is reserved for the Docker runtime database name",
    !fs.existsSync(path.join(arbitraryHome, ".keel-server-secrets.key"))
  );

  const environmentLockedHome = makeHome("home-env-import", "ENV-DATABASE", null, keyB);
  result = runCli(environmentLockedHome, ["import", exported]);
  check("import refuses a key that conflicts with the environment override", result.status !== 0);
  check(
    "environment-key mismatch is detected before the live database changes",
    fs.readFileSync(path.join(environmentLockedHome, "keel.db"), "utf8") === "ENV-DATABASE"
  );
  check("environment-key refusal explains the required operator action", result.output.includes("update or remove that environment override"));

  const orphanKeyHome = makeHome("home-orphan-key", null, keyB);
  result = runCli(orphanKeyHome, ["import", exported]);
  check("import refuses to discard an orphaned different local key", result.status !== 0);
  check("orphaned local key remains unchanged", readKey(path.join(orphanKeyHome, ".keel-server-secrets.key")).equals(keyB));
  check("orphan-key refusal explains explicit recovery", result.output.includes("move or remove that key explicitly"));

  const exactCompanionHome = makeHome("home-exact-companion");
  result = runCli(exactCompanionHome, ["import", path.join(dockerDir, "data", "keel.db")]);
  check("import accepts the runtime hidden companion used by Docker", result.status === 0, result.output);
  check(
    "the Docker-form companion installs as the local runtime key",
    readKey(path.join(exactCompanionHome, ".keel-server-secrets.key")).equals(keyA)
  );

  if (process.platform !== "win32") {
    const linkedDatabase = path.join(exportsDir, "linked.db");
    const linkedKey = `${linkedDatabase}.keel-server-secrets.key`;
    fs.writeFileSync(linkedDatabase, "LINKED-DATABASE");
    fs.symlinkSync(path.join(homeA, ".keel-server-secrets.key"), linkedKey);
    const linkedHome = makeHome("home-linked");
    result = runCli(linkedHome, ["import", linkedDatabase]);
    check("import rejects a symlinked managed-secret companion", result.status !== 0);
    check("symlink refusal happens before a live database is created", !fs.existsSync(path.join(linkedHome, "keel.db")));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
