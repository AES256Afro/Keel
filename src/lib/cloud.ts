import { AwsClient } from "aws4fetch";
import { createWriteStream } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { prisma } from "@/lib/prisma";
import { refreshAccessToken, type CloudProvider } from "@/lib/oauth";
import { isBackupName } from "@/lib/backup-format";
import { maxBackupUploadBytes } from "@/lib/limits";
import {
  loadWorkspaceCredential,
  rotateWorkspaceCredential,
} from "@/lib/workspace-secrets";

// Cloud backup storage: Google Drive (app-scoped folder "Keel Backups") and
// OneDrive (the app's own App Folder). Only files Keel created are visible
// to it - the drive.file / Files.ReadWrite.AppFolder scopes guarantee that.

export interface CloudFile {
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
}

interface CloudWorkspace {
  id: string;
  cloudProvider: string | null;
  cloudRefreshToken: string | null;
  cloudFolderId: string | null;
}

const CLOUD_CONTROL_TIMEOUT_MS = 30_000;
const CLOUD_CHUNK_TIMEOUT_MS = 5 * 60_000;
const CLOUD_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

function cloudSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function cloudConnected(ws: { cloudProvider: string | null; cloudRefreshToken: string | null }) {
  return Boolean(ws.cloudProvider && ws.cloudRefreshToken);
}

async function accessTokenFor(ws: CloudWorkspace): Promise<string> {
  if (!ws.cloudProvider || !ws.cloudRefreshToken) throw new Error("No cloud connection");
  if (ws.cloudProvider !== "google" && ws.cloudProvider !== "onedrive") {
    throw new Error("The cloud provider is not an OAuth provider");
  }
  const credential = await loadWorkspaceCredential(ws, ws.cloudProvider);
  const token = await refreshAccessToken(
    ws.cloudProvider as CloudProvider,
    credential.value
  );
  // Microsoft rotates refresh tokens - persist the newest one.
  if (token.refresh_token && token.refresh_token !== credential.value) {
    await rotateWorkspaceCredential(
      ws.id,
      ws.cloudProvider,
      credential.storedValue,
      token.refresh_token
    );
  }
  return token.access_token;
}

async function api(
  token: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = CLOUD_CONTROL_TIMEOUT_MS
) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: init.signal ?? cloudSignal(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloud API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

async function readFileChunk(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number
): Promise<Uint8Array<ArrayBuffer>> {
  const chunk = new Uint8Array(new ArrayBuffer(length));
  const { bytesRead } = await handle.read(chunk, 0, length, offset);
  if (bytesRead !== length) throw new Error("Backup file changed while it was being uploaded");
  return chunk;
}

export class CloudBackupTooLargeError extends Error {
  constructor() {
    super("Backup file too large");
    this.name = "CloudBackupTooLargeError";
  }
}

function checkedCloudBackupLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Cloud backup byte limit is invalid");
  }
  return maxBytes;
}

export function assertCloudBackupSize(
  size: number,
  maxBytes = maxBackupUploadBytes()
): void {
  const limit = checkedCloudBackupLimit(maxBytes);
  if (size > limit) throw new CloudBackupTooLargeError();
}

export async function writeCloudResponseToFile(
  res: Response,
  destination: string,
  maxBytes = maxBackupUploadBytes()
): Promise<void> {
  if (!res.body) throw new Error("Cloud API returned an empty response body");

  const limit = checkedCloudBackupLimit(maxBytes);
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const declaredSize = Number(contentLength);
    if (Number.isFinite(declaredSize) && declaredSize >= 0) {
      assertCloudBackupSize(declaredSize, limit);
    }
  }

  let writtenBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const chunkBytes =
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      writtenBytes += chunkBytes;
      if (writtenBytes > limit) {
        callback(new CloudBackupTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });

  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let created = false;
  output.once("open", () => {
    created = true;
  });
  let completed = false;
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeReadableStream),
      limiter,
      output
    );
    completed = true;
  } finally {
    if (created && !completed) {
      await unlink(destination).catch(() => undefined);
    }
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/* ---------- Google Drive ---------- */

async function driveFolderId(ws: CloudWorkspace, token: string): Promise<string> {
  if (ws.cloudFolderId) return ws.cloudFolderId;
  const q = encodeURIComponent(
    "name='Keel Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false"
  );
  const found = await (
    await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`)
  ).json();
  let folderId = found.files?.[0]?.id as string | undefined;
  if (!folderId) {
    const created = await (
      await api(token, "https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Keel Backups",
          mimeType: "application/vnd.google-apps.folder",
        }),
      })
    ).json();
    folderId = created.id;
  }
  await prisma.workspace
    .update({ where: { id: ws.id }, data: { cloudFolderId: folderId } })
    .catch(() => {});
  return folderId!;
}

async function driveUpload(ws: CloudWorkspace, token: string, name: string, filePath: string) {
  const folderId = await driveFolderId(ws, token);
  // Resumable upload: metadata first, then the bytes.
  const start = await api(
    token,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [folderId] }),
    }
  );
  const session = start.headers.get("Location");
  if (!session) throw new Error("Drive did not return an upload session");
  const { size } = await stat(filePath);
  if (size === 0) {
    await api(token, session, { method: "PUT", body: new Uint8Array() });
    return;
  }
  // Drive resumable fragments must be multiples of 256 KiB except the last.
  const chunkSize = 8 * 1024 * 1024;
  const handle = await open(filePath, "r");
  try {
    for (let offset = 0; offset < size; offset += chunkSize) {
      const length = Math.min(chunkSize, size - offset);
      const chunk = await readFileChunk(handle, offset, length);
      const final = offset + length === size;
      const res = await fetch(session, {
        method: "PUT",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: chunk,
        signal: cloudSignal(CLOUD_CHUNK_TIMEOUT_MS),
      });
      if ((final && !res.ok) || (!final && res.status !== 308)) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Drive chunk upload failed (${res.status}): ${detail.slice(0, 200)}`);
      }
    }
  } finally {
    await handle.close();
  }
}

async function driveList(ws: CloudWorkspace, token: string): Promise<CloudFile[]> {
  const folderId = await driveFolderId(ws, token);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const data = await (
    await api(
      token,
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,size,modifiedTime)&pageSize=50`
    )
  ).json();
  return (data.files ?? []).map((f: { id: string; name: string; size?: string; modifiedTime: string }) => ({
    id: f.id,
    name: f.name,
    size: Number(f.size ?? 0),
    modifiedAt: f.modifiedTime,
  }));
}

async function driveDownload(token: string, fileId: string): Promise<Response> {
  return api(
    token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    CLOUD_DOWNLOAD_TIMEOUT_MS
  );
}

/* ---------- OneDrive (App Folder) ---------- */

const GRAPH = "https://graph.microsoft.com/v1.0";
// Microsoft Graph requires every non-final upload fragment to be a multiple of
// 320 KiB, and rejects the session otherwise. 8 MiB is NOT such a multiple
// (8 MiB / 320 KiB = 25.6), so a >4 MiB backup would fail to upload; 25 × 320
// KiB (7.8125 MiB) is the largest valid fragment under 8 MiB.
const CHUNK = 25 * 320 * 1024;

async function oneDriveUpload(token: string, name: string, filePath: string) {
  const { size } = await stat(filePath);
  if (size < 4 * 1024 * 1024) {
    await api(
      token,
      `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(name)}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(await readFile(filePath)),
      },
      CLOUD_CHUNK_TIMEOUT_MS
    );
    return;
  }
  // Large files: upload session with ranged PUTs.
  const session = await (
    await api(
      token,
      `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(name)}:/createUploadSession`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    )
  ).json();
  const handle = await open(filePath, "r");
  try {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const length = Math.min(CHUNK, size - offset);
      const chunk = await readFileChunk(handle, offset, length);
      const res = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: chunk,
        signal: cloudSignal(CLOUD_CHUNK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`OneDrive chunk upload failed (${res.status})`);
    }
  } finally {
    await handle.close();
  }
}

async function oneDriveList(token: string): Promise<CloudFile[]> {
  const data = await (
    await api(
      token,
      `${GRAPH}/me/drive/special/approot/children?$orderby=lastModifiedDateTime desc&$top=50`
    )
  ).json();
  return (data.value ?? []).map(
    (f: { id: string; name: string; size?: number; lastModifiedDateTime: string }) => ({
      id: f.id,
      name: f.name,
      size: f.size ?? 0,
      modifiedAt: f.lastModifiedDateTime,
    })
  );
}

async function oneDriveDownload(token: string, fileId: string): Promise<Response> {
  return api(
    token,
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}/content`,
    {},
    CLOUD_DOWNLOAD_TIMEOUT_MS
  );
}

/* ---------- Cloudflare R2 (S3-compatible, static keys) ---------- */
//
// R2 has no OAuth - requests are signed with SigV4 (aws4fetch). The static
// Credentials are serialized as JSON, then encrypted in cloudRefreshToken when
// cloudProvider="r2".

export interface R2Config {
  endpoint: string; // https://<account-id>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretKey: string;
}

const R2_PREFIX = "keel-backups/";

export function normalizeR2Config(value: unknown): R2Config | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<R2Config>;
  if (
    typeof raw.endpoint !== "string" ||
    typeof raw.bucket !== "string" ||
    typeof raw.accessKeyId !== "string" ||
    typeof raw.secretKey !== "string"
  ) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw.endpoint.trim());
  } catch {
    return null;
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
  ) {
    return null;
  }
  const bucket = raw.bucket.trim();
  const accessKeyId = raw.accessKeyId.trim();
  const secretKey = raw.secretKey.trim();
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !accessKeyId ||
    !secretKey
  ) {
    return null;
  }
  return { endpoint: endpoint.origin, bucket, accessKeyId, secretKey };
}

function parseR2Credential(value: string): R2Config | null {
  try {
    return normalizeR2Config(JSON.parse(value));
  } catch {}
  return null;
}

async function r2ConfigFor(ws: CloudWorkspace): Promise<R2Config> {
  const credential = await loadWorkspaceCredential(ws, "r2");
  const config = parseR2Credential(credential.value);
  if (!config) throw new Error("The stored R2 credential is invalid. Reconnect R2.");
  return config;
}

function r2ClientFor(cfg: R2Config) {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretKey,
    region: "auto",
    service: "s3",
  });
  const base = `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}`;
  return { client, base };
}

export async function r2Upload(cfg: R2Config, name: string, filePath: string) {
  const { client, base } = r2ClientFor(cfg);
  const objectUrl = `${base}/${R2_PREFIX}${encodeURIComponent(name)}`;
  const start = await client.fetch(`${objectUrl}?uploads`, {
    method: "POST",
    signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS),
  });
  if (!start.ok) throw new Error(`R2 multipart start failed (${start.status})`);
  const uploadIdRaw = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(await start.text())?.[1];
  if (!uploadIdRaw) throw new Error("R2 did not return a multipart upload id");
  const uploadId = xmlText(uploadIdRaw);
  const { size } = await stat(filePath);
  const chunkSize = 8 * 1024 * 1024;
  const parts: { number: number; etag: string }[] = [];
  const handle = await open(filePath, "r");
  try {
    // Multipart accepts a final part below 5 MiB, including a single small
    // part. Backup files are non-empty, but keep the zero-byte case valid.
    const totalParts = Math.max(1, Math.ceil(size / chunkSize));
    for (let index = 0; index < totalParts; index++) {
      const offset = index * chunkSize;
      const length = Math.min(chunkSize, Math.max(0, size - offset));
      const chunk = length ? await readFileChunk(handle, offset, length) : new Uint8Array();
      const number = index + 1;
      const res = await client.fetch(
        `${objectUrl}?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`,
        { method: "PUT", body: chunk, signal: cloudSignal(CLOUD_CHUNK_TIMEOUT_MS) }
      );
      if (!res.ok) throw new Error(`R2 part ${number} failed (${res.status})`);
      const etag = res.headers.get("etag");
      if (!etag) throw new Error(`R2 part ${number} returned no ETag`);
      parts.push({ number, etag });
    }
    const completeBody =
      "<CompleteMultipartUpload>" +
      parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.number}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`
        )
        .join("") +
      "</CompleteMultipartUpload>";
    const complete = await client.fetch(`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: completeBody,
      signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS),
    });
    if (!complete.ok) throw new Error(`R2 multipart completion failed (${complete.status})`);
  } catch (err) {
    await client
      .fetch(`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
        signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS),
      })
      .catch(() => {});
    throw err;
  } finally {
    await handle.close();
  }
}

export async function r2List(cfg: R2Config): Promise<CloudFile[]> {
  const { client, base } = r2ClientFor(cfg);
  const res = await client.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(R2_PREFIX)}`, {
    signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
  const xml = await res.text();
  const files: CloudFile[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? "";
    if (!key || key.endsWith("/")) continue;
    files.push({
      id: key, // full object key - used by download
      name: key.slice(R2_PREFIX.length),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      modifiedAt: /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? "",
    });
  }
  return files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

export async function r2Download(cfg: R2Config, key: string): Promise<Response> {
  const { client, base } = r2ClientFor(cfg);
  if (!key.startsWith(R2_PREFIX)) throw new Error("R2 backup id is outside the backup prefix");
  const safe = key.split("/").map(encodeURIComponent).join("/");
  const res = await client.fetch(`${base}/${safe}`, {
    signal: cloudSignal(CLOUD_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`R2 download failed (${res.status})`);
  return res;
}

/** Validate credentials by listing the bucket (also proves the bucket exists). */
export async function r2TestConnection(cfg: R2Config) {
  await r2List(cfg);
}


/* ---------- Azure Blob Storage (SAS URL) ---------- */

const AZURE_PREFIX = "keel-backups/";

/**
 * Validate and normalise a container SAS URL.
 *
 * Two security properties matter more than convenience:
 *   • The host must be a real *.blob.core.windows.net name. This URL is
 *     fetched by the SERVER, so accepting arbitrary hosts would let a
 *     workspace owner point it at internal services (SSRF).
 *   • It must actually be a SAS (carry a `sig=`), so a mistake like pasting
 *     the plain container URL fails loudly here rather than mysteriously at
 *     the first backup.
 */
export function parseAzureSasUrl(raw: string): { base: string; query: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)) return null;
  // Path must be exactly /<container> - one segment, no blob, no trailing junk.
  if (!/^\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(url.pathname)) return null;
  const params = url.searchParams;
  if (!params.get("sig") || !params.get("sv")) return null;
  return { base: `https://${url.hostname}${url.pathname}`, query: url.search.slice(1) };
}

async function azureConfigFor(ws: CloudWorkspace) {
  const credential = await loadWorkspaceCredential(ws, "azure");
  const parsed = parseAzureSasUrl(credential.value);
  if (!parsed) throw new Error("The stored Azure credential is invalid. Reconnect Azure.");
  return parsed;
}

async function azureUpload(cfg: { base: string; query: string }, name: string, filePath: string) {
  const blobUrl = `${cfg.base}/${AZURE_PREFIX}${encodeURIComponent(name)}`;
  const { size } = await stat(filePath);
  const chunkSize = 8 * 1024 * 1024;
  const ids: string[] = [];
  const handle = await open(filePath, "r");
  try {
    const totalBlocks = Math.max(1, Math.ceil(size / chunkSize));
    for (let index = 0; index < totalBlocks; index++) {
      const offset = index * chunkSize;
      const length = Math.min(chunkSize, Math.max(0, size - offset));
      const chunk = length ? await readFileChunk(handle, offset, length) : new Uint8Array();
      const id = Buffer.from(String(index).padStart(8, "0"), "ascii").toString("base64");
      const res = await fetch(
        `${blobUrl}?comp=block&blockid=${encodeURIComponent(id)}&${cfg.query}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-ms-version": "2021-08-06",
          },
          body: chunk,
          signal: cloudSignal(CLOUD_CHUNK_TIMEOUT_MS),
        }
      );
      if (!res.ok) throw new Error(`Azure block ${index + 1} failed (${res.status})`);
      ids.push(id);
    }
    const list = `<BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`;
    const complete = await fetch(`${blobUrl}?comp=blocklist&${cfg.query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/xml", "x-ms-version": "2021-08-06" },
      body: list,
      signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS),
    });
    if (!complete.ok) throw new Error(`Azure block list failed (${complete.status})`);
  } finally {
    await handle.close();
  }
}

async function azureList(cfg: { base: string; query: string }): Promise<CloudFile[]> {
  const res = await fetch(
    `${cfg.base}?restype=container&comp=list&prefix=${encodeURIComponent(AZURE_PREFIX)}&${cfg.query}`,
    { signal: cloudSignal(CLOUD_CONTROL_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Azure list failed (${res.status})`);
  const xml = await res.text();
  const files: CloudFile[] = [];
  for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const block = m[1];
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(block)?.[1] ?? "";
    if (!name) continue;
    files.push({
      id: name, // full blob path - used by download
      name: name.slice(AZURE_PREFIX.length),
      size: Number(/<Content-Length>(\d+)<\/Content-Length>/.exec(block)?.[1] ?? 0),
      modifiedAt: /<Last-Modified>([\s\S]*?)<\/Last-Modified>/.exec(block)?.[1] ?? "",
    });
  }
  return files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

async function azureDownload(cfg: { base: string; query: string }, blobPath: string): Promise<Response> {
  // The id came from our own list call, but re-anchor it anyway so a tampered
  // value cannot escape the container.
  const safe = blobPath.replace(/^\/+/, "");
  if (!safe.startsWith(AZURE_PREFIX)) throw new Error("Azure backup id is outside the backup prefix");
  const res = await fetch(
    `${cfg.base}/${safe.split("/").map(encodeURIComponent).join("/")}?${cfg.query}`,
    { signal: cloudSignal(CLOUD_DOWNLOAD_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Azure download failed (${res.status})`);
  return res;
}

/** Validate the SAS by listing (proves both the URL and the List permission). */
export async function azureTestConnection(sasUrl: string) {
  const cfg = parseAzureSasUrl(sasUrl);
  if (!cfg) {
    throw new Error(
      "That doesn't look like a container SAS URL - it should be https://<account>.blob.core.windows.net/<container>?sv=…&sig=…"
    );
  }
  await azureList(cfg);
  return cfg;
}

/* ---------- Provider-agnostic API ---------- */

export async function uploadBackupToCloud(ws: CloudWorkspace, name: string, filePath: string) {
  if (ws.cloudProvider === "azure") {
    return azureUpload(await azureConfigFor(ws), name, filePath);
  }
  if (ws.cloudProvider === "r2") {
    return r2Upload(await r2ConfigFor(ws), name, filePath);
  }
  const token = await accessTokenFor(ws);
  if (ws.cloudProvider === "google") return driveUpload(ws, token, name, filePath);
  return oneDriveUpload(token, name, filePath);
}

export async function listCloudBackups(ws: CloudWorkspace): Promise<CloudFile[]> {
  let files: CloudFile[];
  if (ws.cloudProvider === "azure") {
    files = await azureList(await azureConfigFor(ws));
  } else if (ws.cloudProvider === "r2") {
    files = await r2List(await r2ConfigFor(ws));
  } else {
    const token = await accessTokenFor(ws);
    files = ws.cloudProvider === "google" ? await driveList(ws, token) : await oneDriveList(token);
  }
  return files.filter((f) => isBackupName(f.name));
}

interface DownloadCloudBackupOptions {
  declaredSize?: number;
  maxBytes?: number;
}

export async function downloadCloudBackupToFile(
  ws: CloudWorkspace,
  fileId: string,
  destination: string,
  options: DownloadCloudBackupOptions = {}
): Promise<void> {
  const maxBytes = options.maxBytes ?? maxBackupUploadBytes();
  if (options.declaredSize !== undefined) {
    assertCloudBackupSize(options.declaredSize, maxBytes);
  }

  let res: Response;
  if (ws.cloudProvider === "azure") {
    res = await azureDownload(await azureConfigFor(ws), fileId);
  } else if (ws.cloudProvider === "r2") {
    res = await r2Download(await r2ConfigFor(ws), fileId);
  } else {
    const token = await accessTokenFor(ws);
    res = ws.cloudProvider === "google"
      ? await driveDownload(token, fileId)
      : await oneDriveDownload(token, fileId);
  }
  await writeCloudResponseToFile(res, destination, maxBytes);
}
