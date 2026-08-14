import { prisma } from "@/lib/prisma";

/**
 * Permanently remove pages after each workspace's chosen grace period.
 *
 * Archive/restore writes one timestamp across the whole subtree, so one
 * workspace-scoped delete removes an expired tree together. A zero retention
 * value is an explicit "keep forever" setting and is never selected here.
 */
export async function pruneExpiredTrash(now = new Date()): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { trashRetentionDays: { gt: 0 } },
    select: { id: true, trashRetentionDays: true },
  });
  let deleted = 0;
  for (const workspace of workspaces) {
    const cutoff = new Date(
      now.getTime() - workspace.trashRetentionDays * 24 * 60 * 60 * 1000
    );
    const result = await prisma.page.deleteMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: { not: null, lt: cutoff },
      },
    });
    deleted += result.count;
  }
  return deleted;
}
