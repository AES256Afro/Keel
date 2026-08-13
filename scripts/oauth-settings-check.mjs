#!/usr/bin/env node
// Encrypted owner-managed OAuth configuration regression checks.
//
// Uses an isolated SQLite database even when the broader CI job also has a
// PostgreSQL service. The storage guarantees under test include the local
// no-symlink 0600 key file, while KEEL_SERVER_SECRET_KEY separately covers the
// container/PostgreSQL key path.
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDatabase, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "keel-oauth-settings-"));
const databasePath = path.join(scratch, "oauth.db");
const databaseUrl = `file:${databasePath.split(path.sep).join("/")}`;
const keyPath = path.join(scratch, ".keel-server-secrets.key");
const explicitKey = Buffer.alloc(32, 7).toString("base64url");
const googleId = "123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const googleSecret = "GOCSPX-example-secret-one";
const googleSecretTwo = "GOCSPX-example-secret-two";
const microsoftId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const microsoftSecret = "microsoft-example-secret";

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

function clearEnvironment() {
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
    "KEEL_SERVER_SECRET_KEY",
    "NOPIN_SERVER_SECRET_KEY",
  ]) {
    delete process.env[name];
  }
}

clearEnvironment();
process.env.DATABASE_URL = databaseUrl;
prepareDatabase(root, databaseUrl);
register("./ts-loader.mjs", import.meta.url);

const settings = await import(pathToFileURL(path.join(root, "src/lib/oauth-settings.ts")).href);
const oauth = await import(pathToFileURL(path.join(root, "src/lib/oauth.ts")).href);
const secrets = await import(pathToFileURL(path.join(root, "src/lib/server-secrets.ts")).href);
const prisma = await testPrisma(root, databaseUrl);
const originalFetch = globalThis.fetch;

try {
  console.log("\nOAuth state transport protection\n");
  const googleAuthRouteSource = readFileSync(
    path.join(root, "src/app/api/auth/google/route.ts"),
    "utf8"
  );
  const cloudConnectRouteSource = readFileSync(
    path.join(root, "src/app/api/cloud/connect/route.ts"),
    "utf8"
  );
  const productionSecureCookie = (source, name) =>
    new RegExp(
      `cookies\\.set\\(\\"${name}\\"[\\s\\S]{0,300}?secure:\\s*process\\.env\\.NODE_ENV\\s*===\\s*\\"production\\"`
    ).test(source);
  check(
    "Google sign-in state cookies are Secure in production",
    productionSecureCookie(googleAuthRouteSource, "keel-oauth-state")
  );
  check(
    "Google desktop handoff cookies are Secure in production",
    productionSecureCookie(googleAuthRouteSource, "keel-oauth-desktop")
  );
  check(
    "cloud OAuth state is server-side and bound to the signed-in session",
    cloudConnectRouteSource.includes("issueOAuthConnectionState({") &&
      cloudConnectRouteSource.includes("activeRequestSession(req, user.id)") &&
      !cloudConnectRouteSource.includes('cookies.set("keel-oauth-state"')
  );

  console.log("\nEmpty state and explicit master key\n");
  let status = await settings.getOAuthProviderStatus("google");
  check("an empty provider is not configured", status.status === "not-configured" && status.source === "none");
  check("an empty provider resolves no OAuth credential", (await settings.resolveOAuthCredentials("google")) === null);

  process.env.KEEL_SERVER_SECRET_KEY = explicitKey;
  status = await settings.saveOAuthProviderSettings("google", {
    clientId: googleId,
    clientSecret: googleSecret,
  });
  check(
    "a saved pair is managed and marked not yet verified",
    status.configured &&
      status.source === "managed" &&
      status.status === "configured-not-verified" &&
      status.verified === false &&
      status.verifiedAt === null
  );
  check("an explicit environment master key does not create a local key file", !statSafe(keyPath));

  const googleKeys = [
    secrets.serverSecretSettingKey("oauth.google.clientId"),
    secrets.serverSecretSettingKey("oauth.google.clientSecret"),
  ];
  let rows = await prisma.appSetting.findMany({ where: { key: { in: googleKeys } } });
  const stored = JSON.stringify(rows);
  check("the database stores two encrypted settings", rows.length === 2);
  check(
    "database ciphertext contains neither the client ID nor secret",
    !stored.includes(googleId) && !stored.includes(googleSecret)
  );
  check("ciphertext uses a versioned AES-GCM envelope", rows.every((row) => row.value.includes('"alg":"A256GCM"')));

  delete process.env.KEEL_SERVER_SECRET_KEY;
  status = await settings.getOAuthProviderStatus("google");
  check("missing master key fails a stored pair closed", !status.configured && status.status === "unavailable");
  check("missing master key never returns credentials", (await settings.resolveOAuthCredentials("google")) === null);
  process.env.KEEL_SERVER_SECRET_KEY = explicitKey;

  console.log("\nImmediate runtime resolution\n");
  const authUrl = await oauth.buildAuthUrl({
    provider: "google",
    redirectUri: "https://notes.example.test/api/auth/google/callback",
    scope: oauth.LOGIN_SCOPE,
    state: "state-value",
  });
  check("the authorization URL uses the managed client ID", new URL(authUrl).searchParams.get("client_id") === googleId);
  check("the authorization URL never contains the client secret", !authUrl.includes(googleSecret));

  await settings.saveOAuthProviderSettings("google", { clientSecret: googleSecretTwo });
  let tokenBody = "";
  globalThis.fetch = async (_url, init) => {
    tokenBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ access_token: "test-access" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  await oauth.exchangeCode("google", "code", "https://notes.example.test/api/auth/google/callback");
  check("a managed secret update is used immediately without restart", new URLSearchParams(tokenBody).get("client_secret") === googleSecretTwo);
  check("a partial managed update preserves the existing client ID", new URLSearchParams(tokenBody).get("client_id") === googleId);
  status = await settings.getOAuthProviderStatus("google");
  check(
    "a successful authorization-code exchange verifies the current pair",
    status.status === "verified" && status.verified && typeof status.verifiedAt === "string"
  );
  const verificationRows = await prisma.appSetting.findMany({
    where: { key: { startsWith: "oauth.google." } },
    select: { value: true },
  });
  check(
    "verification markers contain no client ID or client secret",
    !JSON.stringify(verificationRows).includes(googleId) &&
      !JSON.stringify(verificationRows).includes(googleSecretTwo)
  );

  let releaseTokenResponse;
  let noteTokenRequestStarted;
  const tokenRequestStarted = new Promise((resolve) => {
    noteTokenRequestStarted = resolve;
  });
  const tokenResponseGate = new Promise((resolve) => {
    releaseTokenResponse = resolve;
  });
  globalThis.fetch = async () => {
    noteTokenRequestStarted();
    await tokenResponseGate;
    return new Response(JSON.stringify({ access_token: "delayed-access" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const delayedExchange = oauth.exchangeCode(
    "google",
    "delayed-code",
    "https://notes.example.test/api/auth/google/callback"
  );
  await tokenRequestStarted;
  await settings.saveOAuthProviderSettings("google", { clientSecret: googleSecretTwo });
  releaseTokenResponse();
  await delayedExchange;
  status = await settings.getOAuthProviderStatus("google");
  check(
    "a response for an older configuration cannot verify a newly saved revision",
    status.status === "configured-not-verified" && !status.verified
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ access_token: "current-access" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  await oauth.exchangeCode("google", "current-code", "https://notes.example.test/api/auth/google/callback");
  check(
    "the current configuration can be verified after a stale response is ignored",
    (await settings.getOAuthProviderStatus("google")).verified
  );

  await settings.saveOAuthProviderSettings("google", { clientSecret: googleSecretTwo });
  let tokenRequestHadTimeout = false;
  globalThis.fetch = async (_url, init) => {
    tokenRequestHadTimeout = init?.signal instanceof AbortSignal;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  let missingAccessTokenError = "";
  try {
    await oauth.exchangeCode(
      "google",
      "malformed-success-code",
      "https://notes.example.test/api/auth/google/callback"
    );
  } catch (error) {
    missingAccessTokenError = error instanceof Error ? error.message : String(error);
  }
  check(
    "a 200 token response without an access token is rejected",
    missingAccessTokenError.includes("provider returned no access token"),
    missingAccessTokenError
  );
  check("token exchange requests carry a bounded timeout", tokenRequestHadTimeout);
  status = await settings.getOAuthProviderStatus("google");
  check(
    "a malformed token response never marks credentials verified",
    status.status === "configured-not-verified" && !status.verified && status.verifiedAt === null
  );
  globalThis.fetch = originalFetch;

  console.log("\nEnvironment priority and lock\n");
  process.env.GOOGLE_CLIENT_ID = "999999999999-environment.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "example-environment-client-secret";
  status = await settings.getOAuthProviderStatus("google");
  const resolvedEnvironment = await settings.resolveOAuthCredentials("google");
  check(
    "an environment pair overrides managed values without inheriting managed verification",
    status.locked &&
      status.source === "environment" &&
      !status.verified &&
      status.verifiedAt === null &&
      resolvedEnvironment?.source === "environment"
  );
  await expectSettingsError(
    "environment credentials lock managed saves",
    () => settings.saveOAuthProviderSettings("google", { clientSecret: "another-secret" }),
    409
  );
  await expectSettingsError(
    "environment credentials lock managed clears",
    () => settings.clearOAuthProviderSettings("google"),
    409
  );
  delete process.env.GOOGLE_CLIENT_SECRET;
  status = await settings.getOAuthProviderStatus("google");
  check("a partial environment pair fails closed instead of falling back", status.locked && status.status === "incomplete" && !(await settings.resolveOAuthCredentials("google")));
  delete process.env.GOOGLE_CLIENT_ID;
  status = await settings.getOAuthProviderStatus("google");
  check(
    "removing the environment override reveals the current unverified managed pair",
    (await settings.resolveOAuthCredentials("google"))?.source === "managed" &&
      status.status === "configured-not-verified" &&
      !status.verified
  );

  await settings.saveOAuthProviderSettings("google", { clientSecret: googleSecret });
  status = await settings.getOAuthProviderStatus("google");
  check(
    "saving either managed field clears prior verification",
    status.status === "configured-not-verified" && !status.verified && status.verifiedAt === null
  );
  check(
    "saving removes the prior verification marker",
    !(await prisma.appSetting.findUnique({ where: { key: "oauth.google.verifiedAt" } }))
  );

  console.log("\nAuthentication and tamper resistance\n");
  rows = await prisma.appSetting.findMany({ where: { key: { in: googleKeys } }, orderBy: { key: "asc" } });
  await prisma.$transaction([
    prisma.appSetting.update({ where: { key: rows[0].key }, data: { value: rows[1].value } }),
    prisma.appSetting.update({ where: { key: rows[1].key }, data: { value: rows[0].value } }),
  ]);
  status = await settings.getOAuthProviderStatus("google");
  check("swapping ciphertext between setting keys fails AAD authentication", status.status === "unavailable" && !(await settings.resolveOAuthCredentials("google")));
  await expectSettingsError(
    "a damaged pair cannot be partially preserved",
    () => settings.saveOAuthProviderSettings("google", { clientSecret: googleSecret }),
    400
  );
  await settings.saveOAuthProviderSettings("google", { clientId: googleId, clientSecret: googleSecret });
  check("entering both fields recovers from damaged ciphertext", Boolean(await settings.resolveOAuthCredentials("google")));

  console.log("\nLocal key file safety\n");
  await settings.clearOAuthProviderSettings("google");
  delete process.env.KEEL_SERVER_SECRET_KEY;
  await settings.saveOAuthProviderSettings("microsoft", {
    clientId: microsoftId,
    clientSecret: microsoftSecret,
  });
  const keyStat = statSync(keyPath);
  check("SQLite managed credentials create a regular key file", keyStat.isFile() && !keyStat.isSymbolicLink());
  if (process.platform !== "win32") {
    check("the local master key is mode 0600", (keyStat.mode & 0o777) === 0o600, (keyStat.mode & 0o777).toString(8));
  }
  check("the local key file is outside and distinct from the database", keyPath !== databasePath && !readFileSync(keyPath, "utf8").includes(microsoftSecret));

  if (process.platform !== "win32") {
    await settings.clearOAuthProviderSettings("microsoft");
    rmSync(keyPath, { force: true });
    const target = path.join(scratch, "symlink-target");
    writeFileSync(target, `${explicitKey}\n`, { mode: 0o600 });
    symlinkSync(target, keyPath);
    await expectSettingsError(
      "a symbolic-link key path is refused",
      () => settings.saveOAuthProviderSettings("microsoft", { clientId: microsoftId, clientSecret: microsoftSecret }),
      400
    );
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) console.log(`  \x1b[31m✗\x1b[0m ${failure}`);
    process.exitCode = 1;
  }
} finally {
  globalThis.fetch = originalFetch;
  clearEnvironment();
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
}

function statSafe(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

async function expectSettingsError(name, fn, expectedStatus) {
  try {
    await fn();
    check(name, false, "operation unexpectedly succeeded");
  } catch (error) {
    check(name, error instanceof settings.OAuthSettingsError && error.status === expectedStatus, String(error));
  }
}
