#!/usr/bin/env node
// Regression checks for browser-bound, operating-system-confirmed claims.

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { register } from "node:module";
import {
  ClaimError,
  INSTANCE_OWNER_KEY,
  authorizeMachineControl,
  prepareContainerClaimAuthorization,
  resolveClaimTarget,
  runClaimFlow,
} from "./claim-instance.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOKEN = `keel_claim_${"A".repeat(43)}`;
const OTHER_TOKEN = `keel_claim_${"B".repeat(43)}`;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const owner = { id: "user-owner", email: "owner@example.test", username: "owner" };
const other = { id: "user-other", email: "other@example.test", username: "other" };

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

async function rejects(name, fn, pattern) {
  try {
    await fn();
    check(name, false, "did not refuse");
  } catch (error) {
    check(name, error instanceof ClaimError && pattern.test(error.message), error.message);
  }
}

function fakeDatabase({ tokens = [], settings = [] } = {}) {
  const state = {
    tokens: new Map(tokens.map((row) => [row.tokenHash, { ...row }])),
    settings: new Map(settings.map((row) => [row.key, { ...row }])),
    audit: [],
  };
  const db = {
    instanceClaimToken: {
      findUnique: async ({ where }) => {
        const row = state.tokens.get(where.tokenHash);
        if (!row) return null;
        return {
          id: row.id,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          user: { ...row.user },
        };
      },
      deleteMany: async () => {
        const count = state.tokens.size;
        state.tokens.clear();
        return { count };
      },
    },
    appSetting: {
      findUnique: async ({ where }) => {
        const row = state.settings.get(where.key);
        return row ? { value: row.value } : null;
      },
      create: async ({ data }) => {
        if (state.settings.has(data.key)) {
          const error = new Error("unique");
          error.code = "P2002";
          throw error;
        }
        state.settings.set(data.key, { ...data });
        return data;
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        state.audit.push({ ...data });
        return data;
      },
    },
    $transaction: async (fn) => fn(db),
    $disconnect: async () => {},
  };
  return { db, state };
}

const future = () => new Date(Date.now() + 60_000);
const tokenRow = (token = TOKEN, user = owner, overrides = {}) => ({
  id: overrides.id ?? `token-${user.id}`,
  tokenHash: hash(token),
  expiresAt: overrides.expiresAt ?? future(),
  user,
});
const target = {
  databaseUrl: "file:/srv/keel/data/keel.db",
  databasePath: "/srv/keel/data/keel.db",
  envPaths: ["/srv/keel/.env"],
  fingerprint: "1:2",
};
const flow = (database, overrides = {}) =>
  runClaimFlow(
    {
      token: overrides.token ?? TOKEN,
      appRoot: root,
      envFile: "/srv/keel/.env",
      processEnvironment: {},
    },
    {
      createClient: async () => database.db,
      resolveTarget: overrides.resolveTarget ?? (() => target),
      authorize: overrides.authorize ?? (async () => "sudo"),
      print: overrides.print ?? (() => {}),
    }
  );

console.log("\nToken binding and authorization ordering\n");
await rejects(
  "an email address cannot be used as a claim selector",
  () => flow(fakeDatabase(), { token: owner.email }),
  /claim token/
);
{
  const database = fakeDatabase();
  let authorized = false;
  await rejects(
    "an unknown token is refused before operating-system authorization",
    () => flow(database, { authorize: async () => { authorized = true; return "sudo"; } }),
    /invalid, expired, replaced, or already used/
  );
  check("unknown-token refusal never invokes sudo", !authorized);
  check("unknown-token refusal writes no claim or audit", database.state.settings.size === 0 && database.state.audit.length === 0);
}
{
  const database = fakeDatabase({
    tokens: [tokenRow(TOKEN, owner, { expiresAt: new Date(Date.now() - 1) })],
  });
  let authorized = false;
  await rejects(
    "an expired token is refused before sudo",
    () => flow(database, { authorize: async () => { authorized = true; return "sudo"; } }),
    /expired/
  );
  check("expired-token refusal never invokes sudo", !authorized);
}
{
  const database = fakeDatabase({
    tokens: [tokenRow()],
    settings: [
      { key: "access.signupDisabled", value: "false" },
      { key: "access.allowedEmails", value: "[]" },
    ],
  });
  const registrationBefore = JSON.stringify([...database.state.settings]);
  const output = [];
  let beforeAuth = false;
  const result = await flow(database, {
    print: (line) => output.push(line),
    authorize: async () => {
      beforeAuth = !database.state.settings.has(INSTANCE_OWNER_KEY) && database.state.audit.length === 0;
      return "sudo";
    },
  });
  check("the token displays its bound email, username, and account id before sudo", output.slice(0, 3).join("\n") === "Email:    owner@example.test\nUsername: owner\nAccount:  user-owner");
  check("nothing is mutated before successful OS authorization", beforeAuth);
  check("the stable token-bound user id becomes owner", database.state.settings.get(INSTANCE_OWNER_KEY)?.value === owner.id);
  check("successful consumption deletes all outstanding tokens", database.state.tokens.size === 0);
  check("successful consumption writes one claim audit event", database.state.audit.length === 1 && database.state.audit[0].action === "instance.claim");
  check("the flow reports claimed without accepting an email input", result.status === "claimed" && result.user.id === owner.id);
  check(
    "claim leaves registration AppSettings unchanged",
    JSON.stringify([...database.state.settings].filter(([key]) => key !== INSTANCE_OWNER_KEY)) === registrationBefore
  );
  await rejects(
    "the same plaintext token cannot be used twice",
    () => flow(database),
    /invalid, expired, replaced, or already used/
  );
}
{
  const database = fakeDatabase({ tokens: [tokenRow()] });
  await rejects(
    "cancelled sudo leaves the token and instance untouched",
    () => flow(database, { authorize: async () => { throw new ClaimError("sudo confirmation was cancelled"); } }),
    /cancelled/
  );
  check("cancelled sudo writes nothing and leaves token reusable", database.state.settings.size === 0 && database.state.audit.length === 0 && database.state.tokens.size === 1);
}
{
  const database = fakeDatabase({ tokens: [tokenRow()] });
  await rejects(
    "a token consumed or replaced during sudo is refused",
    () => flow(database, { authorize: async () => { database.state.tokens.clear(); return "sudo"; } }),
    /invalid, expired, replaced, or already used/
  );
  check("a token race writes no owner", !database.state.settings.has(INSTANCE_OWNER_KEY));
}
{
  const database = fakeDatabase({
    tokens: [tokenRow(), tokenRow(OTHER_TOKEN, other)],
  });
  const result = await flow(database, { token: OTHER_TOKEN });
  check("the presented token chooses its bound account, never an email argument", result.user.id === other.id && database.state.settings.get(INSTANCE_OWNER_KEY)?.value === other.id);
}
{
  const database = fakeDatabase({
    tokens: [tokenRow()],
    settings: [{ key: INSTANCE_OWNER_KEY, value: "somebody-else" }],
  });
  let authorized = false;
  await rejects(
    "an existing different claim is immutable",
    () => flow(database, { authorize: async () => { authorized = true; return "sudo"; } }),
    /different account/
  );
  check("a different existing claim is refused before sudo", !authorized);
}
{
  const database = fakeDatabase({ tokens: [tokenRow()] });
  let calls = 0;
  await rejects(
    "a database swap during sudo is refused",
    () => flow(database, {
      resolveTarget: () => ({ ...target, fingerprint: ++calls === 1 ? "1:2" : "1:3" }),
    }),
    /changed during authorization/
  );
  check("a swapped database receives no claim and consumes no token", database.state.settings.size === 0 && database.state.tokens.size === 1);
}

console.log("\nOperating-system confirmation\n");
{
  const calls = [];
  const method = authorizeMachineControl({
    platform: "darwin",
    uid: 501,
    tty: true,
    run: (file, args, opts) => {
      calls.push({ file, args, opts });
      return { status: 0 };
    },
  });
  check(
    "macOS/Linux invalidates cached sudo then validates without a shell",
    method === "sudo" && calls.length === 2 &&
      calls[0].file === "/usr/bin/sudo" && calls[0].args.join(" ") === "-k" &&
      calls[1].file === "/usr/bin/sudo" && calls[1].args.join(" ") === "-v" &&
      calls.every((call) => call.opts.stdio === "inherit" && call.opts.shell === undefined)
  );
}
await rejects(
  "claim refuses a non-interactive terminal",
  () => Promise.resolve(authorizeMachineControl({ platform: "darwin", uid: 501, tty: false })),
  /interactively/
);
await rejects(
  "claim refuses direct root execution",
  () => Promise.resolve(authorizeMachineControl({ platform: "darwin", uid: 0, tty: true })),
  /normal user/
);
{
  const method = authorizeMachineControl({
    platform: "linux",
    uid: 0,
    tty: true,
    containerMarker: true,
    containerClaim: true,
  });
  check("an explicit interactive root exec inside Docker confirms daemon control", method === "container-root");
}
{
  const calls = [];
  const method = prepareContainerClaimAuthorization({
    platform: "linux",
    uid: 0,
    tty: true,
    containerMarker: true,
    containerClaim: true,
    setgid: (value) => calls.push(["gid", value]),
    setuid: (value) => calls.push(["uid", value]),
  });
  check(
    "Docker claim drops to node before the database flow",
    method === "container-root" && JSON.stringify(calls) === '[["gid","node"],["uid","node"]]'
  );
}
check(
  "ordinary claim runtimes do not attempt a privilege drop",
  prepareContainerClaimAuthorization({
    platform: "linux",
    uid: 1000,
    tty: true,
    containerMarker: true,
    containerClaim: true,
    setgid: () => { throw new Error("unexpected"); },
    setuid: () => { throw new Error("unexpected"); },
  }) === null
);
await rejects(
  "container root without the explicit one-command flag is refused",
  () => Promise.resolve(authorizeMachineControl({
    platform: "linux",
    uid: 0,
    tty: true,
    containerMarker: true,
    containerClaim: false,
  })),
  /normal user/
);
await rejects(
  "a forged container flag outside Docker is refused",
  () => Promise.resolve(authorizeMachineControl({
    platform: "linux",
    uid: 0,
    tty: true,
    containerMarker: false,
    containerClaim: true,
  })),
  /normal user/
);
await rejects(
  "a failed sudo validation is reported as no claim",
  () => Promise.resolve(authorizeMachineControl({
    platform: "darwin",
    uid: 501,
    tty: true,
    run: (_file, args) => ({ status: args[0] === "-k" ? 0 : 1 }),
  })),
  /cancelled or failed/
);
{
  let command = null;
  const method = authorizeMachineControl({
    platform: "win32",
    tty: true,
    run: (file, args, opts) => {
      command = { file, args, opts };
      return { status: 0 };
    },
  });
  check("Windows accepts only an existing elevated Administrator token", method === "administrator-token" && command.file === "powershell.exe" && command.args.includes("-NonInteractive") && command.opts.stdio === "inherit");
}
await rejects(
  "Windows tells a standard user to reopen PowerShell as Administrator",
  () => Promise.resolve(authorizeMachineControl({ platform: "win32", tty: true, run: () => ({ status: 1 }) })),
  /reopen PowerShell as Administrator/
);

console.log("\nReal SQLite token consumption\n");
{
  const name = "claim-check-real";
  const databaseUrl = testDatabaseUrl(root, name);
  const databasePath = databaseUrl.slice("file:".length);
  const envFile = path.join(root, ".claim-check.env");
  cleanDatabase(root, name);
  prepareDatabase(root, databaseUrl);
  const seed = await testPrisma(root, databaseUrl);
  const realOwner = await seed.user.create({
    data: { email: "real.owner@example.test", name: "Real Owner", username: "real-owner" },
  });
  await seed.workspace.create({
    data: { name: "Real Owner Workspace", ownerId: realOwner.id, members: { create: { userId: realOwner.id, role: "owner" } } },
  });
  await seed.appSetting.create({ data: { key: "access.signupDisabled", value: "false" } });
  await seed.instanceClaimToken.create({
    data: { userId: realOwner.id, tokenHash: hash(TOKEN), expiresAt: future() },
  });
  await seed.$disconnect();
  fs.writeFileSync(envFile, `DATABASE_URL="${databaseUrl}"\n`, { mode: 0o600 });
  try {
    const result = await runClaimFlow(
      { token: TOKEN, appRoot: root, envFile, processEnvironment: {} },
      { authorize: async () => "sudo", print: () => {} }
    );
    const verify = await testPrisma(root, databaseUrl);
    const claimed = await verify.appSetting.findUnique({ where: { key: INSTANCE_OWNER_KEY } });
    const signup = await verify.appSetting.findUnique({ where: { key: "access.signupDisabled" } });
    const audits = await verify.auditEvent.findMany({ where: { action: "instance.claim" } });
    check("the production Prisma transaction claims the token-bound user", result.status === "claimed" && claimed?.value === realOwner.id);
    check("the production transaction consumes the token", await verify.instanceClaimToken.count() === 0);
    check("the real claim leaves registration open", signup?.value === "false");
    check("the real claim records one durable audit event", audits.length === 1 && audits[0].userId === realOwner.id);
    await verify.$disconnect();
  } finally {
    fs.rmSync(envFile, { force: true });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(databasePath + suffix, { force: true });
  }
}

console.log("\nEffective configuration and path safety\n");
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keel-claim-check-")));
  const envFile = path.join(dir, ".env");
  const explicitEnv = path.join(dir, "explicit.env");
  const dbFile = path.join(dir, "keel.db");
  const otherDb = path.join(dir, "other.db");
  fs.writeFileSync(dbFile, "", { mode: 0o600 });
  fs.writeFileSync(otherDb, "", { mode: 0o600 });
  const writeEnv = (line) => fs.writeFileSync(envFile, `${line}\n`, { mode: 0o600 });
  try {
    writeEnv(`DATABASE_URL="file:${dbFile}"`);
    let resolved = resolveClaimTarget({ envFile, processEnvironment: {} });
    check("an absolute regular SQLite target resolves exactly", resolved.databasePath === dbFile && resolved.envPaths[0] === envFile);

    resolved = resolveClaimTarget({
      envFile,
      processEnvironment: { DATABASE_URL: `file:${otherDb}` },
    });
    check("a process DATABASE_URL overrides every env file", resolved.databasePath === otherDb);

    fs.writeFileSync(explicitEnv, `DATABASE_URL="file:${otherDb}"\n`, { mode: 0o600 });
    resolved = resolveClaimTarget({ envFile, processEnvironment: { KEEL_ENV_FILE: explicitEnv } });
    check("KEEL_ENV_FILE loads before the install .env", resolved.databasePath === otherDb && resolved.envPaths.join("|") === `${explicitEnv}|${envFile}`);

    writeEnv("DATABASE_URL=file:./keel.db");
    resolved = resolveClaimTarget({ envFile, relativeDatabaseBase: dir, processEnvironment: {} });
    check("a source relative URL resolves only from its explicit schema directory", resolved.databasePath === dbFile);
    await rejects("a relative URL without an explicit schema directory is refused", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: {} })), /absolute/);

    writeEnv(`DATABASE_URL=file:${dbFile}`);
    resolved = resolveClaimTarget({ envFile, processEnvironment: { KEEL_OWNER_EMAIL: owner.email } });
    check("a legacy owner email does not block the OS-authorized claim", resolved.databasePath === dbFile);
    writeEnv(`DATABASE_URL=file:${dbFile}\nNOPIN_OWNER_EMAIL=${owner.email}`);
    resolved = resolveClaimTarget({ envFile, processEnvironment: {} });
    check("the old NOPIN owner email also stays non-authoritative", resolved.databasePath === dbFile);
    await rejects("a stable process user-id override blocks claim", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: { KEEL_OWNER_USER_ID: owner.id } })), /effective KEEL_OWNER_USER_ID/);
    writeEnv(`DATABASE_URL=file:${dbFile}\nNOPIN_OWNER_USER_ID=${owner.id}`);
    await rejects("a legacy-named stable user-id override also blocks claim", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: {} })), /effective KEEL_OWNER_USER_ID/);
    await rejects("a process PostgreSQL URL cannot be masked by a SQLite .env", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: { DATABASE_URL: "postgresql://localhost/keel" } })), /KEEL_OWNER_USER_ID|KEEL_OWNER_BOOTSTRAP_TOKEN/);

    writeEnv(`DATABASE_URL=file:${dbFile}\nDATABASE_URL=file:${otherDb}`);
    await rejects("ambiguous duplicate database configuration is refused", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: {} })), /more than one/);

    writeEnv(`DATABASE_URL=file:${dbFile}`);
    const linkedEnv = path.join(dir, "linked.env");
    fs.symlinkSync(envFile, linkedEnv);
    await rejects("a symlinked environment file is refused", () => Promise.resolve(resolveClaimTarget({ envFile: linkedEnv, processEnvironment: {} })), /regular file/);

    const linkedDb = path.join(dir, "linked.db");
    fs.symlinkSync(otherDb, linkedDb);
    writeEnv(`DATABASE_URL=file:${linkedDb}`);
    await rejects("a symlinked database is refused", () => Promise.resolve(resolveClaimTarget({ envFile, processEnvironment: {} })), /regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nBrowser-authenticated token issuance\n");
{
  const name = "claim-token-issue-check";
  const databaseUrl = testDatabaseUrl(root, name);
  cleanDatabase(root, name);
  prepareDatabase(root, databaseUrl);
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const ownerEnv = process.env.KEEL_OWNER_EMAIL;
  const legacyOwnerEnv = process.env.NOPIN_OWNER_EMAIL;
  const ownerIdEnv = process.env.KEEL_OWNER_USER_ID;
  const legacyOwnerIdEnv = process.env.NOPIN_OWNER_USER_ID;
  const bootstrapEnv = process.env.KEEL_OWNER_BOOTSTRAP_TOKEN;
  process.env.DATABASE_URL = databaseUrl;
  delete process.env.KEEL_OWNER_EMAIL;
  delete process.env.NOPIN_OWNER_EMAIL;
  delete process.env.KEEL_OWNER_USER_ID;
  delete process.env.NOPIN_OWNER_USER_ID;
  delete process.env.KEEL_OWNER_BOOTSTRAP_TOKEN;
  register("./ts-loader.mjs", import.meta.url);
  const { issueInstanceClaimToken, InstanceClaimError } = await import(
    pathToFileURL(path.join(root, "src/lib/instance-claim.ts")).href
  );
  const { prisma: singleton } = await import(
    pathToFileURL(path.join(root, "src/lib/prisma.ts")).href
  );
  try {
    const first = await singleton.user.create({
      data: { email: "first.token@example.test", name: "First", username: "first-token" },
    });
    const second = await singleton.user.create({
      data: { email: "second.token@example.test", name: "Second", username: "second-token" },
    });
    const issuedAt = Date.now();
    const firstIssue = await issueInstanceClaimToken(first.id);
    const storedFirst = await singleton.instanceClaimToken.findUnique({ where: { userId: first.id } });
    check("the browser helper returns a correctly shaped one-use token", /^keel_claim_[A-Za-z0-9_-]{43}$/.test(firstIssue.token));
    check("only the SHA-256 token digest is stored", storedFirst?.tokenHash === hash(firstIssue.token) && !JSON.stringify(storedFirst).includes(firstIssue.token));
    check("the token expires five minutes after issue", firstIssue.expiresAt.getTime() >= issuedAt + 299_000 && firstIssue.expiresAt.getTime() <= Date.now() + 301_000);

    const replacement = await issueInstanceClaimToken(first.id);
    check("a replacement invalidates the user's prior token", await singleton.instanceClaimToken.count({ where: { userId: first.id } }) === 1 && hash(replacement.token) !== storedFirst?.tokenHash);
    await issueInstanceClaimToken(second.id);
    check("different signed-in users may each request one active token while unclaimed", await singleton.instanceClaimToken.count() === 2);

    await singleton.appSetting.create({ data: { key: INSTANCE_OWNER_KEY, value: first.id } });
    let claimedRefused = false;
    try {
      await issueInstanceClaimToken(second.id);
    } catch (error) {
      claimedRefused = error instanceof InstanceClaimError && /already claimed/.test(error.message);
    }
    check("token issuance stops as soon as the server is claimed", claimedRefused);
  } finally {
    await singleton.$disconnect();
    cleanDatabase(root, name);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (ownerEnv === undefined) delete process.env.KEEL_OWNER_EMAIL;
    else process.env.KEEL_OWNER_EMAIL = ownerEnv;
    if (legacyOwnerEnv === undefined) delete process.env.NOPIN_OWNER_EMAIL;
    else process.env.NOPIN_OWNER_EMAIL = legacyOwnerEnv;
    if (ownerIdEnv === undefined) delete process.env.KEEL_OWNER_USER_ID;
    else process.env.KEEL_OWNER_USER_ID = ownerIdEnv;
    if (legacyOwnerIdEnv === undefined) delete process.env.NOPIN_OWNER_USER_ID;
    else process.env.NOPIN_OWNER_USER_ID = legacyOwnerIdEnv;
    if (bootstrapEnv === undefined) delete process.env.KEEL_OWNER_BOOTSTRAP_TOKEN;
    else process.env.KEEL_OWNER_BOOTSTRAP_TOKEN = bootstrapEnv;
  }
}

console.log("\nCLI and packaging contract\n");
{
  const cli = spawnSync(process.execPath, [path.join(root, "bin", "keel.mjs"), "help"], { encoding: "utf8" });
  const friendlyFailure = spawnSync(
    process.execPath,
    [path.join(root, "bin", "keel.mjs"), "claim", owner.email],
    { encoding: "utf8" }
  );
  const helper = spawnSync(process.execPath, [path.join(root, "scripts", "claim-instance.mjs"), "--help"], { encoding: "utf8" });
  check("keel help advertises a token, not an email selector", cli.status === 0 && /keel claim <token>/.test(cli.stdout) && !/claim <email>/.test(cli.stdout));
  check("the packaged CLI turns claim failures into a concise operator error", friendlyFailure.status === 1 && /claim failed: paste a current claim token/.test(friendlyFailure.stderr) && !/ClaimError:|at runClaim/.test(friendlyFailure.stderr));
  check("the source helper explains the short-lived GUI token", helper.status === 0 && /five-minute claim token/.test(helper.stdout));
  const releaseSource = fs.readFileSync(path.join(root, "scripts", "package-release.mjs"), "utf8");
  const desktopSource = fs.readFileSync(path.join(root, "scripts", "desktop-build.mjs"), "utf8");
  check("release packaging copies the claim helper", /scripts["'],\s*["']claim-instance\.mjs/.test(releaseSource));
  check("desktop packaging carries data migrations", /prisma["'],\s*["']migrations/.test(desktopSource));
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
  process.exitCode = 1;
}
