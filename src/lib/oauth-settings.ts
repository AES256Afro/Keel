import {
  decryptServerSecret,
  deleteEncryptedServerSecrets,
  encryptedServerSecretPresence,
  readEncryptedServerSecrets,
  serverSecretSettingKey,
  ServerSecretError,
  writeEncryptedServerSecrets,
} from "@/lib/server-secrets";
import { prisma } from "@/lib/prisma";
import { createHash, randomBytes } from "node:crypto";

export type OAuthSettingsProvider = "google" | "microsoft";
export type OAuthRuntimeProvider = "google" | "onedrive";
export type OAuthSettingsSource = "environment" | "managed" | "none";
export type OAuthSettingsState =
  | "configured-not-verified"
  | "verified"
  | "not-configured"
  | "incomplete"
  | "unavailable";

type ProviderDefinition = {
  clientIdEnv: "GOOGLE_CLIENT_ID" | "MS_CLIENT_ID";
  clientSecretEnv: "GOOGLE_CLIENT_SECRET" | "MS_CLIENT_SECRET";
  clientIdName: string;
  clientSecretName: string;
};

const PROVIDERS: Record<OAuthSettingsProvider, ProviderDefinition> = {
  google: {
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    clientIdName: "oauth.google.clientId",
    clientSecretName: "oauth.google.clientSecret",
  },
  microsoft: {
    clientIdEnv: "MS_CLIENT_ID",
    clientSecretEnv: "MS_CLIENT_SECRET",
    clientIdName: "oauth.microsoft.clientId",
    clientSecretName: "oauth.microsoft.clientSecret",
  },
};

export interface ResolvedOAuthCredentials {
  clientId: string;
  clientSecret: string;
  source: Exclude<OAuthSettingsSource, "none">;
  /** Random configuration generation. Never derived from credential text. */
  revision: string;
}

export interface OAuthProviderStatus {
  provider: OAuthSettingsProvider;
  configured: boolean;
  status: OAuthSettingsState;
  source: OAuthSettingsSource;
  locked: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  verified: boolean;
  verifiedAt: string | null;
}

export class OAuthSettingsError extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "OAuthSettingsError";
    this.status = status;
  }
}

function nonEmptyEnvironment(name: string): string | null {
  const value = process.env[name];
  if (value == null || value.trim() === "") return null;
  return value.trim();
}

function environmentPair(provider: OAuthSettingsProvider): {
  clientId: string | null;
  clientSecret: string | null;
  locked: boolean;
} {
  const definition = PROVIDERS[provider];
  const clientId = nonEmptyEnvironment(definition.clientIdEnv);
  const clientSecret = nonEmptyEnvironment(definition.clientSecretEnv);
  return { clientId, clientSecret, locked: clientId != null || clientSecret != null };
}

function validateClientId(provider: OAuthSettingsProvider, value: string): string {
  const clientId = value.trim();
  if (clientId.length < 6 || clientId.length > 512 || /[\u0000-\u001f\u007f\s]/.test(clientId)) {
    throw new OAuthSettingsError(400, "The client ID is not valid");
  }
  if (provider === "google" && !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new OAuthSettingsError(400, "Google client IDs must end in .apps.googleusercontent.com");
  }
  if (
    provider === "microsoft" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
  ) {
    throw new OAuthSettingsError(400, "Microsoft application client IDs must be UUIDs");
  }
  return clientId;
}

function validateClientSecret(value: string): string {
  const clientSecret = value.trim();
  if (
    clientSecret.length < 6 ||
    clientSecret.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(clientSecret)
  ) {
    throw new OAuthSettingsError(400, "The client secret is not valid");
  }
  return clientSecret;
}

function providerNames(provider: OAuthSettingsProvider): readonly [string, string] {
  const definition = PROVIDERS[provider];
  return [definition.clientIdName, definition.clientSecretName];
}

function verifiedSettingKey(provider: OAuthSettingsProvider): string {
  return `oauth.${provider}.verifiedAt`;
}

function revisionSettingKey(provider: OAuthSettingsProvider): string {
  return `oauth.${provider}.configRevision`;
}

const environmentRevisions = new Map<
  OAuthSettingsProvider,
  { signature: string; revision: string }
>();

function environmentRevision(
  provider: OAuthSettingsProvider,
  clientId: string,
  clientSecret: string
): string {
  // The signature never leaves memory. The persisted marker contains only a
  // random revision, so it cannot be used to test guesses for a client secret.
  const signature = createHash("sha256")
    .update(clientId, "utf8")
    .update("\0")
    .update(clientSecret, "utf8")
    .digest("base64url");
  const current = environmentRevisions.get(provider);
  if (current?.signature === signature) return current.revision;
  const revision = randomBytes(16).toString("base64url");
  environmentRevisions.set(provider, { signature, revision });
  return revision;
}

async function managedCredentials(
  provider: OAuthSettingsProvider
): Promise<ResolvedOAuthCredentials | null> {
  const [clientIdName, clientSecretName] = providerNames(provider);
  const clientIdKey = serverSecretSettingKey(clientIdName);
  const clientSecretKey = serverSecretSettingKey(clientSecretName);
  const revisionKey = revisionSettingKey(provider);
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [clientIdKey, clientSecretKey, revisionKey] } },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const encodedClientId = values.get(clientIdKey);
  const encodedClientSecret = values.get(clientSecretKey);
  const revision = values.get(revisionKey);
  if (!encodedClientId || !encodedClientSecret || !revision) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(revision)) return null;
  return {
    clientId: validateClientId(
      provider,
      decryptServerSecret(clientIdKey, encodedClientId)
    ),
    clientSecret: validateClientSecret(
      decryptServerSecret(clientSecretKey, encodedClientSecret)
    ),
    source: "managed",
    revision,
  };
}

async function verifiedAtFor(
  provider: OAuthSettingsProvider,
  source: Exclude<OAuthSettingsSource, "none">,
  revision: string | null
): Promise<string | null> {
  if (!revision) return null;
  const row = await prisma.appSetting.findUnique({
    where: { key: verifiedSettingKey(provider) },
    select: { value: true },
  });
  if (!row) return null;
  let marker: { v?: unknown; verifiedAt?: unknown; source?: unknown; revision?: unknown };
  try {
    marker = JSON.parse(row.value) as typeof marker;
  } catch {
    return null;
  }
  if (
    marker.v !== 1 ||
    marker.source !== source ||
    marker.revision !== revision ||
    typeof marker.verifiedAt !== "string"
  ) {
    return null;
  }
  const parsed = new Date(marker.verifiedAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now() + 60_000) return null;
  return parsed.toISOString();
}

export async function markOAuthProviderVerified(
  provider: OAuthSettingsProvider,
  credentials: ResolvedOAuthCredentials
): Promise<void> {
  const resolved = await resolveOAuthCredentials(provider);
  if (
    !resolved ||
    resolved.source !== credentials.source ||
    resolved.clientId !== credentials.clientId ||
    resolved.clientSecret !== credentials.clientSecret ||
    resolved.revision !== credentials.revision
  ) {
    return;
  }

  // The marker contains only a timestamp, source and random configuration
  // revision. It records a successful exchange, never a token, authorization
  // code, client ID, client secret or credential fingerprint.
  const key = verifiedSettingKey(provider);
  const value = JSON.stringify({
    v: 1,
    verifiedAt: new Date().toISOString(),
    source: credentials.source,
    revision: credentials.revision,
  });
  if (credentials.source === "managed") {
    await prisma.$transaction(async (tx) => {
      // A no-op conditional update locks this configuration revision. A save
      // that wins the race changes the revision and yields count 0. A save
      // that comes second waits, then clears this marker in its transaction.
      const current = await tx.appSetting.updateMany({
        where: {
          key: revisionSettingKey(provider),
          value: credentials.revision,
        },
        data: { value: credentials.revision },
      });
      if (current.count !== 1) return;
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    });
    return;
  }
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

function statusFromValues(
  provider: OAuthSettingsProvider,
  source: OAuthSettingsSource,
  locked: boolean,
  clientId: string | null,
  clientSecret: string | null,
  unavailable = false,
  verifiedAt: string | null = null
): OAuthProviderStatus {
  const clientIdConfigured = Boolean(clientId);
  const clientSecretConfigured = Boolean(clientSecret);
  const configured = clientIdConfigured && clientSecretConfigured && !unavailable;
  return {
    provider,
    configured,
    status: unavailable
      ? "unavailable"
      : configured && verifiedAt
        ? "verified"
      : configured
        ? "configured-not-verified"
        : clientIdConfigured || clientSecretConfigured
          ? "incomplete"
          : "not-configured",
    source,
    locked,
    clientIdConfigured,
    clientSecretConfigured,
    verified: configured && verifiedAt != null,
    verifiedAt: configured ? verifiedAt : null,
  };
}

async function managedStatus(provider: OAuthSettingsProvider): Promise<OAuthProviderStatus> {
  const [clientIdName, clientSecretName] = providerNames(provider);
  const presence = await encryptedServerSecretPresence([clientIdName, clientSecretName]);
  if (presence.size === 0) {
    return statusFromValues(provider, "none", false, null, null);
  }
  try {
    const credentials = await managedCredentials(provider);
    if (!credentials) {
      return statusFromValues(
        provider,
        "managed",
        false,
        presence.has(clientIdName) ? "present" : null,
        presence.has(clientSecretName) ? "present" : null,
        true
      );
    }
    return statusFromValues(
      provider,
      "managed",
      false,
      credentials.clientId,
      credentials.clientSecret,
      false,
      await verifiedAtFor(provider, "managed", credentials.revision)
    );
  } catch (error) {
    if (error instanceof ServerSecretError || error instanceof OAuthSettingsError) {
      return statusFromValues(
        provider,
        "managed",
        false,
        presence.has(clientIdName) ? "present" : null,
        presence.has(clientSecretName) ? "present" : null,
        true
      );
    }
    throw error;
  }
}

export async function getOAuthProviderStatus(
  provider: OAuthSettingsProvider
): Promise<OAuthProviderStatus> {
  const env = environmentPair(provider);
  if (env.locked) {
    let unavailable = false;
    if (env.clientId) {
      try {
        validateClientId(provider, env.clientId);
      } catch {
        unavailable = true;
      }
    }
    if (env.clientSecret) {
      try {
        validateClientSecret(env.clientSecret);
      } catch {
        unavailable = true;
      }
    }
    return statusFromValues(
      provider,
      "environment",
      true,
      env.clientId,
      env.clientSecret,
      unavailable,
      unavailable || !env.clientId || !env.clientSecret
        ? null
        : await verifiedAtFor(
            provider,
            "environment",
            environmentRevision(provider, env.clientId, env.clientSecret)
          )
    );
  }
  return managedStatus(provider);
}

export async function resolveOAuthCredentials(
  provider: OAuthSettingsProvider
): Promise<ResolvedOAuthCredentials | null> {
  const env = environmentPair(provider);
  if (env.locked) {
    if (!env.clientId || !env.clientSecret) return null;
    try {
      return {
        clientId: validateClientId(provider, env.clientId),
        clientSecret: validateClientSecret(env.clientSecret),
        source: "environment",
        revision: environmentRevision(provider, env.clientId, env.clientSecret),
      };
    } catch {
      return null;
    }
  }

  try {
    return await managedCredentials(provider);
  } catch {
    return null;
  }
}

export async function saveOAuthProviderSettings(
  provider: OAuthSettingsProvider,
  input: { clientId?: string; clientSecret?: string }
): Promise<OAuthProviderStatus> {
  if (environmentPair(provider).locked) {
    throw new OAuthSettingsError(
      409,
      "This provider is controlled by the server environment and cannot be changed here"
    );
  }

  const [clientIdName, clientSecretName] = providerNames(provider);
  let existing = new Map<string, string>();
  try {
    existing = await readEncryptedServerSecrets([clientIdName, clientSecretName]);
  } catch {
    // Replacing both values is the recovery path after a key was lost or a
    // ciphertext row was damaged. A partial write may never preserve an
    // unauthenticated value.
    if (!input.clientId?.trim() || !input.clientSecret?.trim()) {
      throw new OAuthSettingsError(
        400,
        "Stored credentials are unavailable. Enter both the client ID and client secret to replace them"
      );
    }
  }

  const submittedId = input.clientId?.trim();
  const submittedSecret = input.clientSecret?.trim();
  const clientId = submittedId || existing.get(clientIdName);
  const clientSecret = submittedSecret || existing.get(clientSecretName);
  if (!clientId || !clientSecret) {
    throw new OAuthSettingsError(400, "Enter both the client ID and client secret");
  }

  const values = new Map<string, string>([
    [clientIdName, validateClientId(provider, clientId)],
    [clientSecretName, validateClientSecret(clientSecret)],
  ]);
  try {
    await writeEncryptedServerSecrets(values, {
      deleteSettingKeys: [verifiedSettingKey(provider)],
      plainSettings: new Map([
        [revisionSettingKey(provider), randomBytes(16).toString("base64url")],
      ]),
    });
  } catch (error) {
    if (error instanceof ServerSecretError) {
      throw new OAuthSettingsError(400, error.message);
    }
    throw error;
  }
  return getOAuthProviderStatus(provider);
}

export async function clearOAuthProviderSettings(
  provider: OAuthSettingsProvider
): Promise<OAuthProviderStatus> {
  if (environmentPair(provider).locked) {
    throw new OAuthSettingsError(
      409,
      "This provider is controlled by the server environment and cannot be changed here"
    );
  }
  await deleteEncryptedServerSecrets(providerNames(provider), [
    verifiedSettingKey(provider),
    revisionSettingKey(provider),
  ]);
  return getOAuthProviderStatus(provider);
}

export function settingsProviderForRuntime(
  provider: OAuthRuntimeProvider
): OAuthSettingsProvider {
  return provider === "google" ? "google" : "microsoft";
}
