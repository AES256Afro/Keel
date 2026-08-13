import { readFileSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { BackupInProgressError, backupBackoff, runBackup } from "@/lib/backup";
import { runMaintenance } from "@/lib/maintenance";
import { documentToPlainText } from "@/lib/plaintext";
import { keelEnv } from "@/lib/env";
import { ensureSchema } from "@/lib/schema-migrate";
import { singleFlightBackupTick } from "@/lib/backup-single-flight";

const CHECK_EVERY_MS = 5 * 60 * 1000;
/** Retention runs far less often than the backup check - hourly is plenty. */
const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

const g = globalThis as unknown as {
  __keelServerInit?: boolean;
  __keelInitPromise?: Promise<void>;
};


/** Await one-time init exactly once; safe to call on every request. */
export function initServerOnce(): Promise<void> {
  return (g.__keelInitPromise ??= initServer().catch((err) => {
    console.error("[keel] server init failed", err);
  }));
}

/**
 * Load credentials from a plain `.env`-style file into process.env.
 *
 * The packaged desktop app bundles Next.js in `standalone` mode, and a
 * standalone server does NOT auto-load `.env` files the way `next dev` /
 * `next start` do. Without this, GOOGLE_* / MS_* credentials placed in a file
 * would be invisible to the embedded server and "Continue with Google" would
 * never appear. We read (in order) an explicit KEEL_ENV_FILE and a `.env`
 * next to the server, setting only keys that aren't already defined - so real
 * environment variables and the desktop shell's injected values always win.
 */
function loadEnvFiles() {
  const candidates = [
    keelEnv("ENV_FILE"),
    path.join(process.cwd(), ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue; // missing file is fine
    }
    for (const line of contents.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // never override
      process.env[key] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

/**
 * Fill in Page.plainText for rows written before the column existed.
 *
 * Flattening ProseMirror JSON is not something to attempt in SQL, so the
 * migration adds the column and this fills it. Runs in the background in small
 * batches - an existing workspace should not block its first request on
 * re-indexing, and until a page is backfilled it is simply findable by title.
 */
const BACKFILL_DONE_KEY = "plainText.backfilled";

async function backfillPlainText() {
  let done = 0;
  try {
    // O(1) steady state: once every row has been indexed, a flag short-circuits
    // this on every subsequent boot. New pages always write plainText, so no
    // nulls reappear - the backfill is genuinely one-time.
    const flag = await prisma.appSetting.findUnique({ where: { key: BACKFILL_DONE_KEY } }).catch(() => null);
    if (flag) return;

    // Filter on `plainText IS NULL` and page forward by id cursor. Because each
    // batch's rows are the null rows just past the cursor and are then filled,
    // no row is visited twice - one O(n) pass over the rows that need work, not
    // the O(n²) re-scan-from-the-start the first cursor rewrite regressed into,
    // and not a full-table walk when there is nothing to do.
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.page.findMany({
        where: { plainText: null, content: { not: null } },
        select: { id: true, content: true },
        orderBy: { id: "asc" },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      // One transaction per batch instead of N round trips, scoped per page so
      // a row deleted between read and write skips rather than aborting.
      await prisma.$transaction(
        batch.map((page) =>
          prisma.page.updateMany({
            where: { id: page.id, plainText: null },
            // Empty string, not null: null means "not yet indexed", and a page
            // whose document really is empty must not recur forever.
            data: { plainText: documentToPlainText(page.content) || "" },
          })
        )
      );
      done += batch.length;
      // Yield between batches so this never competes with serving requests.
      await new Promise((r) => setTimeout(r, 50));
    }

    // Record completion so future boots skip the scan entirely.
    await prisma.appSetting
      .upsert({
        where: { key: BACKFILL_DONE_KEY },
        create: { key: BACKFILL_DONE_KEY, value: new Date().toISOString() },
        update: {},
      })
      .catch(() => {});
    if (done > 0) console.log(`[keel] search index backfilled for ${done} pages`);
  } catch (err) {
    // Don't set the flag on failure - the next boot retries from where the
    // cursor filter naturally resumes (the remaining null rows).
    console.error(`[keel] plainText backfill stopped after ${done} pages`, err);
  }
}

/**
 * One-time server startup work, triggered lazily from the first server-side
 * request (see ensureServerInit in src/lib/auth.ts). Not an instrumentation
 * hook on purpose: `next dev` also bundles instrumentation.ts for non-Node
 * contexts, where the fs/crypto imports below cannot resolve.
 *
 * 1. Crash safety - switch SQLite to WAL journal mode. WAL keeps committed
 *    transactions durable even if the process is killed mid-write, so a sudden
 *    server shutdown cannot corrupt the database or lose acknowledged saves.
 *    (journal_mode is persistent, so a late first request changes nothing.)
 * 2. Automatic backups - a lightweight scheduler that snapshots each workspace
 *    with backups enabled on its configured interval.
 */
export async function initServer() {
  if (g.__keelServerInit) return;
  g.__keelServerInit = true;

  loadEnvFiles();
  await ensureSchema();
  void backfillPlainText();

  if ((process.env.DATABASE_URL ?? "").startsWith("file:")) {
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
      await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
      console.log("[keel] SQLite WAL mode enabled (crash-safe writes)");
    } catch (err) {
      console.error("[keel] failed to enable WAL mode", err);
    }
  }

  const tickWork = async () => {
    try {
      const workspaces = await prisma.workspace.findMany({
        where: { backupEnabled: true },
      });
      for (const ws of workspaces) {
        const interval = ws.backupIntervalHours * 60 * 60 * 1000;
        const due =
          !ws.lastBackupAt || Date.now() - ws.lastBackupAt.getTime() >= interval;
        if (!due) continue;
        // A failing backup never advances lastBackupAt (that would make
        // Settings claim a backup happened), and the due-check reads only
        // lastBackupAt - so without this the workspace stayed permanently due
        // and was retried on EVERY five-minute tick, forever.
        if (!backupBackoff.ready(ws.id)) continue;
        try {
          const { file } = await runBackup(ws);
          backupBackoff.clear(ws.id);
          console.log(`[keel] automatic backup written: ${file}`);
        } catch (err) {
          // A manual run owns this workspace right now. That is neither a
          // failed scheduled backup nor a reason to create retry backoff.
          if (err instanceof BackupInProgressError) continue;
          console.error(`[keel] automatic backup failed for workspace ${ws.id}:`, err);
          // Surface the failure in Settings instead of only in the server log.
          const message = err instanceof Error ? err.message : String(err);
          const wait = backupBackoff.fail(ws.id, CHECK_EVERY_MS, interval);
          await prisma.workspace
            .update({ where: { id: ws.id }, data: { lastBackupError: message } })
            .catch(() => {});
          console.error(
            `[keel] next automatic backup attempt for workspace ${ws.id} in ${Math.round(
              wait / 60000
            )} min`
          );
        }
      }
    } catch (err) {
      console.error("[keel] backup scheduler error", err);
    }
  };
  const tick = () => singleFlightBackupTick(tickWork);

  const maintenance = async () => {
    const result = await runMaintenance();
    const total =
      result.sessions +
      result.notifications +
      result.visits +
      result.loginFailures +
      result.auditEvents +
      result.googleLinkStates +
      result.oauthConnectionStates;
    if (total > 0) {
      console.log(
        `[keel] retention sweep: ${result.sessions} expired sessions, ` +
          `${result.notifications} old notifications, ${result.visits} old visits, ` +
          `${result.loginFailures} stale login-failure records, ` +
          `${result.auditEvents} expired audit events, ` +
          `${result.googleLinkStates} expired Google link states, ` +
          `${result.oauthConnectionStates} expired OAuth connection states`
      );
    }
  };

  setInterval(() => void tick(), CHECK_EVERY_MS);
  setTimeout(() => void tick(), 15 * 1000); // first check shortly after boot

  setInterval(() => void maintenance(), MAINTENANCE_EVERY_MS);
  setTimeout(() => void maintenance(), 60 * 1000);
}
