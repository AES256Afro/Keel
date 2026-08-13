#!/usr/bin/env node
// Claim instance-wide administration from the machine that hosts Keel.
//
// Registration and ownership are intentionally separate. Anyone permitted by
// the access policy may register while registration is open, but only a local
// operator who confirms control through the operating system can create the
// immutable instance.ownerUserId setting.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

export const INSTANCE_OWNER_KEY = "instance.ownerUserId";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export class ClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimError";
  }
}

export function normalizeClaimToken(value) {
  const token = String(value ?? "").trim();
  if (!/^keel_claim_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new ClaimError("paste a current claim token from Keel Settings, Welcome, or Setup");
  }
  return token;
}

export function hashClaimToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new ClaimError(`${label} does not exist: ${file}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ClaimError(`${label} must be a regular file, not a link or directory: ${file}`);
  }
  const resolved = fs.realpathSync(file);
  if (resolved !== path.resolve(file)) {
    throw new ClaimError(`${label} may not pass through a symbolic link: ${file}`);
  }
  return { contents: fs.readFileSync(file, "utf8"), stat, resolved };
}

function envAssignments(contents) {
  const values = [];
  const pattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/;
  for (const line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.push([match[1], value]);
  }
  return values;
}

function databasePathFromUrl(url, platform, relativeBase) {
  if (!url.startsWith("file:")) {
    throw new ClaimError(
      "claim currently supports a local SQLite database only; hosted PostgreSQL deployments must use KEEL_OWNER_USER_ID or KEEL_OWNER_BOOTSTRAP_TOKEN"
    );
  }
  const value = url.slice("file:".length);
  if (!value || /[?#]/.test(value)) {
    throw new ClaimError("DATABASE_URL must name one absolute SQLite database file");
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.isAbsolute(value)) return pathApi.normalize(value);
  if (!relativeBase) {
    throw new ClaimError("DATABASE_URL must use an absolute file: path before this server can be claimed");
  }
  return pathApi.resolve(relativeBase, value);
}

/** Resolve the exact configuration and database the operator is about to
 * claim. This is exported so hostile path shapes stay covered by unit tests. */
export function resolveClaimTarget({
  envFile,
  defaultDatabase,
  relativeDatabaseBase,
  platform = process.platform,
  processEnvironment = process.env,
}) {
  // Match Keel startup precedence exactly: real process variables win, then
  // an explicit KEEL_ENV_FILE, then the install's ordinary .env. Each file
  // fills only keys that are still undefined. This matters for DATABASE_URL
  // and OWNER_USER_ID: claiming any other database would be a security bug.
  const effective = { ...processEnvironment };
  const explicitEnvFile =
    (effective.KEEL_ENV_FILE && String(effective.KEEL_ENV_FILE)) ||
    (effective.NOPIN_ENV_FILE && String(effective.NOPIN_ENV_FILE)) ||
    null;
  const candidates = [explicitEnvFile, envFile].filter(Boolean).map((file) => path.resolve(file));
  const envPaths = [];
  for (const candidate of [...new Set(candidates)]) {
    if (!fs.existsSync(candidate)) continue;
    const loaded = readRegularFile(candidate, "Keel environment file");
    envPaths.push(loaded.resolved);
    const assignments = envAssignments(loaded.contents);
    // A duplicate database declaration is too ambiguous to authorize when
    // the process did not already pin the effective value.
    if (
      effective.DATABASE_URL === undefined &&
      assignments.filter(([key]) => key === "DATABASE_URL").length > 1
    ) {
      throw new ClaimError("an environment file contains more than one DATABASE_URL; resolve the ambiguity first");
    }
    for (const [key, value] of assignments) {
      if (effective[key] === undefined) effective[key] = value;
    }
  }

  const ownerUserId =
    (effective.KEEL_OWNER_USER_ID != null && effective.KEEL_OWNER_USER_ID !== ""
      ? effective.KEEL_OWNER_USER_ID
      : effective.NOPIN_OWNER_USER_ID) ?? "";
  if (String(ownerUserId).trim()) {
    throw new ClaimError(
      "this server already uses an effective KEEL_OWNER_USER_ID for operator-managed ownership; use that account instead of claim"
    );
  }
  const databaseUrl =
    effective.DATABASE_URL !== undefined
      ? String(effective.DATABASE_URL)
      : defaultDatabase
        ? `file:${defaultDatabase}`
        : null;
  if (!databaseUrl) {
    throw new ClaimError("DATABASE_URL is missing; configure one absolute SQLite file before claiming this server");
  }
  const databasePath = databasePathFromUrl(databaseUrl, platform, relativeDatabaseBase);
  const db = readRegularFile(databasePath, "Keel database");
  return {
    databaseUrl: `file:${databasePath}`,
    databasePath,
    envPaths,
    fingerprint: `${db.stat.dev}:${db.stat.ino}`,
  };
}

async function defaultClientFactory({ appRoot, databaseUrl }) {
  const candidates = [
    path.join(appRoot, "node_modules", "@prisma", "client", "index.js"),
    path.join(appRoot, "server", "node_modules", "@prisma", "client", "index.js"),
  ];
  const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) {
    throw new ClaimError("Prisma is not installed in this Keel build; finish installation and try again");
  }
  const loaded = await import(pathToFileURL(modulePath).href);
  const PrismaClient = loaded.PrismaClient ?? loaded.default?.PrismaClient;
  if (!PrismaClient) throw new ClaimError("the installed Prisma client could not be loaded");
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function claimTokenRecord(db, tokenHash) {
  return db.instanceClaimToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      expiresAt: true,
      user: { select: { id: true, email: true, username: true } },
    },
  });
}

function requireUsableToken(record, now = new Date()) {
  if (!record) throw new ClaimError("this claim token is invalid, expired, replaced, or already used");
  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    throw new ClaimError("this claim token expired; generate a new one in Keel and try again");
  }
  return record;
}

/** Authenticate machine control. No password is read by Keel and no shell is
 * involved. sudo or Windows validates the credential directly. */
export function authorizeMachineControl({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  run = spawnSync,
  containerMarker = fs.existsSync("/.dockerenv"),
  containerClaim = process.env.KEEL_CONTAINER_CLAIM === "1",
} = {}) {
  if (!tty) throw new ClaimError("claim must be run interactively from a terminal");

  if (platform === "win32") {
    const script =
      "$p=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent();" +
      "if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 0}else{exit 1}";
    const result = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "inherit", windowsHide: true }
    );
    if (result.status !== 0) {
      throw new ClaimError("reopen PowerShell as Administrator, then run this claim command again");
    }
    return "administrator-token";
  }

  // Container images intentionally do not carry sudo, and the normal Keel
  // process runs as the unprivileged `node` user. A host operator may enter a
  // real Docker container as root for this one command. Requiring both the
  // container marker and an explicit per-exec flag keeps ordinary root shell
  // invocation rejected. On Linux the documented host command starts with a
  // fresh sudo authorization; Docker Desktop users confirm daemon control.
  if (platform === "linux" && uid === 0 && containerMarker && containerClaim) {
    return "container-root";
  }
  if (uid === 0) {
    throw new ClaimError("run claim as your normal user, not as root; sudo will ask for confirmation");
  }
  if (!fs.existsSync("/usr/bin/sudo")) {
    throw new ClaimError("/usr/bin/sudo is required to confirm control of this machine");
  }
  const invalidate = run("/usr/bin/sudo", ["-k"], { stdio: "inherit" });
  if (invalidate.status !== 0) throw new ClaimError("sudo could not reset its cached authorization");
  const validate = run("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
  if (validate.status !== 0) throw new ClaimError("sudo confirmation was cancelled or failed; the server was not claimed");
  return "sudo";
}

/** Docker exec starts this one command as root to prove daemon control, but
 * SQLite must never be opened as root: creating a root-owned WAL or SHM file
 * would break the normal unprivileged Keel process. Confirm the narrow Docker
 * gate, then permanently drop to the image's `node` account before Prisma is
 * loaded or the database is opened. */
export function prepareContainerClaimAuthorization({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  containerMarker = fs.existsSync("/.dockerenv"),
  containerClaim = process.env.KEEL_CONTAINER_CLAIM === "1",
  setgid = process.setgid?.bind(process),
  setuid = process.setuid?.bind(process),
} = {}) {
  if (!(platform === "linux" && uid === 0 && containerMarker && containerClaim)) {
    return null;
  }
  const method = authorizeMachineControl({
    platform,
    uid,
    tty,
    containerMarker,
    containerClaim,
  });
  if (!setgid || !setuid) {
    throw new ClaimError("this container cannot drop root privileges; no claim was written");
  }
  try {
    setgid("node");
    setuid("node");
  } catch {
    throw new ClaimError("could not drop to the container's node account; no claim was written");
  }
  return method;
}

async function existingClaim(db) {
  return db.appSetting.findUnique({ where: { key: INSTANCE_OWNER_KEY }, select: { value: true } });
}

async function consumeClaimToken(db, tokenHash, expected, method) {
  try {
    return await db.$transaction(async (tx) => {
      const token = requireUsableToken(await claimTokenRecord(tx, tokenHash));
      const user = token.user;
      if (token.id !== expected.tokenId || user.id !== expected.user.id) {
        throw new ClaimError("the claim token changed while authorization was in progress; no claim was written");
      }
      const current = await existingClaim(tx);
      if (current) {
        if (current.value === user.id) {
          await tx.instanceClaimToken.deleteMany({});
          return { status: "already-claimed", user };
        }
        throw new ClaimError("this server is already claimed by a different account; claims cannot be replaced");
      }
      await tx.appSetting.create({
        data: { key: INSTANCE_OWNER_KEY, value: user.id },
      });
      await tx.instanceClaimToken.deleteMany({});
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          actor: user.username ?? user.email,
          action: "instance.claim",
          target: user.email,
          detail: JSON.stringify({ confirmation: method }),
          ip: null,
        },
      });
      return { status: "claimed", user };
    });
  } catch (error) {
    if (error instanceof ClaimError) throw error;
    // Two local terminals may finish sudo together. The unique AppSetting key
    // is the arbiter; treat the same winner as idempotent and every other
    // winner as immutable.
    const current = await existingClaim(db).catch(() => null);
    if (current?.value === expected.user.id) return { status: "already-claimed", user: expected.user };
    if (current) throw new ClaimError("this server was claimed by a different account; claims cannot be replaced");
    throw error;
  }
}

/** Full claim flow with explicit dependencies for tests. The production entry
 * below never accepts a skip-auth flag or environment bypass. */
export async function runClaimFlow(options, dependencies = {}) {
  const plaintextToken = normalizeClaimToken(options.token);
  const tokenHash = hashClaimToken(plaintextToken);
  const print = dependencies.print ?? ((line) => console.log(line));
  const createClient = dependencies.createClient ?? defaultClientFactory;
  const authorize = dependencies.authorize ?? (() => authorizeMachineControl());
  const resolveTarget = dependencies.resolveTarget ?? resolveClaimTarget;
  const targetOptions = {
    envFile: options.envFile,
    defaultDatabase: options.defaultDatabase,
    relativeDatabaseBase: options.relativeDatabaseBase,
    platform: options.platform ?? process.platform,
    processEnvironment: options.processEnvironment ?? process.env,
  };
  const target = resolveTarget(targetOptions);
  const db = await createClient({ appRoot: options.appRoot, databaseUrl: target.databaseUrl });
  try {
    const token = requireUsableToken(await claimTokenRecord(db, tokenHash));
    const user = token.user;
    const current = await existingClaim(db);
    if (current && current.value !== user.id) {
      throw new ClaimError("this server is already claimed by a different account; claims cannot be replaced");
    }

    print(`Email:    ${user.email}`);
    print(`Username: ${user.username ?? "(not set)"}`);
    print(`Account:  ${user.id}`);
    print(`Database: ${target.databasePath}`);
    print("Keel will now ask the operating system to confirm control of this machine.");
    const method = await authorize();

    // Re-read both path and database state after the interactive pause. A file
    // swap or account replacement during sudo must not redirect the claim.
    const after = resolveTarget(targetOptions);
    if (
      JSON.stringify(after.envPaths) !== JSON.stringify(target.envPaths) ||
      after.databasePath !== target.databasePath ||
      after.fingerprint !== target.fingerprint
    ) {
      throw new ClaimError("the Keel configuration or database changed during authorization; no claim was written");
    }
    const result = await consumeClaimToken(
      db,
      tokenHash,
      { tokenId: token.id, user },
      method
    );
    print(
      result.status === "claimed"
        ? `Claimed this Keel server for ${user.email}. Registration remains unchanged.`
        : `${user.email} already owns this Keel server. Registration remains unchanged.`
    );
    return { ...result, databasePath: target.databasePath };
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

export async function runClaimCommand(options) {
  const containerMethod = prepareContainerClaimAuthorization();
  return runClaimFlow(
    options,
    containerMethod ? { authorize: async () => containerMethod } : {}
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: npm run claim -- keel_claim_TOKEN

Sign in to Keel and generate a five-minute claim token in Welcome, Setup, or
Settings. This command displays the exact account and SQLite database bound to
the token, asks the operating system to confirm machine control, then consumes
the token to record immutable ownership. It does not close registration.`);
    if (args.length !== 1) process.exitCode = 1;
    return;
  }
  await runClaimCommand({
    token: args[0],
    appRoot: root,
    envFile: path.join(root, ".env"),
    // Prisma resolves a relative SQLite URL from the directory containing its
    // schema, not from the shell's cwd.
    relativeDatabaseBase: path.join(root, "prisma"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Claim failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
