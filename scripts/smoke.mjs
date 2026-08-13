// End-to-end smoke test. Drives a real browser through the core flows:
// register → edit blocks → nest pages → database → record page → search →
// export → trash/restore → logout/login.
//
// Usage:
//   npm run build && npm start        (in one terminal)
//   npm run test:e2e                  (in another)
//
// Env:
//   BASE_URL   target app (default http://localhost:3000)
//   CHROMIUM   override the auto-detected Chromium (see find-chromium.mjs)
//   SHOT_DIR   directory for failure screenshots (default: skip screenshots)

import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./find-chromium.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const APP_ORIGIN = new URL(BASE).origin;
const EMAIL = `smoke${Date.now()}@example.com`;
const SHOT_DIR = process.env.SHOT_DIR;
const SELECT_ALL = process.platform === "darwin" ? "Meta+a" : "Control+a";
const OPEN_SEARCH = process.platform === "darwin" ? "Meta+k" : "Control+k";

const results = [];
const ok = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
};

const mutationHeaders = (cookie) => ({
  ...(cookie ? { cookie } : {}),
  "Content-Type": "application/json",
  Origin: APP_ORIGIN,
  "Sec-Fetch-Site": "same-origin",
});

/** Poll the notifications API until a predicate matches (tolerates write lag). */
async function pollNotifications(cookieHeader, predicate, tries = 10) {
  while (tries-- > 0) {
    const res = await fetch(`${BASE}/api/notifications`, {
      headers: { cookie: cookieHeader },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && predicate(data)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const browser = await chromium.launch(
  chromiumLaunchOptions()
);
const page = await browser.newPage();
page.setDefaultTimeout(15000);

try {
  // 0. Health endpoint (used by the desktop shell to detect a running server)
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => ({}));
  ok("health endpoint identifies keel", health.app === "keel");

  // 1. Register
  await page.goto(`${BASE}/register`);
  await page.fill('input[name="name"]', "Smoke Tester");
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/welcome$/);
  ok("register redirects to the first-run tour", true);
  await page.waitForSelector("text=Welcome to Keel");
  ok("welcome page visible", true);
  await page.click('button:text-is("Take me to my notes →")');
  await page.waitForURL(/\/p\//);
  ok("finishing the tour opens the first page", true);
  ok(
    "sidebar shows Getting started",
    await page.locator("aside >> text=Getting started").isVisible()
  );

  // 2. Editor: markdown shortcut + slash menu
  await page.locator(".keel-editor .ProseMirror").click();
  await page.keyboard.press(SELECT_ALL);
  await page.keyboard.press("Delete");
  await page.keyboard.type("Hello from the smoke test.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Markdown heading");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/quote");
  await page.waitForSelector("text=Capture a quote");
  await page.locator('button:has-text("Capture a quote")').click();
  await page.keyboard.type("A quoted line");
  await page.waitForSelector(".keel-editor blockquote");
  ok("slash menu inserts a quote block", true);
  ok("markdown heading created", (await page.locator(".keel-editor h2").count()) >= 1);
  await page.waitForSelector("text=Saved");
  await page.waitForTimeout(1200); // let autosave flush

  // 3. Create a nested page via sidebar hover "+"
  const beforeChild = page.url();
  const gettingStarted = page.locator("aside .group", { hasText: "Getting started" }).first();
  await gettingStarted.hover();
  await gettingStarted.locator('button[aria-label="Add page inside"]').click();
  await page.waitForURL((u) => u.href !== beforeChild && u.pathname.startsWith("/p/"));
  await page.waitForSelector(".keel-editor .ProseMirror");
  await page.fill('input[placeholder="Untitled"]', "Nested child page");
  await page.waitForSelector("aside >> text=Nested child page", { timeout: 10000 });
  ok("nested page created and titled", true);

  // 4. Create a database
  const beforeDb = page.url();
  await page.click('aside button[title="New database"]');
  await page.waitForURL((u) => u.href !== beforeDb && u.pathname.startsWith("/p/"));
  await page.waitForSelector('button:has-text("Board")');
  await page.fill('input[placeholder="Untitled database"]', "Tasks");
  await page.waitForTimeout(800);
  ok("database page opens with toolbar", true);

  // 5. Add a record in table view, set title + status
  await page.click("text=+ New record");
  await page.waitForSelector('table input[placeholder="Untitled"]');
  await page.fill('table input[placeholder="Untitled"]', "Ship MVP");
  const statusSelect = page.locator("table tbody tr").first().locator("select").first();
  await statusSelect.selectOption({ label: "In progress" });
  await page.waitForTimeout(600);
  ok("record created with title and status", true);

  // 6. Board view shows the card in the right column
  await page.click('button:text-is("Board")');
  ok("board view renders columns", await page.locator("text=No Status").isVisible());
  ok("card appears on board", await page.locator("text=Ship MVP").isVisible());

  // 7. Open record as page, check properties panel + body editor
  await page.click('button:text-is("Table")');
  const row = page.locator("table tbody tr").first();
  await row.hover();
  await row.locator("text=Open ↗").click();
  await page.waitForSelector("text=Status");
  await page.locator(".keel-editor .ProseMirror").click();
  await page.keyboard.type("Record body content");
  await page.waitForTimeout(1200);
  ok(
    "record opens as page with properties and editor",
    await page.locator("main nav >> text=Tasks").isVisible()
  );

  // 8. Search (Command/Ctrl+K)
  await page.keyboard.press(OPEN_SEARCH);
  await page.fill('input[placeholder^="Search"]', "Ship");
  await page.waitForSelector("text=Ship MVP");
  await page.keyboard.press("Escape");
  ok("search finds the record", true);

  // 9. Exports via authenticated fetch
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const recordPageId = page.url().split("/p/")[1];
  const mdRes = await fetch(`${BASE}/api/pages/${recordPageId}/export`, {
    headers: { cookie: cookieHeader },
  });
  const mdText = await mdRes.text();
  ok("markdown export works", mdRes.ok && mdText.includes("Record body content"));

  await page.click("main nav >> text=Tasks");
  await page.waitForSelector('a[href*="/export"]');
  const csvHref = await page.locator('a[href^="/api/databases/"]').getAttribute("href");
  const csvRes = await fetch(`${BASE}${csvHref}`, { headers: { cookie: cookieHeader } });
  const csvText = await csvRes.text();
  ok("csv export works", csvRes.ok && csvText.includes("Ship MVP") && csvText.includes("Status"));

  // 10. Trash + restore
  const beforeTrash = page.url();
  await page.click('button[title="Move to trash"]');
  await page.waitForURL((u) => u.href !== beforeTrash);
  await page.goto(`${BASE}/trash`);
  await page.waitForSelector('button:text-is("Restore")');
  await page.click('button:text-is("Restore")');
  await page.waitForSelector("aside >> text=Tasks", { timeout: 10000 });
  ok("trash and restore works", true);

  // 11. Templates: create a Task tracker from the picker
  const beforeTemplate = page.url();
  await page.click('aside button:has-text("Templates")');
  await page.waitForSelector("text=New from template");
  await page.click('button:has-text("Task tracker")');
  await page.waitForURL((u) => u.href !== beforeTemplate && u.pathname.startsWith("/p/"));
  await page.waitForSelector('a:text-is("My first task")');
  ok("template creates a populated board", true);

  // 12. Duplicate the database from the page header
  const beforeDup = page.url();
  await page.click('button:has-text("⧉ Duplicate")');
  await page.waitForURL((u) => u.href !== beforeDup && u.pathname.startsWith("/p/"));
  await page.waitForSelector('a:text-is("My first task")');
  const dupTitle = await page.locator('input[placeholder="Untitled database"]').inputValue();
  ok(
    "duplicate deep-copies a database",
    dupTitle === "Task tracker (copy)"
  );

  // 13. Settings: rename workspace
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector("text=Backups & data safety");
  const nameInput = page.locator('label:has(span:text-is("Workspace name")) input').first();
  await nameInput.fill("Renamed Vault");
  await page.click('button:text-is("Rename")');
  await page.waitForSelector("aside >> text=Renamed Vault", { timeout: 10000 });
  ok("workspace rename works", true);

  // 14. Backup now + listed in folder
  const initialBackupResponse = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/workspace/backups" &&
      res.request().method() === "POST"
  );
  await page.click('button:text-is("Back up now")');
  const initialBackup = await (await initialBackupResponse).json();
  await page.waitForSelector("text=/^Backup .+ written(?: and uploaded to .+)?$/");
  const initialBackupRow = page.locator("li", { hasText: initialBackup.file });
  await initialBackupRow.waitFor();
  ok("backup to folder works and is listed", typeof initialBackup.file === "string");

  // 15. Restore the folder backup (non-destructive)
  page.once("dialog", (d) => d.accept());
  await initialBackupRow.locator('button:text-is("Restore")').click();
  await page.waitForSelector("text=Restored", { timeout: 15000 });
  ok("restore from folder backup works", true);

  const wsCookies = await page.context().cookies();
  const wsCookieHeader = wsCookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // 15b. Encrypted manual backup via either the host-managed secret or the
  // masked passphrase dialog.
  await page.click('label:has-text("Encrypt backups") input');
  const encryptedUiBackupResponse = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/workspace/backups" &&
      res.request().method() === "POST"
  );
  await page.click('button:text-is("Back up now")');
  const backupPassphrase = page.locator('input[type="password"][placeholder="Passphrase"]');
  const backupPromptVisible = await backupPassphrase
    .waitFor({ state: "visible", timeout: 1_000 })
    .then(() => true)
    .catch(() => false);
  if (backupPromptVisible) {
    await backupPassphrase.fill("dialog-pass-123");
    await page.click('button:text-is("OK")');
  }
  const encryptedUiBackup = await (await encryptedUiBackupResponse).json();
  await page.waitForSelector("text=/^Backup .+\\.keelbak written(?: and uploaded to .+)?$/");
  await page.locator("li", { hasText: encryptedUiBackup.file }).waitFor();
  ok(
    "encrypted backup uses a managed or masked passphrase",
    typeof encryptedUiBackup.file === "string" && encryptedUiBackup.file.endsWith(".keelbak")
  );

  // 15c. Create a known-passphrase encrypted backup through the same API, then
  // restore that exact file. This is deterministic even when the guided
  // installer supplied a write-only managed passphrase to the UI.
  const knownBackupRes = await fetch(`${BASE}/api/workspace/backups`, {
    method: "POST",
    headers: mutationHeaders(wsCookieHeader),
    body: JSON.stringify({ encrypt: true, passphrase: "dialog-pass-123" }),
  });
  const knownBackup = await knownBackupRes.json().catch(() => ({}));
  ok(
    "known-passphrase encrypted backup can be created",
    knownBackupRes.ok && typeof knownBackup.file === "string" && knownBackup.file.endsWith(".keelbak")
  );
  if (!knownBackupRes.ok || typeof knownBackup.file !== "string") {
    throw new Error("Could not create the known-passphrase encrypted backup");
  }
  await page.reload();
  await page.waitForSelector("text=Backups & data safety");
  const knownBackupRow = page.locator("li", { hasText: knownBackup.file });
  await knownBackupRow.waitFor();
  page.once("dialog", (d) => d.accept());
  await knownBackupRow.locator('button:text-is("Restore")').click();
  const restorePassphrase = page.locator('input[type="password"][placeholder="Passphrase"]');
  await restorePassphrase.waitFor({ state: "visible" });
  await restorePassphrase.fill("dialog-pass-123");
  await page.click('button:text-is("OK")');
  await page.waitForSelector("text=Restored", { timeout: 15000 });
  ok("encrypted folder backup restores with passphrase", true);

  // 16. Encrypted export/import round trip via API
  const expRes = await fetch(`${BASE}/api/workspace/export`, {
    method: "POST",
    headers: mutationHeaders(wsCookieHeader),
    body: JSON.stringify({ passphrase: "secret-passphrase-123" }),
  });
  const encText = await expRes.text();
  ok(
    "encrypted workspace export works",
    expRes.ok && encText.includes("keel-backup-encrypted")
  );
  const badForm = new FormData();
  badForm.set("file", new File([encText], "b.keelbak"));
  badForm.set("passphrase", "wrong-passphrase");
  const badRes = await fetch(`${BASE}/api/workspace/import`, {
    method: "POST",
    headers: {
      cookie: wsCookieHeader,
      Origin: APP_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
    },
    body: badForm,
  });
  ok("wrong passphrase is rejected", badRes.status === 400);
  const goodForm = new FormData();
  goodForm.set("file", new File([encText], "b.keelbak"));
  goodForm.set("passphrase", "secret-passphrase-123");
  const goodRes = await fetch(`${BASE}/api/workspace/import`, {
    method: "POST",
    headers: {
      cookie: wsCookieHeader,
      Origin: APP_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
    },
    body: goodForm,
  });
  const goodData = await goodRes.json().catch(() => ({}));
  ok("encrypted restore works", goodRes.ok && goodData.restored >= 1);

  // 17. Dark mode toggle applies immediately
  const bgBecomes = (color) =>
    page
      .waitForFunction(
        (expected) => getComputedStyle(document.body).backgroundColor === expected,
        color,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
  await page.click('button:has-text("🌙 Dark")');
  ok("dark mode applies", await bgBecomes("rgb(25, 25, 25)"));
  await page.click('button:has-text("☀️ Light")');
  ok("light mode applies", await bgBecomes("rgb(255, 255, 255)"));
  await page.click('button:has-text("🌙 Dark")');
  await page.reload();
  await page.waitForSelector("text=Backups & data safety");
  const persistedTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  ok("theme persists across reload via cookie", persistedTheme === "dark");
  await page.click('button:has-text("🖥️ System")');

  // 18. Identity privacy: real name never in the sidebar; avatar menu shows @username
  ok(
    "real name is not shown in the sidebar",
    (await page.locator("aside >> text=Smoke Tester").count()) === 0
  );
  const expectedUsername = EMAIL.split("@")[0];
  const avatarLetter = await page
    .locator('aside button[aria-label="Account menu"]')
    .textContent();
  ok(
    "avatar shows first letter of username",
    avatarLetter?.trim() === expectedUsername[0].toUpperCase()
  );
  await page.click('aside button[aria-label="Account menu"]');
  await page.waitForSelector(`text=@${expectedUsername}`);
  ok("account menu shows the username", true);
  await page.keyboard.press("Escape");
  await page.click("body"); // close the menu

  // 19. Change username in Settings
  const newUsername = `renamed${Date.now()}`;
  await page.locator('label:has(span:text-is("Username")) input').fill(newUsername);
  await page.click('label:has(span:text-is("Username")) button:text-is("Save")');
  await page.waitForSelector("text=Username updated.");
  await page.click('aside button[aria-label="Account menu"]');
  await page.waitForSelector(`text=@${newUsername}`);
  ok("username can be changed in settings", true);

  // 20. Sharing: invite a not-yet-registered viewer by email
  const guestEmail = `guest${Date.now()}@example.com`;
  await page.waitForSelector("text=Members & sharing");
  await page.fill('input[placeholder="person@example.com"]', guestEmail);
  await page
    .locator('section:has-text("Members & sharing") select')
    .first()
    .selectOption("viewer");
  await page.click('button:text-is("Invite")');
  const pendingGuestInvite = page
    .locator("li", { hasText: guestEmail })
    .filter({ hasText: "Pending invite" });
  await pendingGuestInvite.waitFor();
  ok("owner can invite by email before the person registers", true);

  // 21. The guest registers; password signup leaves the invite pending until
  // the owner explicitly confirms the now-existing account.
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  guest.setDefaultTimeout(15000);
  await guest.goto(`${BASE}/register`);
  await guest.fill('input[name="name"]', "Guest User");
  await guest.fill('input[name="email"]', guestEmail);
  await guest.fill('input[name="password"]', "password123");
  await guest.click('button[type="submit"]');
  await guest.waitForURL(/\/welcome$/);
  await guest.click('button:text-is("Skip all of this")');
  await guest.waitForURL(/\/p\//);
  // Password registration intentionally leaves an email invite pending because
  // it cannot prove control of that mailbox. The workspace owner confirms the
  // now-existing account by inviting it again.
  await page.bringToFront();
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector("text=Members & sharing");
  await pendingGuestInvite.waitFor();
  ok("password registration leaves the email invite pending", true);
  await page.fill('input[placeholder="person@example.com"]', guestEmail);
  await page
    .locator('section:has-text("Members & sharing") select')
    .first()
    .selectOption("viewer");
  await page.click('button:text-is("Invite")');
  const confirmedGuestRow = page.locator("li", { hasText: guestEmail });
  await confirmedGuestRow.locator("select").waitFor();
  ok(
    "owner confirmation converts the pending invite into one member",
    (await confirmedGuestRow.count()) === 1 &&
      (await confirmedGuestRow.filter({ hasText: "Pending invite" }).count()) === 0
  );
  await guest.bringToFront();
  await guest.reload();
  // Switch to the shared workspace through the exact current-workspace header.
  await guest.getByTitle("Guest User's Workspace", { exact: true }).click();
  await guest.locator("aside").getByText("Workspaces", { exact: true }).waitFor();
  const beforeWorkspaceSwitch = guest.url();
  const switched = guest.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/workspace/switch" &&
      res.request().method() === "POST" &&
      res.ok()
  );
  await guest.locator("aside button").filter({ hasText: "Renamed Vault" }).click();
  await switched;
  await guest.waitForURL((url) => url.href !== beforeWorkspaceSwitch && url.pathname.startsWith("/p/"));
  await guest.locator('aside button[title="Renamed Vault"]').waitFor();
  ok("invited user can switch into the shared workspace", true);

  // 22. Viewer is read-only: no create buttons, mutations rejected server-side
  ok(
    "viewer sees no create buttons",
    (await guest.locator('aside button[title="New page"]').count()) === 0
  );
  const guestCookies = await guestCtx.cookies();
  const guestCookieHeader = guestCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const forbidden = await fetch(`${BASE}/api/pages`, {
    method: "POST",
    headers: mutationHeaders(guestCookieHeader),
    body: JSON.stringify({ type: "document" }),
  });
  ok("viewer page creation is rejected with 403", forbidden.status === 403);

  // 23. Owner promotes the guest to editor; guest can now create pages
  await page.reload();
  await page.waitForSelector("text=Members & sharing");
  const guestRow = page.locator("li", { hasText: guestEmail });
  await guestRow.locator("select").selectOption("editor");
  await page.waitForTimeout(600);
  const allowed = await fetch(`${BASE}/api/pages`, {
    method: "POST",
    headers: mutationHeaders(guestCookieHeader),
    body: JSON.stringify({ type: "document" }),
  });
  ok("promoted editor can create pages", allowed.status === 201);

  // 23a. Task manager: assign the guest via a Person property → notification
  const guestUsername = guestEmail.split("@")[0];
  await page.click("aside >> text=Tasks");
  await page.waitForSelector('button:text-is("+ Property")');
  await page.click('button:text-is("+ Property")');
  await page.fill('input[placeholder="Property name"]', "Assignee");
  await page
    .locator('input[placeholder="Property name"] + select')
    .selectOption("person");
  await page.click('button:text-is("Add")');
  const taskRow = page.locator("table tbody tr").first();
  await taskRow.locator("select").nth(1).selectOption({ label: `@${guestUsername}` });
  await page.waitForTimeout(600);
  ok(
    "assigning a person notifies them",
    await pollNotifications(guestCookieHeader, (d) =>
      d.notifications?.some((n) => n.message.includes("assigned you"))
    )
  );

  // 23a2. Progress property renders a slider and percentage
  await page.click('button:text-is("+ Property")');
  await page.fill('input[placeholder="Property name"]', "Progress");
  await page
    .locator('input[placeholder="Property name"] + select')
    .selectOption("progress");
  await page.click('button:text-is("Add")');
  await taskRow.locator('input[type="range"]').fill("60");
  await page.waitForSelector("table >> text=60%");
  ok("progress property tracks percent complete", true);

  // 23b. Comments with @mention → notification for the mentioned member
  await page.click("aside >> text=Getting started");
  // Wait for content unique to the destination page (typed in step 2)  -  the
  // Tasks page also has a comments panel, so waiting on the panel alone
  // races the client-side navigation.
  await page.waitForSelector("text=Hello from the smoke test");
  await page.waitForSelector("text=💬 Comments");
  await page.fill(
    'textarea[placeholder^="Add a comment"]',
    `Great work @${guestUsername}  -  please review.`
  );
  await page.click('button:text-is("Comment")');
  await page.waitForSelector("text=please review");
  ok("comment with mention posts", true);
  ok(
    "mention creates a notification",
    await pollNotifications(
      guestCookieHeader,
      (d) => d.unreadCount >= 1 && d.notifications?.some((n) => n.message.includes("mentioned you"))
    )
  );

  // 23c. Resolve the comment
  await page.click('button:has-text("✓ Resolve")');
  await page.waitForSelector("text=Show 1 resolved");
  ok("comment can be resolved", true);

  // 24. Owner removes the member
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector("text=Members & sharing");
  page.once("dialog", (d) => d.accept());
  await guestRow.locator('button:text-is("Remove")').click();
  await page.waitForTimeout(600);
  ok(
    "owner can remove a member",
    (await page.locator("li", { hasText: guestEmail }).count()) === 0
  );
  await guestCtx.close();

  // 25. Logout (via account menu) + login
  await page.click('aside button[aria-label="Account menu"]');
  await page.click('button:text-is("← Sign out")');
  await page.waitForURL(/\/login/);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/p\//);
  ok("logout and login works", true);

  // 26. Favorites & recent pages
  await page.waitForSelector("text=💬 Comments");
  await page.click('button:has-text("☆ Favorite")');
  await page.waitForSelector("aside >> text=Favorites", { timeout: 10000 });
  ok("favorite adds page to sidebar favorites", true);
  await page.waitForSelector("aside >> text=Recent");
  ok("recent pages appear in the sidebar", true);

  // 27. Desktop Google-sign-in handoff endpoints (no OAuth creds needed  - 
  // these back the system-browser sign-in the Electron shell drives).
  const statusRes = await fetch(`${BASE}/api/auth/desktop-status?id=nope`);
  const statusJson = await statusRes.json();
  ok("desktop-status reports not-ready for an unknown id", statusJson.ready === false);

  const claimRes = await fetch(`${BASE}/api/auth/desktop-claim?id=nope`, {
    redirect: "manual",
  });
  ok(
    "desktop-claim rejects an unknown id",
    (claimRes.headers.get("location") ?? "").includes("desktop-link-expired")
  );

  const linkedRes = await fetch(`${BASE}/desktop-linked`);
  ok("desktop-linked page renders", linkedRes.ok);

  // 28. Google sign-in / cloud backup surface (only when the server under
  // test has OAuth credentials configured; set EXPECT_GOOGLE=1 to enforce).
  if (process.env.EXPECT_GOOGLE) {
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/login`);
    await anonPage.waitForSelector("text=Continue with Google");
    ok("login page offers Google sign-in", true);
    await anon.close();

    const authRes = await fetch(`${BASE}/api/auth/google`, { redirect: "manual" });
    const loc = authRes.headers.get("location") ?? "";
    ok(
      "google auth redirects to accounts.google.com",
      loc.startsWith("https://accounts.google.com/")
    );

    // Desktop flow carries a handoff id through and records it for the callback.
    const desktopId = "a".repeat(64);
    const dRes = await fetch(`${BASE}/api/auth/google?desktop=${desktopId}`, {
      redirect: "manual",
    });
    const setCookie = dRes.headers.get("set-cookie") ?? "";
    ok(
      "google auth remembers the desktop handoff id",
      setCookie.includes(`keel-oauth-desktop=${desktopId}`)
    );

    await page.goto(`${BASE}/settings`);
    await page.waitForSelector("text=Cloud backups (Google Drive / OneDrive)");
    await page.waitForSelector("text=Connect Google Drive");
    await page.waitForSelector("text=Connect OneDrive");
    ok("settings offers cloud backup connections", true);
  }
} catch (err) {
  results.push(`ERROR ${err.message}`);
  process.exitCode = 1;
  if (SHOT_DIR) {
    try {
      await page.screenshot({ path: `${SHOT_DIR}/smoke-error.png` });
    } catch {}
  }
}

console.log(results.join("\n"));
await browser.close();
