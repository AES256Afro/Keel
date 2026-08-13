import { NextRequest } from "next/server";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createDocumentPage } from "@/lib/pages";
import { resolveLinksTo } from "@/lib/links";
import { parseDay } from "@/lib/timeline";
import { localDayKey } from "@/lib/writing";
import { relativeRedirect } from "@/lib/request-origin";

/**
 * Today's note: find it or create it, then go there.
 *
 * The note is a perfectly ordinary document titled YYYY-MM-DD, grouped under a
 * "Daily notes" parent - no new tables, no special page type. [[2026-08-03]]
 * links to it like anything else, it shows up in search and on the graph, and
 * deleting it is just deleting a page.
 *
 * ?d=YYYY-MM-DD names the day explicitly. The sidebar link supplies it from
 * the browser because "today" is a client-side fact - the server may sit in a
 * different timezone, and around midnight the two disagree. Anything invalid
 * falls back to the server's day rather than erroring: worst case the note is
 * filed under a neighbouring date, which the user can see and rename.
 */
/**
 * Per-workspace serialization of find-or-create.
 *
 * There is no unique constraint to lean on (duplicate titles are legal for
 * ordinary pages), and optimistic create-then-reconcile alone leaves a window:
 * two racers whose ids land in the same millisecond can each conclude they won.
 * Keel runs as a single Node process - that is the deployment model SQLite
 * imposes - so a process-level queue closes the race outright. The
 * winner-by-oldest reconciliation below stays as the backstop for anyone
 * running several app instances against PostgreSQL.
 */
const laneByWorkspace = new Map<string, Promise<unknown>>();
function serialized<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  const previous = laneByWorkspace.get(workspaceId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => {});
  laneByWorkspace.set(workspaceId, tail);
  // The map only ever holds the newest tail per workspace; drop the lane once
  // it drains so idle workspaces don't accumulate entries.
  void tail.then(() => {
    if (laneByWorkspace.get(workspaceId) === tail) laneByWorkspace.delete(workspaceId);
  });
  return run;
}

export async function GET(req: NextRequest) {
  const ctx = await getCurrentContext();
  if (!ctx) return relativeRedirect("/login");

  const requested = req.nextUrl.searchParams.get("d");
  const title =
    requested && parseDay(requested) !== null ? requested.slice(0, 10) : localDayKey();

  return serialized(ctx.workspace.id, () => resolveToday(req, ctx, title));
}

async function resolveToday(
  req: NextRequest,
  ctx: NonNullable<Awaited<ReturnType<typeof getCurrentContext>>>,
  title: string
) {

  // Find-or-create can race with itself - two tabs, a double-click, and there
  // is no unique constraint to lean on because duplicate titles are legal for
  // ordinary pages. So: create optimistically, then re-query for the winner
  // under a total order (createdAt, then id - ties in the same millisecond are
  // real under concurrency). Every racer computes the same winner; the ones
  // that lost delete the empty page they just made and use the winner. The
  // user was never redirected to a loser, so nothing of theirs is deleted.
  const winnerOf = async (where: {
    title: string;
    parentPageId?: null;
  }): Promise<{ id: string } | null> =>
    prisma.page.findFirst({
      where: {
        workspaceId: ctx.workspace.id,
        type: "document",
        archivedAt: null,
        ...where,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });

  let folder = await winnerOf({ title: "Daily notes", parentPageId: null });
  if (!folder) {
    const mine = await createDocumentPage({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: "Daily notes",
      icon: "📆",
    });
    folder = (await winnerOf({ title: "Daily notes", parentPageId: null })) ?? mine;
    if (folder.id !== mine.id) {
      // Guard on childless: a racer can only have parented its note under the
      // agreed winner, but deleting a folder is the one place worth the belt
      // and braces.
      await prisma.page.deleteMany({
        where: { id: mine.id, children: { none: {} } },
      });
    }
  }

  // Wherever it lives: a note dragged out of the folder is still that day's
  // note, and a second copy inside the folder would split the day.
  let note = await winnerOf({ title });
  if (!note) {
    const mine = await createDocumentPage({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      parentPageId: folder.id,
      title,
      icon: "📅",
    });
    note = (await winnerOf({ title })) ?? mine;
    if (note.id !== mine.id) {
      await prisma.page.delete({ where: { id: mine.id } }).catch(() => {
        // Another racer already cleaned it up.
      });
    } else {
      // Someone may have written [[2026-08-03]] before the note existed.
      await resolveLinksTo({ id: note.id, workspaceId: ctx.workspace.id, title });
    }
  }

  return relativeRedirect(`/p/${note.id}`);
}
