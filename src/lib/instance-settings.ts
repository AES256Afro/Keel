import { prisma } from "@/lib/prisma";
import { keelEnv } from "@/lib/env";
import {
  deleteEncryptedServerSecrets,
  encryptedServerSecretPresence,
  readEncryptedServerSecrets,
  ServerSecretError,
  writeEncryptedServerSecrets,
} from "@/lib/server-secrets";

const SITE_FIELDS = {
  name: { env: "SITE_NAME", key: "site.name", fallback: "My projects", max: 100 },
  tagline: {
    env: "SITE_TAGLINE",
    key: "site.tagline",
    fallback: "Projects, notes, and experiments.",
    max: 300,
  },
  notesUrl: { env: "NOTES_URL", key: "site.notesUrl", fallback: "/", max: 2048 },
} as const;

export type SiteSettingField = keyof typeof SITE_FIELDS;

export interface SiteSettingStatus {
  value: string;
  source: "environment" | "managed" | "default";
  locked: boolean;
  warning: string | null;
}

export type SiteSettingsStatus = Record<SiteSettingField, SiteSettingStatus>;

const BACKUP_PASSPHRASE_NAME = "backup.scheduledPassphrase";

export interface BackupPassphraseStatus {
  configured: boolean;
  source: "environment" | "managed" | "none";
  locked: boolean;
  available: boolean;
}

export class InstanceSettingsError extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "InstanceSettingsError";
    this.status = status;
  }
}

function validateText(field: SiteSettingField, raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InstanceSettingsError(400, `${field} must be a string`);
  }
  const definition = SITE_FIELDS[field];
  const value = raw.trim();
  if (!value || value.length > definition.max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InstanceSettingsError(400, `${field} is not valid`);
  }
  if (field === "notesUrl") {
    if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
      return value;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new InstanceSettingsError(400, "notesUrl must be a relative path or an http(s) URL");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new InstanceSettingsError(400, "notesUrl must be a relative path or an http(s) URL");
    }
    return url.toString();
  }
  return value;
}

function nonEmptyEnvironment(suffix: string): string | null {
  const value = keelEnv(suffix);
  return value == null || value.trim() === "" ? null : value;
}

function safeResolvedValue(
  field: SiteSettingField,
  raw: string,
  fallback: string
): { value: string; warning: string | null } {
  try {
    return { value: validateText(field, raw), warning: null };
  } catch (error) {
    if (error instanceof InstanceSettingsError) {
      return {
        value: fallback,
        warning: "The configured value is invalid, so Keel is using its safe default.",
      };
    }
    throw error;
  }
}

export async function getSiteSettingsStatus(): Promise<SiteSettingsStatus> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(SITE_FIELDS).map((field) => field.key) } },
    select: { key: true, value: true },
  });
  const managed = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    Object.entries(SITE_FIELDS).map(([name, definition]) => {
      const environment = nonEmptyEnvironment(definition.env);
      const saved = managed.get(definition.key);
      const environmentValue =
        environment == null
          ? null
          : safeResolvedValue(name as SiteSettingField, environment, definition.fallback);
      const savedValue =
        saved == null
          ? null
          : safeResolvedValue(name as SiteSettingField, saved, definition.fallback);
      return [
        name,
        environmentValue != null
          ? { ...environmentValue, source: "environment", locked: true }
          : savedValue != null
            ? { ...savedValue, source: "managed", locked: false }
            : {
                value: definition.fallback,
                source: "default",
                locked: false,
                warning: null,
              },
      ];
    })
  ) as unknown as SiteSettingsStatus;
}

export async function saveSiteSettings(
  input: Partial<Record<SiteSettingField, unknown>>
): Promise<SiteSettingsStatus> {
  const unknown = Object.keys(input).filter(
    (name) => !Object.prototype.hasOwnProperty.call(SITE_FIELDS, name)
  );
  if (unknown.length > 0) {
    throw new InstanceSettingsError(400, "Unknown public-site field");
  }
  const entries = Object.entries(input).filter(
    ([name]) => Object.prototype.hasOwnProperty.call(SITE_FIELDS, name)
  ) as [SiteSettingField, unknown][];
  if (entries.length === 0) {
    throw new InstanceSettingsError(400, "Provide at least one public-site field");
  }
  const writes: { key: string; value: string }[] = [];
  for (const [name, raw] of entries) {
    const definition = SITE_FIELDS[name];
    if (nonEmptyEnvironment(definition.env) != null) {
      throw new InstanceSettingsError(409, `${name} is controlled by the server environment`);
    }
    writes.push({ key: definition.key, value: validateText(name, raw) });
  }
  await prisma.$transaction(
    writes.map((row) =>
      prisma.appSetting.upsert({
        where: { key: row.key },
        create: row,
        update: { value: row.value },
      })
    )
  );
  return getSiteSettingsStatus();
}

export async function resolveSiteSetting(field: SiteSettingField): Promise<string> {
  return (await getSiteSettingsStatus())[field].value;
}

function validatePassphrase(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InstanceSettingsError(400, "passphrase must be a string");
  }
  if (raw.length < 12 || raw.length > 1024 || /[\u0000\r\n]/.test(raw)) {
    throw new InstanceSettingsError(
      400,
      "The scheduled backup passphrase must be 12-1024 characters with no line breaks"
    );
  }
  return raw;
}

export async function getBackupPassphraseStatus(): Promise<BackupPassphraseStatus> {
  if (nonEmptyEnvironment("BACKUP_PASSPHRASE") != null) {
    return { configured: true, source: "environment", locked: true, available: true };
  }
  const presence = await encryptedServerSecretPresence([BACKUP_PASSPHRASE_NAME]);
  if (!presence.has(BACKUP_PASSPHRASE_NAME)) {
    return { configured: false, source: "none", locked: false, available: true };
  }
  try {
    const values = await readEncryptedServerSecrets([BACKUP_PASSPHRASE_NAME]);
    return {
      configured: values.has(BACKUP_PASSPHRASE_NAME),
      source: "managed",
      locked: false,
      available: values.has(BACKUP_PASSPHRASE_NAME),
    };
  } catch (error) {
    if (error instanceof ServerSecretError) {
      return { configured: false, source: "managed", locked: false, available: false };
    }
    throw error;
  }
}

export async function resolveScheduledBackupPassphrase(): Promise<string | undefined> {
  const environment = nonEmptyEnvironment("BACKUP_PASSPHRASE");
  if (environment != null) return environment;
  try {
    return (await readEncryptedServerSecrets([BACKUP_PASSPHRASE_NAME])).get(
      BACKUP_PASSPHRASE_NAME
    );
  } catch (error) {
    if (error instanceof ServerSecretError) return undefined;
    throw error;
  }
}

export async function saveBackupPassphrase(raw: unknown): Promise<BackupPassphraseStatus> {
  if (nonEmptyEnvironment("BACKUP_PASSPHRASE") != null) {
    throw new InstanceSettingsError(
      409,
      "The scheduled backup passphrase is controlled by the server environment"
    );
  }
  await writeEncryptedServerSecrets(
    new Map([[BACKUP_PASSPHRASE_NAME, validatePassphrase(raw)]])
  );
  return getBackupPassphraseStatus();
}

export async function clearBackupPassphrase(): Promise<BackupPassphraseStatus> {
  if (nonEmptyEnvironment("BACKUP_PASSPHRASE") != null) {
    throw new InstanceSettingsError(
      409,
      "The scheduled backup passphrase is controlled by the server environment"
    );
  }
  await deleteEncryptedServerSecrets([BACKUP_PASSPHRASE_NAME]);
  return getBackupPassphraseStatus();
}
