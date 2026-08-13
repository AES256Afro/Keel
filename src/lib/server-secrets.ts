import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { prisma } from "@/lib/prisma";
import { keelEnv } from "@/lib/env";

const ENVELOPE_VERSION = 1;
const ALGORITHM = "A256GCM";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_FILE_NAME = ".keel-server-secrets.key";
const MANAGED_PREFIX = "server.secret.";

type SecretEnvelope = {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ciphertext: string;
  tag: string;
};

export class ServerSecretError extends Error {
  readonly code:
    | "key-unavailable"
    | "key-invalid"
    | "key-permissions"
    | "ciphertext-invalid";

  constructor(
    code: ServerSecretError["code"],
    message: string
  ) {
    super(message);
    this.name = "ServerSecretError";
    this.code = code;
  }
}

export function serverSecretSettingKey(name: string): string {
  if (!/^[a-z][a-zA-Z0-9.]{0,79}$/.test(name)) {
    throw new Error("Invalid server secret name");
  }
  return `${MANAGED_PREFIX}${name}`;
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  let decoded: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    decoded = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    decoded = Buffer.from(trimmed, "base64url");
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    decoded = Buffer.from(trimmed, "base64");
  } else {
    throw new ServerSecretError(
      "key-invalid",
      "KEEL_SERVER_SECRET_KEY must be exactly 32 bytes encoded as hex or base64"
    );
  }
  if (decoded.length !== KEY_BYTES) {
    throw new ServerSecretError(
      "key-invalid",
      "KEEL_SERVER_SECRET_KEY must decode to exactly 32 bytes"
    );
  }
  return decoded;
}

function sqliteDatabasePath(): string | null {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl?.startsWith("file:")) return null;

  let raw = databaseUrl.slice("file:".length).split("?")[0];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    throw new ServerSecretError("key-unavailable", "The SQLite database path is invalid");
  }
  if (!raw) {
    throw new ServerSecretError("key-unavailable", "The SQLite database path is empty");
  }

  // Prisma resolves relative SQLite URLs against the schema directory. Keel's
  // active SQLite schema is prisma/schema.prisma.
  return path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.join(/* turbopackIgnore: true */ process.cwd(), "prisma", raw);
}

export function localServerSecretKeyPath(): string | null {
  const databasePath = sqliteDatabasePath();
  if (!databasePath) return null;
  const parent = path.dirname(databasePath);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(/* turbopackIgnore: true */ parent);
  } catch {
    throw new ServerSecretError(
      "key-unavailable",
      "The SQLite data directory must exist before managed credentials can be saved"
    );
  }
  const parentStat = lstatSync(/* turbopackIgnore: true */ canonicalParent);
  if (!parentStat.isDirectory()) {
    throw new ServerSecretError("key-unavailable", "The SQLite data path is not a directory");
  }
  if (process.platform !== "win32") {
    if ((parentStat.mode & 0o022) !== 0) {
      throw new ServerSecretError(
        "key-permissions",
        "The SQLite data directory must not be writable by other users"
      );
    }
    if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
      throw new ServerSecretError(
        "key-permissions",
        "The SQLite data directory must be owned by the Keel service account"
      );
    }
  }
  return path.join(canonicalParent, KEY_FILE_NAME);
}

function fileOpenFlags(write: boolean): number {
  let flags = write
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    : fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  return flags;
}

function verifyKeyFile(fd: number, filePath: string) {
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    throw new ServerSecretError("key-invalid", "The server secret key path is not a regular file");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) {
      throw new ServerSecretError(
        "key-permissions",
        `The server secret key file must be mode 0600: ${filePath}`
      );
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ServerSecretError(
        "key-permissions",
        "The server secret key file must be owned by the Keel service account"
      );
    }
  }
  return stat;
}

function readLocalKey(filePath: string): Buffer {
  let fd: number | null = null;
  try {
    const before = lstatSync(/* turbopackIgnore: true */ filePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new ServerSecretError(
        "key-invalid",
        "The server secret key path must be a regular file and cannot be a symbolic link"
      );
    }
    fd = openSync(/* turbopackIgnore: true */ filePath, fileOpenFlags(false));
    const opened = verifyKeyFile(fd, filePath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ServerSecretError(
        "key-invalid",
        "The server secret key file changed while it was being opened"
      );
    }
    const value = readFileSync(/* turbopackIgnore: true */ fd, "utf8");
    return decodeKey(value);
  } catch (error) {
    if (error instanceof ServerSecretError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ELOOP") {
      throw new ServerSecretError("key-unavailable", "The server secret key file is unavailable");
    }
    throw new ServerSecretError("key-unavailable", "The server secret key file could not be read");
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function createLocalKey(filePath: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(/* turbopackIgnore: true */ filePath, fileOpenFlags(true), 0o600);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(/* turbopackIgnore: true */ fd, `${key.toString("base64url")}\n`, {
      encoding: "utf8",
    });
    fsyncSync(fd);
    verifyKeyFile(fd, filePath);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readLocalKey(filePath);
    }
    if (error instanceof ServerSecretError) throw error;
    throw new ServerSecretError("key-unavailable", "The server secret key file could not be created");
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function masterKey(create: boolean): Buffer {
  const configured = keelEnv("SERVER_SECRET_KEY");
  if (configured) return decodeKey(configured);

  const filePath = localServerSecretKeyPath();
  if (!filePath) {
    throw new ServerSecretError(
      "key-unavailable",
      "Managed credentials on PostgreSQL require KEEL_SERVER_SECRET_KEY"
    );
  }
  try {
    return readLocalKey(filePath);
  } catch (error) {
    if (
      create &&
      error instanceof ServerSecretError &&
      error.code === "key-unavailable"
    ) {
      return createLocalKey(filePath);
    }
    throw error;
  }
}

function aad(settingKey: string): Buffer {
  return Buffer.from(`keel:${settingKey}:v${ENVELOPE_VERSION}`, "utf8");
}

export function encryptServerSecret(
  settingKey: string,
  plaintext: string,
  key = masterKey(true)
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(settingKey));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: SecretEnvelope = {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(envelope);
}

function decodeEnvelope(encoded: string): SecretEnvelope {
  let envelope: Partial<SecretEnvelope>;
  try {
    envelope = JSON.parse(encoded) as Partial<SecretEnvelope>;
  } catch {
    throw new ServerSecretError("ciphertext-invalid", "A managed credential is corrupt");
  }
  if (
    envelope.v !== ENVELOPE_VERSION ||
    envelope.alg !== ALGORITHM ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.tag !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) ||
    !/^[A-Za-z0-9_-]*$/.test(envelope.ciphertext) ||
    !/^[A-Za-z0-9_-]{22}$/.test(envelope.tag)
  ) {
    throw new ServerSecretError("ciphertext-invalid", "A managed credential is corrupt");
  }
  return envelope as SecretEnvelope;
}

export function decryptServerSecret(
  settingKey: string,
  encoded: string,
  key = masterKey(false)
): string {
  const envelope = decodeEnvelope(encoded);
  try {
    const iv = Buffer.from(envelope.iv, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("length");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(settingKey));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ServerSecretError(
      "ciphertext-invalid",
      "A managed credential could not be authenticated"
    );
  }
}

export async function readEncryptedServerSecrets(
  names: readonly string[]
): Promise<Map<string, string>> {
  const keys = names.map(serverSecretSettingKey);
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  if (rows.length === 0) return new Map();
  const key = masterKey(false);
  const values = new Map<string, string>();
  for (const row of rows) {
    const name = row.key.slice(MANAGED_PREFIX.length);
    values.set(name, decryptServerSecret(row.key, row.value, key));
  }
  return values;
}

export async function encryptedServerSecretPresence(
  names: readonly string[]
): Promise<Set<string>> {
  const keys = names.map(serverSecretSettingKey);
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true },
  });
  return new Set(rows.map((row) => row.key.slice(MANAGED_PREFIX.length)));
}

export async function writeEncryptedServerSecrets(
  values: ReadonlyMap<string, string>,
  options: {
    deleteSettingKeys?: readonly string[];
    plainSettings?: ReadonlyMap<string, string>;
  } = {}
): Promise<void> {
  const deleteSettingKeys = options.deleteSettingKeys ?? [];
  const plainSettings = options.plainSettings ?? new Map<string, string>();
  if (values.size === 0 && deleteSettingKeys.length === 0 && plainSettings.size === 0) return;
  const key = values.size > 0 ? masterKey(true) : null;
  const rows = [...values].map(([name, plaintext]) => {
    const settingKey = serverSecretSettingKey(name);
    return {
      key: settingKey,
      value: encryptServerSecret(settingKey, plaintext, key ?? undefined),
    };
  });
  await prisma.$transaction([
    ...rows.map((row) =>
      prisma.appSetting.upsert({
        where: { key: row.key },
        create: row,
        update: { value: row.value },
      })
    ),
    ...[...plainSettings].map(([settingKey, value]) =>
      prisma.appSetting.upsert({
        where: { key: settingKey },
        create: { key: settingKey, value },
        update: { value },
      })
    ),
    ...(deleteSettingKeys.length > 0
      ? [prisma.appSetting.deleteMany({ where: { key: { in: [...deleteSettingKeys] } } })]
      : []),
  ]);
}

export async function deleteEncryptedServerSecrets(
  names: readonly string[],
  additionalSettingKeys: readonly string[] = []
): Promise<void> {
  await prisma.appSetting.deleteMany({
    where: {
      key: { in: [...names.map(serverSecretSettingKey), ...additionalSettingKeys] },
    },
  });
}
