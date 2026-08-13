#!/usr/bin/env node

// Workspace cloud credential encryption, migration, and fail-closed checks.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPostgres, prepareDatabase, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "keel-workspace-secrets-"));
const databasePath = path.join(scratch, "workspace-secrets.db");
const databaseUrl = isPostgres()
  ? process.env.DATABASE_URL
  : `file:${databasePath.split(path.sep).join("/")}`;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL credential test");
const sidecarPath = path.join(scratch, ".keel-server-secrets.key");
const masterKey = Buffer.alloc(32, 19).toString("base64url");

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

async function expectCredentialError(name, fn, code) {
  try {
    await fn();
    check(name, false, "operation unexpectedly succeeded");
  } catch (error) {
    check(
      name,
      error instanceof workspaceSecrets.WorkspaceCredentialError && error.code === code,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function statSafe(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

delete process.env.NOPIN_SERVER_SECRET_KEY;
process.env.KEEL_SERVER_SECRET_KEY = masterKey;
process.env.DATABASE_URL = databaseUrl;
prepareDatabase(root, databaseUrl);
register("./ts-loader.mjs", import.meta.url);

const workspaceSecrets = await import(
  pathToFileURL(path.join(root, "src/lib/workspace-secrets.ts")).href
);
const { snapshotWorkspace } = await import(
  pathToFileURL(path.join(root, "src/lib/backup.ts")).href
);
const { listCloudBackups } = await import(
  pathToFileURL(path.join(root, "src/lib/cloud.ts")).href
);
const { syncOneNote } = await import(
  pathToFileURL(path.join(root, "src/lib/onenote.ts")).href
);
const prisma = await testPrisma(root, databaseUrl);
const originalFetch = globalThis.fetch;

try {
  const user = await prisma.user.create({
    data: {
      email: "workspace-secrets@example.test",
      username: "workspace-secrets",
      name: "Workspace Secrets",
      passwordHash: "test-only",
    },
  });
  const workspaceA = await prisma.workspace.create({
    data: { name: "A", ownerId: user.id },
  });
  const workspaceB = await prisma.workspace.create({
    data: { name: "B", ownerId: user.id },
  });
  await prisma.page.create({
    data: {
      workspaceId: workspaceA.id,
      title: "Ordinary note",
      content: '{"type":"doc","content":[]}',
      createdById: user.id,
    },
  });

  console.log("\nProvider- and workspace-bound envelopes\n");
  const examples = {
    google: "google-refresh-example-value",
    onedrive: "microsoft-refresh-example-value",
    azure:
      "https://store.blob.core.windows.net/keel?sv=2025-01-01&sp=rlw&sig=example-signature",
    r2: JSON.stringify({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "keel-backups",
      accessKeyId: "example-access-key",
      secretKey: "example-r2-secret",
    }),
    oneNote: "onenote-refresh-example-value",
  };
  const sealed = Object.fromEntries(
    Object.entries(examples).map(([kind, value]) => [
      kind,
      workspaceSecrets.sealWorkspaceCredential(workspaceA.id, kind, value),
    ])
  );
  for (const [kind, plaintext] of Object.entries(examples)) {
    check(
      `${kind} is stored as an authenticated encrypted envelope`,
      workspaceSecrets.isSealedWorkspaceCredential(sealed[kind]) &&
        workspaceSecrets.openWorkspaceCredential(workspaceA.id, kind, sealed[kind]) ===
          plaintext &&
        !sealed[kind].includes(plaintext) &&
        !sealed[kind].includes(masterKey)
    );
  }
  check(
    "an explicit master key never creates a SQLite sidecar",
    !statSafe(sidecarPath)
  );
  await expectCredentialError(
    "a cloud envelope cannot be moved to another workspace",
    () => workspaceSecrets.openWorkspaceCredential(workspaceB.id, "google", sealed.google),
    "corrupt"
  );
  await expectCredentialError(
    "a cloud envelope cannot be relabeled as another provider",
    () => workspaceSecrets.openWorkspaceCredential(workspaceA.id, "onedrive", sealed.google),
    "corrupt"
  );
  await expectCredentialError(
    "an R2 envelope cannot be relabeled as Azure",
    () => workspaceSecrets.openWorkspaceCredential(workspaceA.id, "azure", sealed.r2),
    "corrupt"
  );
  await expectCredentialError(
    "a caller cannot load a credential under a stale provider",
    () =>
      workspaceSecrets.loadWorkspaceCredential(
        {
          id: workspaceA.id,
          cloudProvider: "google",
          cloudRefreshToken: sealed.onedrive,
        },
        "onedrive"
      ),
    "not-connected"
  );
  const tampered = `${sealed.google.slice(0, -1)}${sealed.google.endsWith("A") ? "B" : "A"}`;
  await expectCredentialError(
    "tampered ciphertext fails authentication",
    () => workspaceSecrets.openWorkspaceCredential(workspaceA.id, "google", tampered),
    "corrupt"
  );

  console.log("\nLegacy plaintext migration\n");
  for (const kind of ["google", "onedrive", "azure", "r2"]) {
    const plaintext = examples[kind];
    await prisma.workspace.update({
      where: { id: workspaceA.id },
      data: { cloudProvider: kind, cloudRefreshToken: plaintext },
    });
    const loaded = await workspaceSecrets.loadWorkspaceCredential(
      { id: workspaceA.id, cloudProvider: kind, cloudRefreshToken: plaintext },
      kind
    );
    const row = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceA.id },
      select: { cloudRefreshToken: true },
    });
    check(
      `${kind} legacy plaintext is atomically backfilled before use`,
      loaded.value === plaintext &&
        loaded.migrated &&
        row.cloudRefreshToken === loaded.storedValue &&
        workspaceSecrets.isSealedWorkspaceCredential(row.cloudRefreshToken) &&
        !row.cloudRefreshToken.includes(plaintext)
    );
  }

  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: { oneNoteRefreshToken: examples.oneNote, oneNoteEnabled: true },
  });
  const loadedOneNote = await workspaceSecrets.loadWorkspaceCredential(
    { id: workspaceA.id, oneNoteRefreshToken: examples.oneNote },
    "oneNote"
  );
  let storedWorkspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceA.id },
  });
  check(
    "OneNote legacy plaintext is atomically backfilled before use",
    loadedOneNote.value === examples.oneNote &&
      workspaceSecrets.isSealedWorkspaceCredential(storedWorkspace.oneNoteRefreshToken) &&
      !storedWorkspace.oneNoteRefreshToken.includes(examples.oneNote)
  );

  console.log("\nEncrypted rotation and fail-closed key handling\n");
  const onedriveOriginal = workspaceSecrets.sealWorkspaceCredential(
    workspaceA.id,
    "onedrive",
    examples.onedrive
  );
  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: { cloudProvider: "onedrive", cloudRefreshToken: onedriveOriginal },
  });
  const rotatedToken = "microsoft-rotated-refresh-example";
  await workspaceSecrets.rotateWorkspaceCredential(
    workspaceA.id,
    "onedrive",
    onedriveOriginal,
    rotatedToken
  );
  storedWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceA.id } });
  check(
    "a provider-rotated cloud token is persisted only as ciphertext",
    workspaceSecrets.isSealedWorkspaceCredential(storedWorkspace.cloudRefreshToken) &&
      !storedWorkspace.cloudRefreshToken.includes(rotatedToken) &&
      workspaceSecrets.openWorkspaceCredential(
        workspaceA.id,
        "onedrive",
        storedWorkspace.cloudRefreshToken
      ) === rotatedToken
  );
  const afterRotation = storedWorkspace.cloudRefreshToken;
  await expectCredentialError(
    "a stale rotation cannot overwrite a reconnect",
    () =>
      workspaceSecrets.rotateWorkspaceCredential(
        workspaceA.id,
        "onedrive",
        onedriveOriginal,
        "stale-rotation"
      ),
    "storage"
  );
  check(
    "a refused stale rotation leaves the current ciphertext unchanged",
    (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceA.id } }))
      .cloudRefreshToken === afterRotation
  );
  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: { cloudProvider: "google" },
  });
  await expectCredentialError(
    "a rotation cannot cross a concurrent provider change",
    () =>
      workspaceSecrets.rotateWorkspaceCredential(
        workspaceA.id,
        "onedrive",
        afterRotation,
        "wrong-provider-rotation"
      ),
    "storage"
  );
  check(
    "a refused cross-provider rotation leaves the ciphertext unchanged",
    (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceA.id } }))
      .cloudRefreshToken === afterRotation
  );
  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: { cloudProvider: "onedrive" },
  });
  await workspaceSecrets.rotateWorkspaceCredential(
    workspaceA.id,
    "oneNote",
    storedWorkspace.oneNoteRefreshToken,
    "onenote-rotated-refresh-example"
  );
  storedWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceA.id } });
  check(
    "a provider-rotated OneNote token is persisted only as ciphertext",
    workspaceSecrets.isSealedWorkspaceCredential(storedWorkspace.oneNoteRefreshToken) &&
      !storedWorkspace.oneNoteRefreshToken.includes("onenote-rotated-refresh-example")
  );

  console.log("\nProvider refresh call sites\n");
  process.env.GOOGLE_CLIENT_ID =
    "123456789012-workspace-secrets.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "example-workspace-google-client-secret";
  process.env.MS_CLIENT_ID = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  process.env.MS_CLIENT_SECRET = "example-workspace-microsoft-client-secret";
  process.env.NOPIN_UPLOAD_DIR = path.join(scratch, "uploads");

  let activeRefreshProvider = "google";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: "google-access-token",
        refresh_token: "google-refresh-token-from-provider",
      });
    }
    if (url.includes("login.microsoftonline.com") && url.endsWith("/token")) {
      return Response.json({
        access_token: `${activeRefreshProvider}-access-token`,
        refresh_token: `${activeRefreshProvider}-refresh-token-from-provider`,
      });
    }
    if (url.includes("googleapis.com/drive/v3/files")) {
      return Response.json({ files: [] });
    }
    if (url.includes("graph.microsoft.com/v1.0/me/drive/special/approot/children")) {
      return Response.json({ value: [] });
    }
    if (
      url.includes("graph.microsoft.com/v1.0/me/onenote/notebooks") ||
      url.includes("graph.microsoft.com/v1.0/me/onenote/sections")
    ) {
      return Response.json({ value: [] });
    }
    throw new Error(`Unexpected mocked provider request: ${url}`);
  };

  for (const provider of ["google", "onedrive"]) {
    activeRefreshProvider = provider;
    const original = workspaceSecrets.sealWorkspaceCredential(
      workspaceA.id,
      provider,
      `${provider}-original-refresh-token`
    );
    await prisma.workspace.update({
      where: { id: workspaceA.id },
      data: {
        cloudProvider: provider,
        cloudRefreshToken: original,
        cloudFolderId: provider === "google" ? "known-drive-folder" : null,
      },
    });
    await listCloudBackups({
      id: workspaceA.id,
      cloudProvider: provider,
      cloudRefreshToken: original,
      cloudFolderId: provider === "google" ? "known-drive-folder" : null,
    });
    const rotated = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceA.id },
      select: { cloudRefreshToken: true },
    });
    check(
      `${provider} refresh responses rotate the database value as ciphertext`,
      workspaceSecrets.isSealedWorkspaceCredential(rotated.cloudRefreshToken) &&
        workspaceSecrets.openWorkspaceCredential(
          workspaceA.id,
          provider,
          rotated.cloudRefreshToken
        ) === `${provider}-refresh-token-from-provider` &&
        !rotated.cloudRefreshToken.includes(`${provider}-refresh-token-from-provider`)
    );
  }

  activeRefreshProvider = "onenote";
  const oneNoteBeforeProviderRefresh = workspaceSecrets.sealWorkspaceCredential(
    workspaceA.id,
    "oneNote",
    "onenote-original-refresh-token"
  );
  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: {
      oneNoteRefreshToken: oneNoteBeforeProviderRefresh,
      oneNoteEnabled: true,
    },
  });
  await syncOneNote(workspaceA.id);
  const oneNoteAfterProviderRefresh = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceA.id },
    select: { oneNoteRefreshToken: true },
  });
  check(
    "OneNote refresh responses rotate the database value as ciphertext",
    workspaceSecrets.isSealedWorkspaceCredential(
      oneNoteAfterProviderRefresh.oneNoteRefreshToken
    ) &&
      workspaceSecrets.openWorkspaceCredential(
        workspaceA.id,
        "oneNote",
        oneNoteAfterProviderRefresh.oneNoteRefreshToken
      ) === "onenote-refresh-token-from-provider" &&
      !oneNoteAfterProviderRefresh.oneNoteRefreshToken.includes(
        "onenote-refresh-token-from-provider"
      )
  );
  globalThis.fetch = originalFetch;

  const protectedGoogle = workspaceSecrets.sealWorkspaceCredential(
    workspaceA.id,
    "google",
    examples.google
  );
  await prisma.workspace.update({
    where: { id: workspaceA.id },
    data: { cloudProvider: "google", cloudRefreshToken: protectedGoogle },
  });
  delete process.env.KEEL_SERVER_SECRET_KEY;
  await expectCredentialError(
    "a missing host key fails cloud credential access closed",
    () =>
      workspaceSecrets.loadWorkspaceCredential(
        {
          id: workspaceA.id,
          cloudProvider: "google",
          cloudRefreshToken: protectedGoogle,
        },
        "google"
      ),
    "key-unavailable"
  );
  check(
    "ordinary notes remain readable when the cloud key is unavailable",
    (await prisma.page.count({
      where: { workspaceId: workspaceA.id, title: "Ordinary note" },
    })) === 1
  );
  check(
    "missing-key failure never changes or exposes the stored ciphertext",
    (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceA.id } }))
      .cloudRefreshToken === protectedGoogle
  );
  process.env.KEEL_SERVER_SECRET_KEY = masterKey;

  console.log("\nCall-site and export non-exposure\n");
  const source = (file) => readFileSync(path.join(root, file), "utf8");
  const cloudCallback = source("src/app/api/cloud/callback/[provider]/route.ts");
  const oneNoteCallback = source("src/app/api/onenote/callback/route.ts");
  const azureRoute = source("src/app/api/cloud/azure/route.ts");
  const r2Route = source("src/app/api/cloud/r2/route.ts");
  const cloudLibrary = source("src/lib/cloud.ts");
  const oneNoteLibrary = source("src/lib/onenote.ts");
  check(
    "every provider seals new workspace credentials before database writes",
    cloudCallback.includes('sealWorkspaceCredential(\n          consumed.workspaceId,\n          provider,') &&
      oneNoteCallback.includes('sealWorkspaceCredential(\n          consumed.workspaceId,\n          "oneNote",') &&
      azureRoute.includes('sealWorkspaceCredential(workspace.id, "azure", sasUrl)') &&
      r2Route.includes('workspace.id,\n          "r2",')
  );
  check(
    "cloud and OneNote refresh-token rotation use encrypted compare-and-set",
    cloudLibrary.includes("rotateWorkspaceCredential(") &&
      oneNoteLibrary.includes("rotateWorkspaceCredential(") &&
      !cloudLibrary.includes("cloudRefreshToken: token.refresh_token") &&
      !oneNoteLibrary.includes("oneNoteRefreshToken: token.refresh_token")
  );
  check(
    "disconnect routes clear encrypted credential columns",
    source("src/app/api/cloud/route.ts").includes("cloudRefreshToken: null") &&
      source("src/app/api/onenote/sync/route.ts").includes("oneNoteRefreshToken: null")
  );
  check(
    "connected and Settings status checks do not decrypt credentials",
    /return Boolean\(ws\.cloudProvider && ws\.cloudRefreshToken\)/.test(cloudLibrary) &&
      !source("src/app/(workspace)/settings/page.tsx").includes("loadWorkspaceCredential") &&
      !source("src/lib/setup-guide.ts").includes("loadWorkspaceCredential")
  );
  const r2AuditTail = r2Route.slice(r2Route.indexOf('await audit("cloud.connect"'));
  const azureAuditTail = azureRoute.slice(azureRoute.indexOf('await audit("cloud.connect"'));
  check(
    "workspace credential APIs and audits never return or record submitted secrets",
    !r2AuditTail.includes("accessKeyId") &&
      !r2AuditTail.includes("secretKey") &&
      !azureAuditTail.includes("sasUrl")
  );

  const snapshot = await snapshotWorkspace(workspaceA.id);
  const exported = JSON.stringify(snapshot);
  check(
    "workspace backups omit cloud columns, ciphertext, and plaintext credentials",
    !exported.includes("cloudRefreshToken") &&
      !exported.includes("oneNoteRefreshToken") &&
      !exported.includes(protectedGoogle) &&
      Object.values(examples).every((value) => !exported.includes(value))
  );
  const rows = await prisma.workspace.findMany({
    select: { cloudRefreshToken: true, oneNoteRefreshToken: true },
  });
  const databaseCredentialRows = JSON.stringify(rows);
  check(
    "new database credential rows expose neither plaintext nor the master key",
    !databaseCredentialRows.includes(masterKey) &&
      !databaseCredentialRows.includes(examples.google) &&
      !databaseCredentialRows.includes("google-refresh-token-from-provider") &&
      !databaseCredentialRows.includes("onedrive-refresh-token-from-provider") &&
      !databaseCredentialRows.includes("onenote-refresh-token-from-provider")
  );

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.NOPIN_UPLOAD_DIR;
  delete process.env.KEEL_SERVER_SECRET_KEY;
  delete process.env.NOPIN_SERVER_SECRET_KEY;
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
}
