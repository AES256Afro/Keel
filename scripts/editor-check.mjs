#!/usr/bin/env node
// Editor behaviour that only exists in a browser.
//
// The `[[` page picker and the `/` block menu are ProseMirror suggestion
// plugins: they depend on real input events, real selection, and a real
// fetch. None of that is exercised by the API-level suites, so this drives a
// headless browser.
//
//   npm run build && node scripts/editor-check.mjs
//
// Env:
//   CHROMIUM   override the auto-detected Chromium (see find-chromium.mjs)
//   EDITOR_PORT
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";
import { cleanDatabase, prepareDatabase, testDatabaseUrl, testPrisma } from "./test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "editor-check";
const DB_URL = testDatabaseUrl(root, DB_NAME);
const PORT = Number(process.env.EDITOR_PORT || 3187);
const BASE = `http://127.0.0.1:${PORT}`;

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
console.log("Preparing scratch database…");
prepareDatabase(root, DB_URL);

const prisma = await testPrisma(root, DB_URL);
const user = await prisma.user.create({
  data: { email: "e@example.test", name: "E", username: "e", passwordHash: "x" },
});
const workspace = await prisma.workspace.create({
  data: { name: "E", ownerId: user.id, members: { create: { userId: user.id, role: "owner" } } },
});
const token = randomBytes(32).toString("hex");
await prisma.session.create({
  data: { token, userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
});
// A page to link TO, and a page to write IN.
await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Product roadmap",
    content: '{"type":"doc","content":[{"type":"paragraph"}]}',
    plainText: "",
    createdById: user.id,
    sortOrder: 1,
  },
});
const editing = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    type: "document",
    title: "Scratch",
    content: '{"type":"doc","content":[{"type":"paragraph"}]}',
    plainText: "",
    createdById: user.id,
    sortOrder: 2,
  },
});
await prisma.$disconnect();

console.log(`Starting server on :${PORT}…`);
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: DB_URL,
    NODE_ENV: "production",
    PORT: String(PORT),
    KEEL_SITE_URL: BASE,
  },
  stdio: "ignore",
  shell: process.platform === "win32",
});

let browser;
try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error("server did not start");

  browser = await chromium.launch({
    ...chromiumLaunchOptions(),
    // Chrome honours the system proxy; curl does not. A VPN or corporate PAC
    // file turned on mid-session will otherwise route 127.0.0.1 through it and
    // the test fails with a network error that looks like an app bug.
    args: ["--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: "keel_session", value: token, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const cspViolations = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window.__csp ??= []).push(e.violatedDirective + " <- " + e.blockedURI);
    });
  });

  page.on("response", (r) => {
    if (r.status() >= 400) console.log("  [http]", r.status(), r.url().slice(0, 120));
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  page.on("requestfailed", (r) => {
    // Next cancels in-flight RSC prefetches on navigation; that is normal and
    // would otherwise bury a real failure in noise.
    if (r.url().includes("_rsc=") && r.failure()?.errorText === "net::ERR_ABORTED") return;
    console.log("  [req failed]", r.url().slice(0, 90), "|", r.failure()?.errorText);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [console]", m.text().slice(0, 160));
  });

  await page.goto(`${BASE}/p/${editing.id}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".ProseMirror");
    check("the editor mounts", true);
  } catch {
    const url = page.url();
    const text = (await page.evaluate(() => document.body.innerText)).slice(0, 300);
    check("the editor mounts", false, `at ${url}: ${text.replace(/\s+/g, " ")}`);
    throw new Error("editor never mounted");
  }

  /* ---------------- The `[[` picker ---------------- */
  console.log("\nThe [[ page picker");
  await page.click(".ProseMirror");
  await page.keyboard.type("Depends on ");
  await page.keyboard.type("[[Product");
  // The picker fetches; give it a beat.
  await page.waitForTimeout(900);

  const pickerText = await page.evaluate(() => {
    const menus = [...document.body.children].filter(
      (el) => el instanceof HTMLElement && el.textContent?.includes("Product roadmap")
    );
    return menus.length ? menus[menus.length - 1].textContent : null;
  });
  check("the picker opens and offers a matching page", Boolean(pickerText), String(pickerText));

  // Enter accepts the highlighted entry.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const afterAccept = await page.evaluate(() => document.querySelector(".ProseMirror").innerText);
  check(
    "accepting inserts a finished [[link]]",
    afterAccept.includes("[[Product roadmap]]"),
    afterAccept.trim()
  );
  check("the picker closed", !(await page.evaluate(() =>
    [...document.body.children].some(
      (el) => el instanceof HTMLElement && el.textContent?.includes("Product roadmap") &&
        !el.querySelector(".ProseMirror") && getComputedStyle(el).position === "fixed"
    )
  )));

  /* ---------------- Creating a page from a link ---------------- */
  console.log("\nCreating a page that does not exist yet");
  await page.keyboard.type("and [[Brand new idea");
  await page.waitForTimeout(900);
  const createOffered = await page.evaluate(() =>
    [...document.body.children].some(
      (el) => el instanceof HTMLElement && /Create/.test(el.textContent ?? "")
    )
  );
  check("the picker offers to create a missing page", createOffered);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const created = await fetch(`${BASE}/api/pages/lookup?q=Brand new idea`, {
    headers: { Cookie: `keel_session=${token}` },
  }).then((r) => r.json());
  check(
    "accepting created the page",
    created.pages?.some((p) => p.title === "Brand new idea"),
    JSON.stringify(created.pages)
  );

  /* ---------------- The link is saved and indexed ---------------- */
  console.log("\nThe link reaches the database");
  // Autosave debounces 700ms.
  await page.waitForTimeout(1500);
  const roadmap = await fetch(`${BASE}/api/pages/lookup?q=Product roadmap`, {
    headers: { Cookie: `keel_session=${token}` },
  }).then((r) => r.json());
  const roadmapId = roadmap.pages?.find((p) => p.title === "Product roadmap")?.id;
  const backlinks = await fetch(`${BASE}/api/pages/${roadmapId}/backlinks`, {
    headers: { Cookie: `keel_session=${token}` },
  }).then((r) => r.json());
  check(
    "typing a link produces a backlink",
    backlinks.backlinks?.some((b) => b.title === "Scratch"),
    JSON.stringify(backlinks.backlinks)
  );

  /* ---------------- The `/` menu still works ---------------- */
  console.log("\nThe / block menu still works");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/head");
  await page.waitForTimeout(400);
  const slashOpen = await page.evaluate(() =>
    [...document.body.children].some(
      (el) => el instanceof HTMLElement && /Heading/i.test(el.textContent ?? "")
    )
  );
  check("the slash menu opens alongside the link picker", slashOpen);
  await page.keyboard.press("Escape");

  /* ---------------- Focus mode ---------------- */
  console.log("\nFocus mode");
  {
    await page.click(".ProseMirror");
    // Two paragraphs, so dimming has something to distinguish.
    await page.keyboard.press("Enter");
    await page.keyboard.type("First paragraph here.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second paragraph, where the caret now sits.");
    await page.waitForTimeout(300);

    const wordCount = await page.evaluate(() =>
      [...document.querySelectorAll("span")].map((s) => s.textContent).find((t) => /\d+ words/.test(t ?? ""))
    );
    check("a live word count is shown", Boolean(wordCount), String(wordCount));

    // The caret's block is tagged so CSS can un-dim it.
    const activeText = await page.evaluate(
      () => document.querySelector(".keel-active-block")?.textContent ?? null
    );
    check(
      "the caret's block is marked active",
      (activeText ?? "").includes("Second paragraph"),
      String(activeText)
    );

    await page.keyboard.press("Control+Shift+F");
    await page.waitForTimeout(300);
    let classes = await page.evaluate(() => document.documentElement.className);
    check("the shortcut enters focus mode", classes.includes("keel-focus"), classes);
    check("dimming is on by default", classes.includes("keel-focus-dim"), classes);

    const barText = await page.evaluate(() => {
      const bar = [...document.body.children].find(
        (el) => el instanceof HTMLElement && /Typewriter/.test(el.textContent ?? "")
      );
      return bar?.textContent ?? null;
    });
    check("the focus bar appears", Boolean(barText), String(barText));

    // Turning dimming off must persist and take effect immediately.
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
      const dim = boxes.find((b) => b.parentElement?.textContent?.includes("Dim"));
      dim?.click();
    });
    await page.waitForTimeout(300);
    classes = await page.evaluate(() => document.documentElement.className);
    check("dimming can be turned off", !classes.includes("keel-focus-dim"), classes);
    const stored = await page.evaluate(() => window.localStorage.getItem("keel-focus"));
    check("the preference is remembered", (stored ?? "").includes('"dimSurroundings":false'), String(stored));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    classes = await page.evaluate(() => document.documentElement.className);
    check("Escape leaves focus mode", !classes.includes("keel-focus"), classes);
  }

  /* ---------------- Autosave tells the truth ---------------- */
  console.log("\nAutosave reports failure instead of lying");
  {
    // Make every save fail, then type. The indicator used to say "Saved"
    // regardless of the response, which is silent data loss.
    await page.route("**/api/pages/**", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 413,
            contentType: "application/json",
            body: JSON.stringify({ error: "This page is too large (limit 2 MB)." }),
          })
        : route.continue()
    );

    await page.click(".ProseMirror");
    await page.keyboard.type(" doomed edit");
    // Debounce + the retry ladder (4xx stops immediately).
    await page.waitForTimeout(2500);

    const banner = await page.evaluate(() => {
      const el = document.querySelector('[role="alert"]');
      return el ? el.textContent : null;
    });
    check("a rejected save is surfaced", Boolean(banner), String(banner));
    check("the reason is shown", (banner ?? "").includes("too large"), String(banner));
    check("it never claims to be saved", !/\bSaved\b/.test(banner ?? ""), String(banner));

    const hasRetry = await page.evaluate(() =>
      [...document.querySelectorAll('[role="alert"] button')].some((b) =>
        /try again/i.test(b.textContent ?? "")
      )
    );
    check("a retry is offered", hasRetry);

    // Let saves through again and retry - the banner should clear.
    await page.unroute("**/api/pages/**");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[role="alert"] button')].find((b) =>
        /try again/i.test(b.textContent ?? "")
      );
      btn?.click();
    });
    await page.waitForTimeout(1500);
    const cleared = await page.evaluate(() => !document.querySelector('[role="alert"]'));
    check("retrying clears the error once the save succeeds", cleared);
  }

  /* ---------------- CSP ---------------- */
  console.log("\nContent-Security-Policy");
  const violations = await page.evaluate(() => window.__csp ?? []);
  cspViolations.push(...violations);
  check("no CSP violations during editing", cspViolations.length === 0, cspViolations.join(", "));

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Chrome speculatively re-requests a plain-HTTP origin over https (HTTPS-
    // First Mode) and logs the refusal. It is the browser's own behaviour
    // against a localhost dev server, not the page's - a real defect would
    // have to show up as something other than the scheme upgrade being
    // refused, so match narrowly rather than muting the whole check.
    if (/ERR_SSL_PROTOCOL_ERROR/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("no console errors after reload", consoleErrors.length === 0, consoleErrors.join(" | "));

  /* ---------------- Backlinks render ---------------- */
  console.log("\nThe backlinks pane");
  await page.goto(`${BASE}/p/${roadmapId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const paneText = await page.evaluate(() => document.body.innerText);
  check("the backlinks pane lists the linking page", paneText.includes("Linked from"), "");
  check("and names it", paneText.includes("Scratch"));

  /* ---------------- Restoring from the trash ---------------- */
  console.log("\nRestoring a trashed page");
  {
    // useEditor re-applies its options as `{ ...options, editable:
    // editor.isEditable }` - it pins `editable` to what the instance already
    // has - so the prop alone could never re-enable the document. Restoring
    // dropped the banner and left ProseMirror contentEditable=false, silently
    // swallowing everything typed until a hard reload.
    await page.evaluate(
      (id) =>
        fetch(`/api/pages/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        }).then((r) => r.ok),
      editing.id
    );
    await page.goto(`${BASE}/p/${editing.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".ProseMirror");
    const contentEditable = () =>
      page.evaluate(() => document.querySelector(".ProseMirror")?.getAttribute("contenteditable"));
    check("a trashed page opens read-only", (await contentEditable()) === "false", String(await contentEditable()));

    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /^restore$/i.test((b.textContent ?? "").trim())
      );
      btn?.click();
      return Boolean(btn);
    });
    check("the banner offers Restore", clicked);
    await page.waitForTimeout(2000);
    check(
      "the editor is writable again without a reload",
      (await contentEditable()) === "true",
      String(await contentEditable())
    );

    await page.click(".ProseMirror");
    await page.keyboard.type("back in business");
    await page.waitForTimeout(300);
    const typed = await page.evaluate(() => document.querySelector(".ProseMirror").innerText);
    check("and it accepts what you type", typed.includes("back in business"), typed.trim().slice(0, 80));
  }
} finally {
  await browser?.close().catch(() => {});
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
