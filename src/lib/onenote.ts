/* eslint-disable @typescript-eslint/no-explicit-any --
   Designed for an optional scheduled sync on an always-on Keel instance.
   The `any`s are cheerio DOM nodes; typing them is a refactor best done with
   tests around the HTML→TipTap conversion, not during a merge. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { attachmentQuotaBytes } from "@/lib/attachments";
import { MAX_RESTORED_CONTENT } from "@/lib/limits";
import { prisma } from "@/lib/prisma";
import { microsoftUserInfo, ONENOTE_SCOPE, refreshAccessToken } from "@/lib/oauth";
import {
  loadWorkspaceCredential,
  rotateWorkspaceCredential,
} from "@/lib/workspace-secrets";
import {
  withWorkspaceStorageLock,
  workspaceAssetsDir,
  workspaceStorageUsage,
} from "@/lib/workspace-storage";

const GRAPH = "https://graph.microsoft.com/v1.0/me/onenote";
const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_FETCH_TIMEOUT_MS = 30_000;
const GRAPH_FETCH_ATTEMPTS = 5;
const MAX_GRAPH_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_ONENOTE_SYNC_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_ONENOTE_SYNC_IMAGE_COUNT = 1_000;
const MAX_ONENOTE_PERSISTED_IMAGE_COUNT = 10_000;

/** Resolve the only origin that may receive a Microsoft Graph bearer token. */
function graphUrl(url: string): URL {
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== GRAPH_ORIGIN ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("untrusted origin");
    }
    return parsed;
  } catch {
    throw new Error("Microsoft Graph URL must use https://graph.microsoft.com");
  }
}

/** True only for https URLs on graph.microsoft.com - the one host the victim's
 *  access token may ever be sent to. */
function isGraphImageUrl(url: string): boolean {
  try {
    graphUrl(url);
    return true;
  } catch {
    return false;
  }
}
const SOURCE = "onenote";
const running = new Map<string, Promise<OneNoteSyncResult>>();

type GraphPage<T> = { value?: T[]; "@odata.nextLink"?: string };
type Notebook = { id: string; displayName: string; lastModifiedDateTime?: string };
type Section = {
  id: string;
  displayName: string;
  lastModifiedDateTime?: string;
  parentNotebook?: { id: string; displayName?: string };
};
type NotePage = {
  id: string;
  title: string;
  lastModifiedDateTime: string;
  order?: number;
  level?: number;
};

export type OneNoteSyncResult = {
  notebooks: number;
  sections: number;
  pagesScanned: number;
  pagesChanged: number;
  pagesRemoved: number;
  /** Pages whose content could not be fetched or converted this run. They are
   *  skipped - never pruned - and retried on the next sync. */
  pagesFailed: number;
  imagesDownloaded: number;
  imagesRemoved: number;
};

export type OneNoteImageBudget = {
  workspaceId: string;
  maxNewBytes: number;
  maxNewFiles: number;
  maxPersistedBytes: number;
  maxPersistedFiles: number;
  newBytes: number;
  newFiles: number;
  persistedBytes: number;
  oneNoteBytes: number;
  includeAttachmentBytes: boolean;
  stoppedReason: string | null;
  knownFiles: Set<string>;
  localizedSources: Map<string, string | null>;
};

type OneNoteImageBudgetLimits = {
  maxNewBytes?: number;
  maxNewFiles?: number;
  maxPersistedBytes?: number;
  maxPersistedFiles?: number;
};

function imageBudgetLimit(value: number, name: string): number {
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** One budget is created for the whole sync and passed to every page. Existing
 *  hash-named assets count toward the persisted ceiling, but never toward the
 *  per-sync limits. */
export async function createOneNoteImageBudget(
  workspaceId: string,
  limits: OneNoteImageBudgetLimits = {}
): Promise<OneNoteImageBudget> {
  const maxNewBytes = imageBudgetLimit(
    limits.maxNewBytes ?? MAX_ONENOTE_SYNC_IMAGE_BYTES,
    "OneNote per-sync image byte limit"
  );
  const maxNewFiles = imageBudgetLimit(
    limits.maxNewFiles ?? MAX_ONENOTE_SYNC_IMAGE_COUNT,
    "OneNote per-sync image count limit"
  );
  const maxPersistedBytes = imageBudgetLimit(
    limits.maxPersistedBytes ?? attachmentQuotaBytes(),
    "OneNote persisted image byte limit"
  );
  const maxPersistedFiles = imageBudgetLimit(
    limits.maxPersistedFiles ?? MAX_ONENOTE_PERSISTED_IMAGE_COUNT,
    "OneNote persisted image count limit"
  );
  const includeAttachmentBytes = limits.maxPersistedBytes === undefined;
  const usage = await withWorkspaceStorageLock(workspaceId, () =>
    workspaceStorageUsage(workspaceId, { includeAttachments: includeAttachmentBytes })
  );
  return {
    workspaceId,
    maxNewBytes,
    maxNewFiles,
    maxPersistedBytes,
    maxPersistedFiles,
    newBytes: 0,
    newFiles: 0,
    persistedBytes: usage.totalBytes,
    oneNoteBytes: usage.oneNoteBytes,
    includeAttachmentBytes,
    stoppedReason: null,
    knownFiles: usage.oneNoteNames,
    localizedSources: new Map(),
  };
}

export async function graphFetch(
  accessToken: string,
  url: string,
  options: { timeoutMs?: number; attempts?: number } = {}
) {
  // Validate before constructing the Authorization-bearing request. Disabling
  // automatic redirects keeps fetch from following that request to a second,
  // unvalidated origin.
  const target = graphUrl(url).toString();
  const timeoutMs = options.timeoutMs ?? GRAPH_FETCH_TIMEOUT_MS;
  const attempts = options.attempts ?? GRAPH_FETCH_ATTEMPTS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Microsoft Graph timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > GRAPH_FETCH_ATTEMPTS) {
    throw new Error(`Microsoft Graph attempts must be between 1 and ${GRAPH_FETCH_ATTEMPTS}`);
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(target, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`Microsoft Graph request timed out after ${timeoutMs} ms`, {
          cause: error,
        });
      }
      throw error;
    }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      if (attempt + 1 === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`Microsoft Graph failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  throw new Error("Microsoft Graph did not recover after retries");
}

export async function graphList<T>(accessToken: string, initialUrl: string): Promise<T[]> {
  const rows: T[] = [];
  let url: string | undefined = graphUrl(initialUrl).toString();
  while (url) {
    const res = await graphFetch(accessToken, url);
    const data = (await res.json()) as GraphPage<T>;
    rows.push(...(data.value ?? []));
    const next = data["@odata.nextLink"];
    // Validate pagination metadata as soon as it crosses the trust boundary,
    // before the next request has any opportunity to attach the bearer token.
    url = next ? graphUrl(next).toString() : undefined;
  }
  return rows;
}

export class GraphImageTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Microsoft Graph image exceeds the ${maxBytes}-byte limit`);
    this.name = "GraphImageTooLargeError";
  }
}

/** Read an image with both a declared-size check and an enforced streaming cap.
 *  Exported so the security regression can exercise chunked responses with a
 *  small limit without allocating a real 40 MB fixture. */
export async function readGraphImageBody(
  response: Response,
  maxBytes = MAX_GRAPH_IMAGE_BYTES
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Microsoft Graph image limit must be a positive integer");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Microsoft Graph returned an invalid Content-Length");
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Microsoft Graph returned an invalid Content-Length");
    }
    if (declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new GraphImageTooLargeError(maxBytes);
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GraphImageTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class OneNotePageTooLargeError extends Error {
  constructor(kind: "HTML" | "converted content", maximum: number) {
    const unit = kind === "HTML" ? "byte" : "character";
    super(`OneNote page ${kind} exceeds the ${maximum}-${unit} limit`);
    this.name = "OneNotePageTooLargeError";
  }
}

/** Read page HTML without trusting Graph's Content-Length. The declared check
 *  avoids starting a known-oversized body and the streamed check covers
 *  missing, compressed, or false metadata. */
export async function readOneNotePageHtml(
  response: Response,
  maxBytes = MAX_RESTORED_CONTENT
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("OneNote page HTML limit must be a positive integer");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Microsoft Graph returned an invalid Content-Length");
    }
    if (Number(declared) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new OneNotePageTooLargeError("HTML", maxBytes);
    }
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OneNotePageTooLargeError("HTML", maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function upsertMirrorPage(input: {
  workspaceId: string;
  ownerId: string;
  externalId: string;
  parentPageId: string | null;
  title: string;
  icon: string;
  sortOrder?: number;
  content?: string;
  externalUpdatedAt?: Date;
  externalHash?: string;
  /** The caller may have already looked this row up (the page loop does)  -
   *  pass it to skip a redundant findFirst per changed page. `null` means
   *  "known absent", `undefined` means "look it up". */
  existing?: { id: string } | null;
}) {
  const current =
    input.existing !== undefined
      ? input.existing
      : await prisma.page.findFirst({
          where: {
            workspaceId: input.workspaceId,
            externalSource: SOURCE,
            externalId: input.externalId,
          },
          select: { id: true },
        });
  const data = {
    parentPageId: input.parentPageId,
    title: input.title || "Untitled",
    icon: input.icon,
    sortOrder: input.sortOrder ?? 0,
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.externalUpdatedAt ? { externalUpdatedAt: input.externalUpdatedAt } : {}),
    ...(input.externalHash ? { externalHash: input.externalHash } : {}),
  };
  if (current) return prisma.page.update({ where: { id: current.id }, data });
  return prisma.page.create({
    data: {
      ...data,
      workspaceId: input.workspaceId,
      createdById: input.ownerId,
      editedById: input.ownerId,
      type: "document",
      externalSource: SOURCE,
      externalId: input.externalId,
    },
  });
}

function textNode(text: string, marks?: unknown[]) {
  const cleaned = text.replace(/\u00a0/g, " ");
  return cleaned ? { type: "text", text: cleaned, ...(marks?.length ? { marks } : {}) } : null;
}

// Both walkers below iterate an explicit work stack instead of recursing per
// DOM level: OneNote HTML is fetched from notebooks other people can write to,
// and one page nesting a few thousand tags used to blow the native call stack
// - and, because the sync re-reached the same page on every run, wedge the
// mirror for good. The stack discipline (children pushed in reverse, deferred
// work pushed underneath them) reproduces the recursive output exactly.

function inlineNodes($: ReturnType<typeof load>, element: any, marks: any[] = []): any[] {
  const result: any[] = [];
  const stack: { node: any; marks: any[] }[] = [];
  const enqueue = (parent: any, parentMarks: any[]) => {
    const children = parent.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], marks: parentMarks });
    }
  };
  enqueue(element, marks);
  while (stack.length > 0) {
    const { node: child, marks: current } = stack.pop()!;
    if (child.type === "text") {
      const node = textNode(child.data ?? "", current);
      if (node) result.push(node);
      continue;
    }
    if (child.type !== "tag") continue;
    const tag = child.name?.toLowerCase();
    if (tag === "br") {
      result.push({ type: "hardBreak" });
      continue;
    }
    if (tag === "img") continue;
    const nextMarks = [...current];
    if (tag === "strong" || tag === "b") nextMarks.push({ type: "bold" });
    if (tag === "em" || tag === "i") nextMarks.push({ type: "italic" });
    if (tag === "s" || tag === "strike") nextMarks.push({ type: "strike" });
    if (tag === "code") nextMarks.push({ type: "code" });
    if (tag === "a") nextMarks.push({ type: "link", attrs: { href: $(child).attr("href") ?? "" } });
    enqueue(child, nextMarks);
  }
  return result;
}

function blockNodes($: ReturnType<typeof load>, parent: any): any[] {
  const blocks: any[] = [];
  // A task is either a DOM node to translate into `out`, or <img> elements to
  // `emit` into `out` only after everything pushed above it has drained - that
  // keeps a flattened p/div's trailing images behind its children's blocks,
  // where the recursive version put them.
  const stack: { node?: any; emit?: any[]; out: any[] }[] = [];
  const enqueue = (el: any, out: any[]) => {
    const children = el.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], out });
  };
  // Two paths can reach the same <img>: this walk's own `img` branch, and the
  // imagesOf() sweep that rescues images from a subtree the walk consumes
  // without descending into it (a heading, a list item, a p/div flattened into
  // one paragraph). The two used to overlap silently, so an image alone in a
  // text-less <div> was emitted twice - once more for every extra wrapper
  // level, since each wrapper ran its own sweep over the same descendants.
  // Record the DOM element as it is emitted and let whichever path arrives
  // first win: a sweep is deferred until after the children it wraps, so the
  // walk's document-order copy is the one kept and the sweep contributes only
  // the images nothing else could see.
  const emitted = new Set<any>();
  const imageNode = (image: any): any | null => {
    if (emitted.has(image)) return null;
    const src = $(image).attr("src");
    if (!src) return null;
    emitted.add(image);
    return { type: "image", attrs: { src, alt: $(image).attr("alt") ?? "" } };
  };
  const pushImages = (elements: any[], out: any[]) => {
    for (const image of elements) {
      const node = imageNode(image);
      if (node) out.push(node);
    }
  };
  const imagesOf = (el: any): any[] => $(el).find("img").toArray();
  enqueue(parent, blocks);
  while (stack.length > 0) {
    const task = stack.pop()!;
    const { out } = task;
    if (task.emit) {
      pushImages(task.emit, out);
      continue;
    }
    const child = task.node;
    if (child.type === "text") {
      if ((child.data ?? "").trim()) {
        out.push({ type: "paragraph", content: [textNode(child.data)!] });
      }
      continue;
    }
    if (child.type !== "tag") continue;
    const tag = child.name?.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      out.push({
        type: "heading",
        attrs: { level: Math.min(3, Number(tag.slice(1))) },
        content: inlineNodes($, child),
      });
      // inlineNodes() drops <img> and this branch never enqueues the heading's
      // children, so without the sweep an image inside a heading is lost. It
      // cannot double-emit: the walk never reaches these nodes, and an ancestor
      // wrapper's sweep is deferred until after this task runs, so first-wins
      // leaves it a no-op.
      pushImages(imagesOf(child), out);
    } else if (tag === "p" || tag === "div") {
      const inline = inlineNodes($, child);
      if (inline.length) {
        out.push({ type: "paragraph", content: inline });
        // This branch consumes the whole subtree (its children are never
        // enqueued), so the sweep is the only chance these images get.
        pushImages(imagesOf(child), out);
      } else {
        const images = imagesOf(child);
        if (images.length) stack.push({ emit: images, out });
        enqueue(child, out);
      }
    } else if (tag === "ul" || tag === "ol") {
      const items = (child.children ?? [])
        .filter((node: any) => node.type === "tag" && node.name?.toLowerCase() === "li")
        .map((node: any) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inlineNodes($, node) }],
        }));
      out.push({ type: tag === "ul" ? "bulletList" : "orderedList", content: items });
      // Same as the heading branch: each <li> goes through inlineNodes(), which
      // discards images, and the list's subtree is never enqueued. Sweeping the
      // whole list (not each <li>) also catches images in nested lists, which
      // inlineNodes() flattens into the parent item's text.
      pushImages(imagesOf(child), out);
    } else if (tag === "pre") {
      out.push({ type: "codeBlock", content: [textNode($(child).text())] });
      // TipTap cannot place an image inside a code block. Preserve both pieces
      // instead: the preformatted text stays a code block and its images follow
      // as ordinary image blocks in document order.
      pushImages(imagesOf(child), out);
    } else if (tag === "blockquote") {
      const content: any[] = [];
      out.push({ type: "blockquote", content });
      enqueue(child, content);
    } else if (tag === "img") {
      const node = imageNode(child);
      if (node) out.push(node);
    } else {
      enqueue(child, out);
    }
  }
  return blocks;
}

async function existingOneNoteAsset(
  target: string,
  filename: string,
  budget: OneNoteImageBudget
): Promise<boolean> {
  try {
    const file = await fs.stat(target);
    if (!file.isFile()) return false;
    if (!budget.knownFiles.has(filename)) {
      budget.knownFiles.add(filename);
      budget.oneNoteBytes += file.size;
      budget.persistedBytes += file.size;
    }
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function canWriteOneNoteAsset(bytes: number, budget: OneNoteImageBudget): boolean {
  if (budget.stoppedReason) return false;
  let reason: string | null = null;
  if (budget.newFiles >= budget.maxNewFiles) {
    reason = `new image count reached ${budget.maxNewFiles}`;
  } else if (budget.newBytes + bytes > budget.maxNewBytes) {
    reason = `new image bytes would exceed ${budget.maxNewBytes}`;
  } else if (budget.persistedBytes + bytes > budget.maxPersistedBytes) {
    reason = `persisted image bytes would exceed ${budget.maxPersistedBytes}`;
  } else if (budget.knownFiles.size >= budget.maxPersistedFiles) {
    reason = `persisted image count reached ${budget.maxPersistedFiles}`;
  }
  if (!reason) return true;
  budget.stoppedReason = reason;
  console.warn(`[keel] onenote: ${reason}; skipping further new image writes this sync`);
  return false;
}

/** Localize one page's images under the budget shared by the entire sync.
 *  Images are fetched sequentially and each response is already capped at
 *  40 MiB, so only one bounded image is resident at a time. The shared byte,
 *  count, and persisted-storage ceilings bound the aggregate availability
 *  risk without adding a second temporary-file lifecycle here. */
export async function localizeImages(
  accessToken: string,
  workspaceId: string,
  html: string,
  budget: OneNoteImageBudget
): Promise<{ html: string; downloaded: number }> {
  if (budget.workspaceId !== workspaceId) {
    throw new Error("OneNote image budget belongs to a different workspace");
  }
  const $ = load(html);
  const outputDir = workspaceAssetsDir(workspaceId);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  let downloaded = 0;
  for (const image of $("img").toArray()) {
    const source = $(image).attr("data-fullres-src") || $(image).attr("src");
    if (!source || source.startsWith("data:")) continue;
    if (budget.localizedSources.has(source)) {
      const localized = budget.localizedSources.get(source);
      if (localized) {
        $(image).attr("src", localized);
        $(image).removeAttr("data-fullres-src");
      }
      continue;
    }
    // The victim's live Graph access token is attached to this fetch. Only ever
    // send it to Microsoft Graph itself: a shared notebook could carry an <img>
    // pointing at an attacker's host, and following it would hand that host a
    // usable OAuth token (and turn the sync into a blind internal SSRF). Graph
    // rehosts page images under graph.microsoft.com, so a non-Graph host here
    // is never a legitimate OneNote image.
    if (!isGraphImageUrl(source)) {
      console.warn(`[keel] onenote: skipping non-Graph image URL ${source.slice(0, 80)}`);
      budget.localizedSources.set(source, null);
      continue;
    }
    const res = await graphFetch(accessToken, source);
    // Enforce the cap while the body is still on the wire. Checking only after
    // arrayBuffer() would let a chunked response exhaust the Node heap first.
    let bytes: Buffer;
    try {
      bytes = await readGraphImageBody(res);
    } catch (error) {
      if (!(error instanceof GraphImageTooLargeError)) throw error;
      console.warn(`[keel] onenote: image exceeds 40 MB, skipping`);
      budget.localizedSources.set(source, null);
      continue;
    }
    const mime = res.headers.get("content-type")?.split(";")[0] || $(image).attr("data-src-type") || "";
    const extension =
      mime === "image/png" ? ".png" :
      mime === "image/gif" ? ".gif" :
      mime === "image/webp" ? ".webp" : ".jpg";
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const filename = `onenote-${digest}${extension}`;
    const target = path.join(/* turbopackIgnore: true */ outputDir, filename);
    const localized = `/api/assets/${filename}`;
    let stored = await existingOneNoteAsset(target, filename, budget);
    if (!stored) {
      stored = await withWorkspaceStorageLock(workspaceId, async () => {
        // Recheck after acquiring the same lock used by ordinary uploads. A
        // concurrent sync may have written this hash while this response was
        // being downloaded; that is a free dedupe hit, even after a budget has
        // stopped further new writes.
        if (await existingOneNoteAsset(target, filename, budget)) return true;

        // The initial budget is only a fast summary. The final quota decision
        // is made again under the shared lock immediately before every write,
        // so a database attachment upload cannot race this filesystem asset.
        const usage = await workspaceStorageUsage(workspaceId, {
          includeAttachments: budget.includeAttachmentBytes,
          // The factory scans the filesystem once and every successful write
          // updates this snapshot under the same lock. Reusing it avoids an
          // O(images x existing files) stat storm while the database side is
          // still re-aggregated for every cross-store quota decision.
          oneNoteUsage: {
            bytes: budget.oneNoteBytes,
            names: budget.knownFiles,
          },
        });
        budget.persistedBytes = usage.totalBytes;
        budget.oneNoteBytes = usage.oneNoteBytes;
        budget.knownFiles = usage.oneNoteNames;
        if (!canWriteOneNoteAsset(bytes.length, budget)) return false;

        try {
          await fs.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        } catch (error) {
          // Another process does not share this in-memory lock, so retain wx
          // and treat an externally won hash write as dedupe too.
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            return existingOneNoteAsset(target, filename, budget);
          }
          await fs.unlink(target).catch(() => undefined);
          throw error;
        }
        budget.knownFiles.add(filename);
        budget.newBytes += bytes.length;
        budget.newFiles++;
        budget.oneNoteBytes += bytes.length;
        budget.persistedBytes += bytes.length;
        downloaded++;
        return true;
      });
      if (!stored) {
        budget.localizedSources.set(source, null);
        continue;
      }
    }
    budget.localizedSources.set(source, localized);
    $(image).attr("src", localized);
    $(image).removeAttr("data-fullres-src");
  }
  return { html: $.html(), downloaded };
}

/** Exported for the regression check in scripts/links-check.mjs, which feeds it
 *  pathologically nested HTML and asserts it returns instead of throwing, and
 *  feeds it wrapped images and asserts each one is emitted exactly once. */
export function htmlToTipTap(
  html: string,
  maxContentLength = MAX_RESTORED_CONTENT
) {
  if (!Number.isSafeInteger(maxContentLength) || maxContentLength < 1) {
    throw new Error("OneNote converted content limit must be a positive integer");
  }
  const $ = load(html);
  const content = blockNodes($, $("body").get(0) ?? $.root().get(0));
  const converted = JSON.stringify({
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  });
  if (converted.length > maxContentLength) {
    throw new OneNotePageTooLargeError("converted content", maxContentLength);
  }
  return converted;
}

async function cleanupImages(workspaceId: string) {
  const pages = await prisma.page.findMany({
    where: { workspaceId, externalSource: SOURCE },
    select: { content: true },
  });
  const referenced = new Set<string>();
  for (const page of pages) {
    for (const match of page.content?.matchAll(/\/api\/assets\/(onenote-[a-f0-9]+\.(?:jpg|png|gif|webp))/g) ?? []) {
      referenced.add(match[1]);
    }
  }
  const dir = workspaceAssetsDir(workspaceId);
  let removed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith("onenote-") && !referenced.has(name)) {
      await fs.unlink(path.join(/* turbopackIgnore: true */ dir, name));
      removed++;
    }
  }
  return removed;
}

async function performSync(workspaceId: string): Promise<OneNoteSyncResult> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace?.oneNoteRefreshToken) throw new Error("OneNote is not connected");
  const credential = await loadWorkspaceCredential(workspace, "oneNote");
  const token = await refreshAccessToken("onedrive", credential.value, ONENOTE_SCOPE);
  if (token.refresh_token && token.refresh_token !== credential.value) {
    await rotateWorkspaceCredential(
      workspaceId,
      "oneNote",
      credential.storedValue,
      token.refresh_token
    );
  }
  const imageBudget = await createOneNoteImageBudget(workspaceId);

  const notebooks = await graphList<Notebook>(
    token.access_token,
    `${GRAPH}/notebooks?$select=id,displayName,lastModifiedDateTime&$top=100`
  );
  const sections = await graphList<Section>(
    token.access_token,
    `${GRAPH}/sections?$select=id,displayName,lastModifiedDateTime&$expand=parentNotebook($select=id,displayName)&$top=100`
  );
  const seen = new Set<string>(["root"]);
  const root = await upsertMirrorPage({
    workspaceId,
    ownerId: workspace.ownerId,
    externalId: "root",
    parentPageId: null,
    title: "Imported",
    icon: "📥",
    sortOrder: -100,
  });
  const notebookPages = new Map<string, string>();
  for (const [index, notebook] of notebooks.entries()) {
    const externalId = `notebook:${notebook.id}`;
    seen.add(externalId);
    const page = await upsertMirrorPage({
      workspaceId,
      ownerId: workspace.ownerId,
      externalId,
      parentPageId: root.id,
      title: notebook.displayName,
      icon: "📓",
      sortOrder: index,
      externalUpdatedAt: notebook.lastModifiedDateTime ? new Date(notebook.lastModifiedDateTime) : undefined,
    });
    notebookPages.set(notebook.id, page.id);
  }

  let pagesScanned = 0;
  let pagesChanged = 0;
  let pagesFailed = 0;
  let imagesDownloaded = 0;
  let incompleteScan = false;
  for (const [sectionIndex, section] of sections.entries()) {
    const notebookId = section.parentNotebook?.id;
    const notebookPageId = notebookId ? notebookPages.get(notebookId) : undefined;
    if (!notebookPageId) {
      // The section's parent notebook wasn't in the /notebooks list this run
      // (a shared notebook, a paginated response, a transient Graph hiccup).
      // We can't re-sync it, so we must NOT let the stale sweep below delete
      // it and its pages just because they weren't seen - that would be silent
      // data loss in the mirror. Mark the scan incomplete instead.
      incompleteScan = true;
      continue;
    }
    const sectionExternalId = `section:${section.id}`;
    seen.add(sectionExternalId);
    const sectionPage = await upsertMirrorPage({
      workspaceId,
      ownerId: workspace.ownerId,
      externalId: sectionExternalId,
      parentPageId: notebookPageId,
      title: section.displayName,
      icon: "📂",
      sortOrder: sectionIndex,
      externalUpdatedAt: section.lastModifiedDateTime ? new Date(section.lastModifiedDateTime) : undefined,
    });
    const pages = await graphList<NotePage>(
      token.access_token,
      `${GRAPH}/sections/${encodeURIComponent(section.id)}/pages?$select=id,title,lastModifiedDateTime,order,level&$top=100&pagelevel=true`
    );
    for (const note of pages) {
      pagesScanned++;
      const externalId = `page:${note.id}`;
      seen.add(externalId);
      const modifiedAt = new Date(note.lastModifiedDateTime);
      const existing = await prisma.page.findFirst({
        where: { workspaceId, externalSource: SOURCE, externalId },
      });
      if (existing?.externalUpdatedAt?.getTime() === modifiedAt.getTime()) {
        if (existing.parentPageId !== sectionPage.id || existing.title !== note.title) {
          await prisma.page.update({
            where: { id: existing.id },
            data: { parentPageId: sectionPage.id, title: note.title, sortOrder: note.order ?? 0 },
          });
        }
        continue;
      }
      let content: string;
      let downloaded = 0;
      try {
        const contentResponse = await graphFetch(
          token.access_token,
          `${GRAPH}/pages/${encodeURIComponent(note.id)}/content?includeIDs=true`
        );
        const localized = await localizeImages(
          token.access_token,
          workspaceId,
          await readOneNotePageHtml(contentResponse),
          imageBudget
        );
        content = htmlToTipTap(localized.html);
        downloaded = localized.downloaded;
      } catch (error) {
        // One page whose content defeats fetching or conversion must not wedge
        // the mirror: without this catch the same page threw on every run and
        // nothing after it ever synced again. Its externalId is already in
        // `seen`, so the stale sweep leaves any previous copy alone, and
        // externalUpdatedAt was not advanced, so the next sync retries it.
        pagesFailed++;
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[keel] onenote: skipping page ${note.id} - ${detail.slice(0, 200)}`);
        continue;
      }
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      await upsertMirrorPage({
        workspaceId,
        ownerId: workspace.ownerId,
        externalId,
        parentPageId: sectionPage.id,
        title: note.title,
        icon: "📄",
        sortOrder: note.order ?? 0,
        content,
        externalUpdatedAt: modifiedAt,
        externalHash: hash,
        existing: existing ? { id: existing.id } : null,
      });
      pagesChanged++;
      imagesDownloaded += downloaded;
    }
  }

  // Prune pages that no longer exist in OneNote - but never after an incomplete
  // scan, and never via `notIn: [...seen]`: `seen` can hold thousands of ids,
  // which blows past SQLite's bound-parameter limit and throws. Fetch the
  // mirror's ids and diff in memory, then delete in bounded chunks.
  let imagesRemoved = 0;
  let pagesRemoved = 0;
  if (!incompleteScan) {
    const mirror = await prisma.page.findMany({
      where: { workspaceId, externalSource: SOURCE },
      select: { id: true, externalId: true },
    });
    const staleIds = mirror.filter((p) => p.externalId && !seen.has(p.externalId)).map((p) => p.id);
    pagesRemoved = staleIds.length;
    for (let i = 0; i < staleIds.length; i += 200) {
      await prisma.page.deleteMany({ where: { id: { in: staleIds.slice(i, i + 200) } } });
    }
    imagesRemoved = await cleanupImages(workspaceId);
  } else {
    console.warn("[keel] onenote: scan was incomplete, skipping stale-page cleanup this run");
  }
  const result = {
    notebooks: notebooks.length,
    sections: sections.length,
    pagesScanned,
    pagesChanged,
    pagesRemoved,
    pagesFailed,
    imagesDownloaded,
    imagesRemoved,
  };
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      oneNoteLastSyncAt: new Date(),
      // A partial sync still completes, but the skipped pages must be visible
      // somewhere - this field is what Settings surfaces.
      oneNoteLastError:
        pagesFailed > 0
          ? `${pagesFailed} page(s) could not be imported this run and will be retried; the rest of the mirror is up to date`
          : null,
    },
  });
  return result;
}

export function syncOneNote(workspaceId: string) {
  const current = running.get(workspaceId);
  if (current) return current;
  const promise = performSync(workspaceId)
    .catch(async (error) => {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { oneNoteLastError: error instanceof Error ? error.message.slice(0, 1000) : "Sync failed" },
      });
      throw error;
    })
    .finally(() => running.delete(workspaceId));
  running.set(workspaceId, promise);
  return promise;
}

export async function oneNoteAccount(accessToken: string) {
  return (await microsoftUserInfo(accessToken)).email;
}
