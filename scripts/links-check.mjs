#!/usr/bin/env node
// The link layer: [[wikilinks]], backlinks and #tags.
//
//   node scripts/links-check.mjs
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import fs from "fs/promises";
import { register } from "node:module";
import os from "os";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "links-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.LINKS_PORT || 3191);
const BASE = `http://localhost:${PORT}`;

register("./ts-loader.mjs", import.meta.url);
const { extractLinks, normalizeTitle } = await import(
  pathToFileURL(path.join(root, "src/lib/links.ts")).href
);
const {
  createOneNoteImageBudget,
  GraphImageTooLargeError,
  graphFetch,
  graphList,
  htmlToTipTap,
  localizeImages,
  OneNotePageTooLargeError,
  readGraphImageBody,
  readOneNotePageHtml,
} = await import(
  pathToFileURL(path.join(root, "src/lib/onenote.ts")).href
);

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
};

/* ---------------- Extraction ---------------- */
console.log("\nExtracting links");
{
  const one = extractLinks("See [[Roadmap]] for details.");
  check("finds a wikilink", one.targets.join() === "Roadmap", JSON.stringify(one.targets));

  const piped = extractLinks("See [[Roadmap|the plan]].");
  check("supports [[target|label]]", piped.targets.join() === "Roadmap", JSON.stringify(piped.targets));

  const many = extractLinks("[[A]] then [[B]] then [[A]] again");
  check("de-duplicates targets", many.targets.join() === "A,B", JSON.stringify(many.targets));

  const spaced = extractLinks("[[  Multi   word  title ]]");
  check("collapses whitespace in a target", spaced.targets.join() === "Multi word title", JSON.stringify(spaced.targets));

  // An unclosed bracket must not swallow the rest of the document.
  const unclosed = extractLinks("[[never closed\nand a new line [[Real]] here");
  check("an unclosed link does not swallow the document", unclosed.targets.join() === "Real", JSON.stringify(unclosed.targets));

  const empty = extractLinks("[[]] and [[   ]]");
  check("ignores empty links", empty.targets.length === 0, JSON.stringify(empty.targets));

  const flood = extractLinks(Array.from({ length: 500 }, (_, i) => `[[P${i}]]`).join(" "));
  check("caps the number of links per page", flood.targets.length <= 200, String(flood.targets.length));
}

console.log("\nExtracting tags");
{
  const t = extractLinks("Filed under #work and #deep-focus today.");
  check("finds tags", t.tags.map((x) => x.tag).join() === "work,deep-focus", JSON.stringify(t.tags));

  const cased = extractLinks("#Work and #work are the same tag");
  check("tags are case-insensitive", cased.tags.length === 1, JSON.stringify(cased.tags));
  check("but the original casing is kept", cased.tags[0].label === "Work", cased.tags[0].label);

  const nested = extractLinks("#work/urgent");
  check("supports nested tags", nested.tags[0]?.tag === "work/urgent", JSON.stringify(nested.tags));

  // The cases that make a naive #-regex useless.
  const sharp = extractLinks("I write C# and F# code");
  check("C# is not a tag", sharp.tags.length === 0, JSON.stringify(sharp.tags));

  const issue = extractLinks("Fixes #123 and #1");
  check("issue numbers are not tags", issue.tags.length === 0, JSON.stringify(issue.tags));

  const url = extractLinks("See https://example.com/docs#section for more");
  check("a URL fragment is not a tag", url.tags.length === 0, JSON.stringify(url.tags));

  const hex = extractLinks("Colours #ff0000 #fff #abcdef12 and #123456 in a design note");
  check("hex colours are not tags", hex.tags.length === 0, JSON.stringify(hex.tags));

  // …but a real word that happens to be hex-shaped still is.
  const word = extractLinks("#face and #decaf are words");
  check("hex-shaped words are still tags", word.tags.map((x) => x.tag).join() === "decaf", JSON.stringify(word.tags));

  const trailing = extractLinks("#work- and #focus/ trail punctuation");
  check("trailing punctuation is trimmed", trailing.tags.map((x) => x.tag).join() === "work,focus", JSON.stringify(trailing.tags));

  const start = extractLinks("#first at the very start");
  check("a tag at the start of the text counts", start.tags[0]?.tag === "first", JSON.stringify(start.tags));

  const paren = extractLinks("Tagged (#inside parens)");
  check("a tag after an opening paren counts", paren.tags[0]?.tag === "inside", JSON.stringify(paren.tags));
}

console.log("\nTitle normalisation");
{
  check("case is ignored", normalizeTitle("My Page") === normalizeTitle("my page"));
  check("whitespace is collapsed", normalizeTitle("  a   b  ") === "a b");
}

console.log("\nOneNote Graph transport security");
{
  let declaredCancelled = false;
  const declaredBody = new ReadableStream({
    cancel() {
      declaredCancelled = true;
    },
  });
  let declaredError;
  try {
    await readGraphImageBody(
      new Response(declaredBody, { headers: { "Content-Length": "9" } }),
      8
    );
  } catch (error) {
    declaredError = error;
  }
  check(
    "a declared oversized Graph image is rejected before buffering",
    declaredError instanceof GraphImageTooLargeError && declaredCancelled,
    String(declaredError ?? "response unexpectedly accepted")
  );

  let chunkedCancelled = false;
  let chunk = 0;
  const chunkedBody = new ReadableStream({
    pull(controller) {
      if (chunk++ < 2) controller.enqueue(new Uint8Array(5));
      else controller.close();
    },
    cancel() {
      chunkedCancelled = true;
    },
  });
  let chunkedError;
  try {
    await readGraphImageBody(new Response(chunkedBody), 8);
  } catch (error) {
    chunkedError = error;
  }
  check(
    "a chunked Graph image is cancelled as soon as its stream crosses the cap",
    chunkedError instanceof GraphImageTooLargeError && chunkedCancelled,
    String(chunkedError ?? "response unexpectedly accepted")
  );

  let declaredHtmlCancelled = false;
  let declaredHtmlReads = 0;
  const declaredHtmlBody = new ReadableStream(
    {
      pull() {
        declaredHtmlReads++;
      },
      cancel() {
        declaredHtmlCancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  let declaredHtmlError;
  try {
    await readOneNotePageHtml(
      new Response(declaredHtmlBody, { headers: { "Content-Length": "9" } }),
      8
    );
  } catch (error) {
    declaredHtmlError = error;
  }
  check(
    "declared oversized OneNote HTML is cancelled before its body is read",
    declaredHtmlError instanceof OneNotePageTooLargeError &&
      declaredHtmlCancelled &&
      declaredHtmlReads === 0,
    `${String(declaredHtmlError ?? "response unexpectedly accepted")}; reads=${declaredHtmlReads}`
  );

  const exerciseHtmlStreamCap = async (name, headers) => {
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (chunk++ < 2) controller.enqueue(new Uint8Array(5));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    let error;
    try {
      await readOneNotePageHtml(new Response(body, { headers }), 8);
    } catch (caught) {
      error = caught;
    }
    check(
      `${name} OneNote HTML is cancelled when actual bytes cross the cap`,
      error instanceof OneNotePageTooLargeError && cancelled,
      `${String(error ?? "response unexpectedly accepted")}; cancelled=${cancelled}`
    );
  };
  await exerciseHtmlStreamCap("chunked", {});
  await exerciseHtmlStreamCap("false-length", { "Content-Length": "0" });

  const amplifyingHtml = `<p>${'"\\'.repeat(20)}</p>`;
  const amplifiedContent = htmlToTipTap(amplifyingHtml, 10_000);
  const amplificationLimit = Math.floor(
    (amplifyingHtml.length + amplifiedContent.length) / 2
  );
  let amplificationError;
  try {
    htmlToTipTap(amplifyingHtml, amplificationLimit);
  } catch (error) {
    amplificationError = error;
  }
  check(
    "HTML-to-TipTap amplification is refused at the converted-content limit",
    amplifyingHtml.length < amplificationLimit &&
      amplifiedContent.length > amplificationLimit &&
      amplificationError instanceof OneNotePageTooLargeError,
    `${amplifyingHtml.length} HTML characters; ${amplifiedContent.length} converted; limit ${amplificationLimit}`
  );

  const normalHtml = "<html><body><p>normal OneNote page</p></body></html>";
  const readNormalHtml = await readOneNotePageHtml(
    new Response(Buffer.from(normalHtml), {
      headers: { "Content-Length": String(Buffer.byteLength(normalHtml)) },
    }),
    1_024
  );
  const normalContent = htmlToTipTap(readNormalHtml, 1_024);
  check(
    "normal bounded OneNote HTML reads and converts for import",
    normalContent.includes("normal OneNote page") && JSON.parse(normalContent).type === "doc",
    normalContent
  );

  const originalFetch = globalThis.fetch;
  let timeoutSignal;
  let timeoutRedirect;
  try {
    globalThis.fetch = async (_input, init) => {
      timeoutSignal = init?.signal;
      timeoutRedirect = init?.redirect;
      return await new Promise((_resolve, reject) => {
        // AbortSignal.timeout() intentionally uses an unreferenced timer in
        // Node. Keep this standalone regression alive until that signal fires.
        const keepAlive = setTimeout(() => reject(new Error("mock did not abort")), 1_000);
        const abort = () => {
          clearTimeout(keepAlive);
          reject(init?.signal?.reason ?? new Error("aborted"));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    let timeoutError;
    try {
      await graphFetch("test-access-token", "https://graph.microsoft.com/v1.0/me", {
        timeoutMs: 10,
        attempts: 1,
      });
    } catch (error) {
      timeoutError = error;
    }
    check(
      "every bearer fetch has a finite abort signal and rejects redirects",
      timeoutSignal instanceof AbortSignal &&
        timeoutSignal.aborted &&
        timeoutRedirect === "error" &&
        /timed out/.test(String(timeoutError)),
      String(timeoutError ?? "request unexpectedly completed")
    );

    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), authorization: init?.headers?.Authorization });
      return Response.json({
        value: [{ id: "safe-page" }],
        "@odata.nextLink": "https://attacker.example/steal-token",
      });
    };
    let paginationError;
    try {
      await graphList("pagination-secret", "https://graph.microsoft.com/v1.0/me/onenote/pages");
    } catch (error) {
      paginationError = error;
    }
    check(
      "a malicious Graph nextLink is rejected before the bearer token can leave Graph",
      requests.length === 1 &&
        requests[0]?.input.startsWith("https://graph.microsoft.com/") &&
        requests[0]?.authorization === "Bearer pagination-secret" &&
        /must use https:\/\/graph\.microsoft\.com/.test(String(paginationError)),
      `${String(paginationError ?? "pagination unexpectedly continued")}; requests=${JSON.stringify(requests)}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\nOneNote cumulative image budgets");
{
  const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "keel-onenote-images-"));
  const previousUploadDir = process.env.NOPIN_UPLOAD_DIR;
  const originalFetch = globalThis.fetch;
  process.env.NOPIN_UPLOAD_DIR = imageRoot;
  const graphImage = (name) => `https://graph.microsoft.com/v1.0/me/onenote/resources/${name}`;
  const bodies = new Map();
  const localizedCount = (html) =>
    html.match(/\/api\/assets\/onenote-[a-f0-9]{64}\.(?:jpg|png|gif|webp)/g)?.length ?? 0;
  try {
    globalThis.fetch = async (input) => {
      const bytes = bodies.get(String(input));
      if (!bytes) return new Response("missing fixture", { status: 404 });
      return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    };

    const byteWorkspace = "byte-budget";
    for (const [name, fill] of [["byte-a", 0x11], ["byte-b", 0x22], ["byte-c", 0x33]]) {
      bodies.set(graphImage(name), Buffer.alloc(4, fill));
    }
    const byteBudget = await createOneNoteImageBudget(byteWorkspace, {
      maxNewBytes: 8,
      maxNewFiles: 10,
      maxPersistedBytes: 100,
    });
    const byteFirst = await localizeImages(
      "image-budget-token",
      byteWorkspace,
      `<img src="${graphImage("byte-a")}"><img src="${graphImage("byte-b")}">`,
      byteBudget
    );
    const byteSecond = await localizeImages(
      "image-budget-token",
      byteWorkspace,
      `<img src="${graphImage("byte-c")}">`,
      byteBudget
    );
    check(
      "individually valid images share one byte budget across page localization calls",
      byteFirst.downloaded === 2 &&
        byteSecond.downloaded === 0 &&
        byteBudget.newBytes === 8 &&
        byteBudget.newFiles === 2 &&
        localizedCount(byteFirst.html) === 2 &&
        localizedCount(byteSecond.html) === 0,
      JSON.stringify({
        first: byteFirst.downloaded,
        second: byteSecond.downloaded,
        bytes: byteBudget.newBytes,
        files: byteBudget.newFiles,
      })
    );
    check(
      "crossing the cumulative byte budget creates no third file",
      (await fs.readdir(path.join(imageRoot, byteWorkspace))).length === 2
    );

    const countWorkspace = "count-budget";
    const countA = Buffer.alloc(4, 0x41);
    bodies.set(graphImage("count-a"), countA);
    bodies.set(graphImage("count-b"), Buffer.alloc(4, 0x42));
    bodies.set(graphImage("count-c"), Buffer.alloc(4, 0x43));
    bodies.set(graphImage("count-a-copy"), countA);
    const countBudget = await createOneNoteImageBudget(countWorkspace, {
      maxNewBytes: 100,
      maxNewFiles: 2,
      maxPersistedBytes: 100,
    });
    const countFirst = await localizeImages(
      "image-budget-token",
      countWorkspace,
      `<img src="${graphImage("count-a")}">`,
      countBudget
    );
    const countSecond = await localizeImages(
      "image-budget-token",
      countWorkspace,
      `<img src="${graphImage("count-b")}"><img src="${graphImage("count-c")}"><img src="${graphImage("count-a-copy")}">`,
      countBudget
    );
    check(
      "the per-sync unique image count cap prevents a third new write",
      countFirst.downloaded === 1 &&
        countSecond.downloaded === 1 &&
        countBudget.newFiles === 2 &&
        (await fs.readdir(path.join(imageRoot, countWorkspace))).length === 2,
      JSON.stringify({
        first: countFirst.downloaded,
        second: countSecond.downloaded,
        files: countBudget.newFiles,
      })
    );
    check(
      "an existing hash-deduplicated image remains localizable after the count cap stops writes",
      localizedCount(countSecond.html) === 2 && countSecond.html.includes(graphImage("count-c")),
      countSecond.html
    );

    const persistedWorkspace = "persisted-budget";
    const persistedDir = path.join(imageRoot, persistedWorkspace);
    const persistedBytes = Buffer.alloc(6, 0x51);
    const persistedName = `onenote-${createHash("sha256").update(persistedBytes).digest("hex")}.png`;
    await fs.mkdir(persistedDir, { recursive: true });
    await fs.writeFile(path.join(persistedDir, persistedName), persistedBytes);
    bodies.set(graphImage("persisted-new"), Buffer.alloc(4, 0x52));
    bodies.set(graphImage("persisted-copy"), persistedBytes);
    const persistedBudget = await createOneNoteImageBudget(persistedWorkspace, {
      maxNewBytes: 100,
      maxNewFiles: 10,
      maxPersistedBytes: 8,
    });
    const persisted = await localizeImages(
      "image-budget-token",
      persistedWorkspace,
      `<img src="${graphImage("persisted-new")}"><img src="${graphImage("persisted-copy")}">`,
      persistedBudget
    );
    check(
      "the persisted workspace budget blocks growth across repeated syncs without charging dedupe",
      persisted.downloaded === 0 &&
        persistedBudget.newFiles === 0 &&
        (await fs.readdir(persistedDir)).length === 1 &&
        localizedCount(persisted.html) === 1 &&
        persisted.html.includes(graphImage("persisted-new")),
      persisted.html
    );

    const inodeWorkspace = "persisted-count-budget";
    const inodeDir = path.join(imageRoot, inodeWorkspace);
    await fs.mkdir(inodeDir, { recursive: true });
    const inodeBodies = [Buffer.from([0x61]), Buffer.from([0x62]), Buffer.from([0x63])];
    for (const [index, bytes] of inodeBodies.slice(0, 2).entries()) {
      const name = `onenote-${createHash("sha256").update(bytes).digest("hex")}.png`;
      await fs.writeFile(path.join(inodeDir, name), bytes);
      bodies.set(graphImage(`inode-copy-${index}`), bytes);
    }
    bodies.set(graphImage("inode-new"), inodeBodies[2]);
    const inodeBudget = await createOneNoteImageBudget(inodeWorkspace, {
      maxNewBytes: 100,
      maxNewFiles: 10,
      maxPersistedBytes: 100,
      maxPersistedFiles: 2,
    });
    const inodeResult = await localizeImages(
      "image-budget-token",
      inodeWorkspace,
      `<img src="${graphImage("inode-new")}"><img src="${graphImage("inode-copy-0")}">`,
      inodeBudget
    );
    check(
      "the persisted file-count budget blocks tiny unique images across repeated syncs",
      inodeResult.downloaded === 0 &&
        inodeBudget.newFiles === 0 &&
        inodeBudget.knownFiles.size === 2 &&
        (await fs.readdir(inodeDir)).length === 2 &&
        localizedCount(inodeResult.html) === 1 &&
        inodeResult.html.includes(graphImage("inode-new")),
      inodeResult.html
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUploadDir === undefined) delete process.env.NOPIN_UPLOAD_DIR;
    else process.env.NOPIN_UPLOAD_DIR = previousUploadDir;
    await fs.rm(imageRoot, { recursive: true, force: true });
  }
}

console.log("\nOneNote HTML conversion");
{
  // The walkers used to recurse per DOM level, so one pathologically nested
  // page (hostile or just broken) blew the native call stack - and because the
  // sync re-reached the same page every run, it wedged the mirror for good.
  // They are iterative now: deep input must convert, not throw.
  const depth = 12000;
  const run = (html) => {
    try {
      return { doc: JSON.parse(htmlToTipTap(html)) };
    } catch (err) {
      return { err };
    }
  };

  const inline = run(
    `<html><body><p>${"<span>".repeat(depth)}deep text${"</span>".repeat(depth)}</p></body></html>`
  );
  check(
    `${depth} nested inline tags convert instead of throwing`,
    !inline.err && inline.doc?.type === "doc",
    String(inline.err ?? "")
  );
  check(
    "and the text at the bottom survives",
    JSON.stringify(inline.doc ?? {}).includes("deep text")
  );

  const block = run(
    `<html><body>${"<section>".repeat(depth)}<p>block text</p>${"</section>".repeat(depth)}</body></html>`
  );
  check(
    `${depth} nested block tags convert instead of throwing`,
    !block.err && JSON.stringify(block.doc ?? {}).includes("block text"),
    String(block.err ?? "")
  );

  // The rewrite must not have changed what ordinary pages produce.
  const rich = run(
    `<html><body><h2>Title</h2><div><p>first <b>bold <i>both</i></b></p><img src="/x.png" alt="a"/></div><blockquote><p>quoted</p></blockquote><ul><li>one</li><li>two</li></ul></body></html>`
  );
  const kinds = (rich.doc?.content ?? []).map((n) => n.type).join();
  check(
    "an ordinary page still yields the expected blocks in order",
    kinds === "heading,paragraph,image,blockquote,bulletList",
    kinds
  );
  const styled = rich.doc?.content?.[1]?.content?.find((n) => n.text === "both");
  check(
    "with nested marks intact",
    (styled?.marks ?? []).map((m) => m.type).join() === "bold,italic",
    JSON.stringify(styled)
  );

  // Every <img> must reach the document exactly once. Two paths could emit the
  // same element - the walk's own img branch and the sweep that rescues images
  // from subtrees the walk consumes whole - and they used to overlap, so a
  // standalone image inside a text-less <div> (exactly how OneNote wraps its
  // positioned images) arrived twice, plus one more copy per wrapper level.
  const srcs = (parsed) => {
    const found = [];
    const walk = (nodes) => {
      for (const n of nodes ?? []) {
        if (n?.type === "image") found.push(n.attrs?.src);
        if (Array.isArray(n?.content)) walk(n.content);
      }
    };
    walk(parsed?.content);
    return found;
  };

  const wrapped = run(`<html><body><div><img src="/x.png" alt="a"/></div></body></html>`);
  check(
    "an image alone in a wrapper is emitted exactly once",
    srcs(wrapped.doc).join() === "/x.png",
    JSON.stringify(srcs(wrapped.doc))
  );

  const nested = run(
    `<html><body><div><div><div><img src="/x.png"/></div></div></div></body></html>`
  );
  check(
    "and still once through three nested wrappers",
    srcs(nested.doc).join() === "/x.png",
    JSON.stringify(srcs(nested.doc))
  );

  const two = run(
    `<html><body><div><div><img src="/x.png"/></div><img src="/y.png"/></div></body></html>`
  );
  check(
    "siblings at different depths keep document order, once each",
    srcs(two.doc).join() === "/x.png,/y.png",
    JSON.stringify(srcs(two.doc))
  );

  // The sweep still earns its place: the block walk turns a list into inline
  // items and a heading into inline content, and inline conversion drops
  // <img> - so without the sweep these two images would vanish entirely.
  const rescued = run(
    `<html><body><div><ul><li><img src="/l.png"/></li></ul><h2><img src="/h.png"/></h2></div></body></html>`
  );
  check(
    "images the block walk cannot reach are still rescued, once each",
    srcs(rescued.doc).join() === "/l.png,/h.png",
    JSON.stringify(srcs(rescued.doc))
  );

  // The rescue above only fired because a <div> wrapped the list and heading
  // and ran the sweep on their behalf. A OneNote page whose list or heading is
  // a direct child of <body> has no such ancestor, so those images used to be
  // dropped from the import entirely. Each branch now sweeps its own subtree.
  const bareList = run(`<html><body><ul><li>Diagram <img src="/l.png"/></li></ul></body></html>`);
  check(
    "an image in a top-level list item is imported exactly once",
    srcs(bareList.doc).join() === "/l.png",
    JSON.stringify(bareList.doc?.content)
  );
  check(
    "and the list item keeps its text",
    JSON.stringify(bareList.doc ?? {}).includes("Diagram"),
    JSON.stringify(bareList.doc?.content)
  );

  const bareHeading = run(`<html><body><h2>Title <img src="/h.png"/></h2></body></html>`);
  check(
    "an image in a top-level heading is imported exactly once",
    srcs(bareHeading.doc).join() === "/h.png",
    JSON.stringify(bareHeading.doc?.content)
  );
  check(
    "and the heading keeps its text",
    bareHeading.doc?.content?.[0]?.type === "heading" &&
      JSON.stringify(bareHeading.doc.content[0].content).includes("Title"),
    JSON.stringify(bareHeading.doc?.content)
  );

  const bareOrdered = run(
    `<html><body><ol><li><img src="/a.png"/></li><li><img src="/b.png"/></li></ol></body></html>`
  );
  check(
    "two images in one top-level ordered list arrive once each, in order",
    srcs(bareOrdered.doc).join() === "/a.png,/b.png",
    JSON.stringify(srcs(bareOrdered.doc))
  );

  // The regression to guard hardest: the new per-branch sweeps must not fire a
  // second time for images an ancestor wrapper's sweep can also see. Every
  // extra wrapper level is another sweep over the same descendants, so a
  // double-emit would show up as one copy per level.
  const wrappedList = run(
    `<html><body><div><div><ul><li><img src="/l.png"/></li></ul></div></div></body></html>`
  );
  check(
    "a list under two wrappers still emits its image once, not once per level",
    srcs(wrappedList.doc).join() === "/l.png",
    JSON.stringify(srcs(wrappedList.doc))
  );

  const wrappedHeading = run(
    `<html><body><div>caption<h2>Title <img src="/h.png"/></h2></div></body></html>`
  );
  check(
    "a heading inside a text-carrying wrapper emits its image once",
    srcs(wrappedHeading.doc).join() === "/h.png",
    JSON.stringify(wrappedHeading.doc?.content)
  );

  const nestedList = run(
    `<html><body><ul><li>outer<ul><li><img src="/n.png"/></li></ul></li></ul></body></html>`
  );
  check(
    "an image in a nested list is emitted once by the outer list's sweep",
    srcs(nestedList.doc).join() === "/n.png",
    JSON.stringify(srcs(nestedList.doc))
  );

  const headingThenList = run(
    `<html><body><h2><img src="/h.png"/></h2><p>mid</p><ul><li><img src="/l.png"/></li></ul></body></html>`
  );
  check(
    "headings and lists at the top level keep document order",
    srcs(headingThenList.doc).join() === "/h.png,/l.png" &&
      (headingThenList.doc?.content ?? []).map((n) => n.type).join() ===
        "heading,image,paragraph,bulletList,image",
    JSON.stringify((headingThenList.doc?.content ?? []).map((n) => n.type))
  );

  // The flattened-paragraph branch (a wrapper that does have text) was already
  // correct; it must stay that way.
  const withText = run(
    `<html><body><div>caption<img src="/x.png"/></div></body></html>`
  );
  check(
    "a wrapper carrying both text and an image emits one paragraph and one image",
    (withText.doc?.content ?? []).map((n) => n.type).join() === "paragraph,image" &&
      srcs(withText.doc).join() === "/x.png",
    JSON.stringify(withText.doc?.content)
  );

  const preWithImage = run(
    `<html><body><pre>console.log(&quot;kept&quot;)<img src="/code.png" alt="diagram"/></pre></body></html>`
  );
  check(
    "an image inside preformatted OneNote content is preserved after the code block",
    (preWithImage.doc?.content ?? []).map((n) => n.type).join() === "codeBlock,image" &&
      srcs(preWithImage.doc).join() === "/code.png",
    JSON.stringify(preWithImage.doc?.content)
  );
}

/* ---------------- End to end ---------------- */
async function waitFor(url, tries = 160) {
  while (tries-- > 0) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

cleanDatabase(root, DB_NAME);
console.log("\nPreparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "l@example.test", name: "L", username: "l", passwordHash: "x" },
});
await prisma.workspace.create({
  data: { name: "L", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", PORT: String(PORT) },
  stdio: "ignore",
  shell: process.platform === "win32",
});

const auth = {
  Cookie: `keel_session=${token}`,
  "Content-Type": "application/json",
  Origin: BASE,
  "Sec-Fetch-Site": "same-origin",
};
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: auth, body: JSON.stringify(b) }).then((r) => r.json());
const patch = (u, b) => fetch(BASE + u, { method: "PATCH", headers: auth, body: JSON.stringify(b) });
const get = (u) => fetch(BASE + u, { headers: auth }).then((r) => r.json());
const doc = (t) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  console.log("\nLinks between pages");
  const target = await post("/api/pages", { title: "Roadmap" });
  const source = await post("/api/pages", { title: "Weekly notes" });
  await patch(`/api/pages/${source.page.id}`, {
    content: doc("Reviewed [[Roadmap]] this morning. Tagged #planning and #work/q4."),
  });

  let data = await get(`/api/pages/${target.page.id}/backlinks`);
  check("a link creates a backlink", data.backlinks?.length === 1, JSON.stringify(data.backlinks));
  check("the backlink names the source", data.backlinks?.[0]?.title === "Weekly notes");
  check("the backlink carries context", Boolean(data.backlinks?.[0]?.excerpt), JSON.stringify(data.backlinks?.[0]));

  data = await get(`/api/pages/${source.page.id}/backlinks`);
  check("links are directional", data.backlinks?.length === 0, JSON.stringify(data.backlinks));

  console.log("\nForward links resolve later");
  await patch(`/api/pages/${source.page.id}`, {
    content: doc("Also see [[Not yet written]] when it exists."),
  });
  const created = await post("/api/pages", { title: "Not yet written" });
  data = await get(`/api/pages/${created.page.id}/backlinks`);
  check(
    "creating a page resolves links already pointing at its title",
    data.backlinks?.length === 1,
    JSON.stringify(data.backlinks)
  );

  console.log("\nRenaming");
  await patch(`/api/pages/${created.page.id}`, { title: "Now written" });
  data = await get(`/api/pages/${created.page.id}/backlinks`);
  check(
    "renaming detaches links that named the old title",
    data.backlinks?.length === 0,
    JSON.stringify(data.backlinks)
  );

  console.log("\nEditing removes stale links");
  await patch(`/api/pages/${source.page.id}`, { content: doc("Nothing links anywhere now.") });
  data = await get(`/api/pages/${target.page.id}/backlinks`);
  check("removing a link removes the backlink", data.backlinks?.length === 0, JSON.stringify(data.backlinks));

  console.log("\nTags");
  const tagged = await post("/api/pages", { title: "Tagged page" });
  await patch(`/api/pages/${tagged.page.id}`, {
    content: doc("Filed under #planning and #work/q4 for now."),
  });
  data = await get("/api/tags");
  const tags = (data.tags ?? []).map((t) => t.tag).sort();
  check("tags are collected", tags.includes("planning") && tags.includes("work/q4"), JSON.stringify(tags));

  data = await get("/api/tags?tag=planning");
  check("a tag lists its pages", data.pages?.length === 1 && data.pages[0].title === "Tagged page", JSON.stringify(data.pages));

  await patch(`/api/pages/${tagged.page.id}`, { content: doc("Untagged now.") });
  data = await get("/api/tags?tag=planning");
  check("removing a tag removes the page from it", data.pages?.length === 0, JSON.stringify(data.pages));

  console.log("\nTitle autocomplete");
  data = await get("/api/pages/lookup?q=Road");
  check("lookup finds by prefix", data.pages?.some((p) => p.title === "Roadmap"), JSON.stringify(data.pages));
  data = await get("/api/pages/lookup?q=Roadmap");
  check("lookup reports an exact match", data.exactMatch === true);
  data = await get("/api/pages/lookup?q=Nothing like this");
  check("lookup reports no exact match", data.exactMatch === false);

  // exactMatch is what stops the picker offering "create this page", so it
  // must see past the 20-row suggestion window: bury an exact title under 22
  // more recently updated pages that merely contain it.
  await post("/api/pages", { title: "Meeting" });
  for (let i = 0; i < 22; i++) await post("/api/pages", { title: `Meeting notes ${i}` });
  data = await get("/api/pages/lookup?q=Meeting");
  check(
    "an exact title beyond the 20-row window is still an exact match",
    data.exactMatch === true,
    JSON.stringify({ exactMatch: data.exactMatch, returned: data.pages?.length })
  );
  data = await get("/api/pages/lookup?q=meeting");
  check("case-insensitively", data.exactMatch === true, JSON.stringify(data.exactMatch));
  data = await get("/api/pages/lookup?q=Meeting notes");
  check(
    "while a title no page has exactly still offers creation",
    data.exactMatch === false,
    JSON.stringify(data.exactMatch)
  );

  console.log("\nIsolation");
  {
    const other = await testPrisma(root, DB_URL);
    const u2 = await other.user.create({
      data: { email: "o@example.test", name: "O", username: "o", passwordHash: "x" },
    });
    await other.workspace.create({
      data: { name: "O", ownerId: u2.id, members: { create: { userId: u2.id, role: "owner" } } },
    });
    const t2 = randomBytes(32).toString("hex");
    await other.session.create({
      data: { token: t2, userId: u2.id, expiresAt: new Date(Date.now() + 864e5) },
    });
    await other.$disconnect();

    const res = await fetch(`${BASE}/api/pages/${target.page.id}/backlinks`, {
      headers: { Cookie: `keel_session=${t2}` },
    });
    check("backlinks are workspace-scoped", res.status === 404, `got ${res.status}`);

    const tagRes = await fetch(`${BASE}/api/tags?tag=planning`, {
      headers: { Cookie: `keel_session=${t2}` },
    });
    const tagData = await tagRes.json();
    check("tags are workspace-scoped", (tagData.pages ?? []).length === 0, JSON.stringify(tagData));
  }
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  cleanDatabase(root, DB_NAME);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
