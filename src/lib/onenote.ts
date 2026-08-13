/* eslint-disable @typescript-eslint/no-explicit-any --
   Designed for an optional scheduled sync on an always-on Keel instance.
   The `any`s are cheerio DOM nodes; typing them is a refactor best done with
   tests around the HTML→TipTap conversion, not during a merge. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { prisma } from "@/lib/prisma";
import { microsoftUserInfo, ONENOTE_SCOPE, refreshAccessToken } from "@/lib/oauth";

const GRAPH = "https://graph.microsoft.com/v1.0/me/onenote";

/** True only for https URLs on graph.microsoft.com - the one host the victim's
 *  access token may ever be sent to. */
function isGraphImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "graph.microsoft.com";
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

function uploadsDir(workspaceId: string) {
  const root =
    process.env.NOPIN_UPLOAD_DIR ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "uploads");
  return path.join(/* turbopackIgnore: true */ root, workspaceId);
}

async function graphFetch(accessToken: string, url: string, binary = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) return binary ? res : res;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`Microsoft Graph failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  throw new Error("Microsoft Graph did not recover after retries");
}

async function graphList<T>(accessToken: string, initialUrl: string): Promise<T[]> {
  const rows: T[] = [];
  let url: string | undefined = initialUrl;
  while (url) {
    const res = await graphFetch(accessToken, url);
    const data = (await res.json()) as GraphPage<T>;
    rows.push(...(data.value ?? []));
    url = data["@odata.nextLink"];
  }
  return rows;
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

async function localizeImages(
  accessToken: string,
  workspaceId: string,
  html: string
): Promise<{ html: string; downloaded: number }> {
  const $ = load(html);
  const outputDir = uploadsDir(workspaceId);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  let downloaded = 0;
  for (const image of $("img").toArray()) {
    const source = $(image).attr("data-fullres-src") || $(image).attr("src");
    if (!source || source.startsWith("data:")) continue;
    // The victim's live Graph access token is attached to this fetch. Only ever
    // send it to Microsoft Graph itself: a shared notebook could carry an <img>
    // pointing at an attacker's host, and following it would hand that host a
    // usable OAuth token (and turn the sync into a blind internal SSRF). Graph
    // rehosts page images under graph.microsoft.com, so a non-Graph host here
    // is never a legitimate OneNote image.
    if (!isGraphImageUrl(source)) {
      console.warn(`[keel] onenote: skipping non-Graph image URL ${source.slice(0, 80)}`);
      continue;
    }
    const res = await graphFetch(accessToken, source, true);
    // Cap what we'll pull down - an unbounded image would fill the disk and the
    // Node heap. 40 MB is far past any real OneNote capture.
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 40 * 1024 * 1024) {
      console.warn(`[keel] onenote: image exceeds 40 MB, skipping`);
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
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, bytes, { mode: 0o600 });
      downloaded++;
    }
    $(image).attr("src", `/api/assets/${filename}`);
    $(image).removeAttr("data-fullres-src");
  }
  return { html: $.html(), downloaded };
}

/** Exported for the regression check in scripts/links-check.mjs, which feeds it
 *  pathologically nested HTML and asserts it returns instead of throwing, and
 *  feeds it wrapped images and asserts each one is emitted exactly once. */
export function htmlToTipTap(html: string) {
  const $ = load(html);
  const content = blockNodes($, $("body").get(0) ?? $.root().get(0));
  return JSON.stringify({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
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
  const dir = uploadsDir(workspaceId);
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
  const token = await refreshAccessToken("onedrive", workspace.oneNoteRefreshToken, ONENOTE_SCOPE);
  if (token.refresh_token && token.refresh_token !== workspace.oneNoteRefreshToken) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { oneNoteRefreshToken: token.refresh_token },
    });
  }

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
          await contentResponse.text()
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
