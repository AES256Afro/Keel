import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  decryptServerSecret,
  encryptServerSecret,
  serverSecretSettingKey,
  ServerSecretError,
} from "@/lib/server-secrets";

export type WorkspaceCredentialKind =
  | "google"
  | "onedrive"
  | "azure"
  | "r2"
  | "oneNote";

type WorkspaceCredentialRow = {
  id: string;
  cloudProvider?: string | null;
  cloudRefreshToken?: string | null;
  oneNoteRefreshToken?: string | null;
};

export type LoadedWorkspaceCredential = {
  value: string;
  /** Exact encrypted column value for compare-and-set token rotation. */
  storedValue: string;
  migrated: boolean;
};

const COLUMN_ENVELOPE_PREFIX = "keel-workspace-secret:v1:";
const MAX_CREDENTIAL_BYTES = 128 * 1024;

export class WorkspaceCredentialError extends Error {
  readonly code: "not-connected" | "key-unavailable" | "corrupt" | "storage";

  constructor(code: WorkspaceCredentialError["code"], message: string) {
    super(message);
    this.name = "WorkspaceCredentialError";
    this.code = code;
  }
}

function purposeLabel(kind: WorkspaceCredentialKind): string {
  return kind === "oneNote" ? "OneNote" : `${kind} cloud backup`;
}

function checkedCredential(value: string, kind: WorkspaceCredentialKind): string {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new WorkspaceCredentialError(
      "corrupt",
      `The stored ${purposeLabel(kind)} credential is invalid. Reconnect the integration.`
    );
  }
  return value;
}

/** A stable, workspace-specific AAD name without putting an arbitrary database
 * identifier into the server-secret key namespace. The AES-GCM helper appends
 * its own envelope version to this setting key. */
function aadSettingKey(workspaceId: string, kind: WorkspaceCredentialKind): string {
  if (!workspaceId) throw new WorkspaceCredentialError("corrupt", "The workspace is invalid");
  const workspaceScope = createHash("sha256")
    .update(workspaceId, "utf8")
    .digest("hex")
    .slice(0, 32);
  // A provider-specific suffix prevents a ciphertext copied between two cloud
  // providers in the same workspace from authenticating.
  const name = `workspace.${workspaceScope}.${kind}Credential`;
  return serverSecretSettingKey(name);
}

function translatedSecretError(
  error: unknown,
  kind: WorkspaceCredentialKind
): WorkspaceCredentialError {
  if (error instanceof WorkspaceCredentialError) return error;
  if (error instanceof ServerSecretError) {
    if (error.code === "ciphertext-invalid") {
      return new WorkspaceCredentialError(
        "corrupt",
        `The stored ${purposeLabel(kind)} credential could not be authenticated. Restore the matching managed-secret key or reconnect the integration.`
      );
    }
    return new WorkspaceCredentialError(
      "key-unavailable",
      `The ${purposeLabel(kind)} credential is unavailable because this server cannot use its managed-secret key. Restore KEEL_SERVER_SECRET_KEY or the SQLite key sidecar, then retry.`
    );
  }
  return new WorkspaceCredentialError(
    "storage",
    `The ${purposeLabel(kind)} credential could not be stored securely. Retry after checking the database and managed-secret key.`
  );
}

export function isSealedWorkspaceCredential(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(COLUMN_ENVELOPE_PREFIX));
}

/** Encrypt a value before it enters either legacy workspace credential column. */
export function sealWorkspaceCredential(
  workspaceId: string,
  kind: WorkspaceCredentialKind,
  plaintext: string
): string {
  try {
    const value = checkedCredential(plaintext, kind);
    return `${COLUMN_ENVELOPE_PREFIX}${encryptServerSecret(
      aadSettingKey(workspaceId, kind),
      value
    )}`;
  } catch (error) {
    throw translatedSecretError(error, kind);
  }
}

export function openWorkspaceCredential(
  workspaceId: string,
  kind: WorkspaceCredentialKind,
  storedValue: string
): string {
  if (!isSealedWorkspaceCredential(storedValue)) {
    throw new WorkspaceCredentialError(
      "corrupt",
      `The stored ${purposeLabel(kind)} credential is not encrypted`
    );
  }
  try {
    return checkedCredential(
      decryptServerSecret(
        aadSettingKey(workspaceId, kind),
        storedValue.slice(COLUMN_ENVELOPE_PREFIX.length)
      ),
      kind
    );
  } catch (error) {
    throw translatedSecretError(error, kind);
  }
}

function valueFromRow(
  workspace: WorkspaceCredentialRow,
  kind: WorkspaceCredentialKind
): string | null {
  if (
    kind !== "oneNote" &&
    workspace.cloudProvider !== undefined &&
    workspace.cloudProvider !== kind
  ) {
    throw new WorkspaceCredentialError(
      "not-connected",
      `${purposeLabel(kind)} is not connected`
    );
  }
  return kind === "oneNote"
    ? workspace.oneNoteRefreshToken ?? null
    : workspace.cloudRefreshToken ?? null;
}

async function currentStoredValue(
  workspaceId: string,
  kind: WorkspaceCredentialKind
): Promise<string | null> {
  if (kind === "oneNote") {
    return (
      await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { oneNoteRefreshToken: true },
      })
    )?.oneNoteRefreshToken ?? null;
  }
  const current = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { cloudProvider: true, cloudRefreshToken: true },
  });
  return current?.cloudProvider === kind ? current.cloudRefreshToken : null;
}

async function replaceIfCurrent(
  workspaceId: string,
  kind: WorkspaceCredentialKind,
  expected: string,
  replacement: string
): Promise<boolean> {
  try {
    const result =
      kind === "oneNote"
        ? await prisma.workspace.updateMany({
            where: { id: workspaceId, oneNoteRefreshToken: expected },
            data: { oneNoteRefreshToken: replacement },
          })
        : await prisma.workspace.updateMany({
            where: { id: workspaceId, cloudProvider: kind, cloudRefreshToken: expected },
            data: { cloudRefreshToken: replacement },
          });
    return result.count === 1;
  } catch {
    throw new WorkspaceCredentialError(
      "storage",
      `The ${purposeLabel(kind)} credential could not be stored securely. Retry after checking the database.`
    );
  }
}

/** Read an encrypted workspace credential. A legacy plaintext value is first
 * encrypted and atomically replaced. The plaintext is never used if key access
 * or the database write fails. */
export async function loadWorkspaceCredential(
  workspace: WorkspaceCredentialRow,
  kind: WorkspaceCredentialKind
): Promise<LoadedWorkspaceCredential> {
  let storedValue = valueFromRow(workspace, kind);
  if (!storedValue) {
    throw new WorkspaceCredentialError(
      "not-connected",
      `${purposeLabel(kind)} is not connected`
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (isSealedWorkspaceCredential(storedValue)) {
      return {
        value: openWorkspaceCredential(workspace.id, kind, storedValue),
        storedValue,
        migrated: attempt > 0,
      };
    }

    // Encrypt before returning any legacy plaintext to a provider. On SQLite
    // this may safely create the 0600 sidecar; PostgreSQL must already have its
    // environment master key.
    const encrypted = sealWorkspaceCredential(workspace.id, kind, storedValue);
    if (await replaceIfCurrent(workspace.id, kind, storedValue, encrypted)) {
      return { value: storedValue, storedValue: encrypted, migrated: true };
    }
    storedValue = await currentStoredValue(workspace.id, kind);
    if (!storedValue) {
      throw new WorkspaceCredentialError(
        "not-connected",
        `${purposeLabel(kind)} was disconnected while its credential was being secured`
      );
    }
  }

  throw new WorkspaceCredentialError(
    "storage",
    `The ${purposeLabel(kind)} credential changed concurrently. Retry the operation.`
  );
}

/** Persist a provider-rotated token as ciphertext without overwriting a
 * concurrent reconnect or disconnect. */
export async function rotateWorkspaceCredential(
  workspaceId: string,
  kind: WorkspaceCredentialKind,
  expectedStoredValue: string,
  plaintext: string
): Promise<void> {
  const encrypted = sealWorkspaceCredential(workspaceId, kind, plaintext);
  if (!(await replaceIfCurrent(workspaceId, kind, expectedStoredValue, encrypted))) {
    throw new WorkspaceCredentialError(
      "storage",
      `The ${purposeLabel(kind)} connection changed while its provider rotated the credential. Retry the operation.`
    );
  }
}
