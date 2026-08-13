import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, enforceLimit, handleApiError } from "@/lib/api";

/** Beyond this a force layout is unreadable and the payload gets silly. */
const MAX_NODES = 600;

/**
 * The workspace link graph.
 *
 * Nodes are pages, edges are [[wikilinks]] - read straight from PageLink, which
 * the save path already maintains, so this is two indexed queries rather than
 * anything derived on the fly.
 *
 *   ?tag=work        only pages carrying a tag (and the links between them)
 *   ?orphans=0       hide pages with no links at all
 */
export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await requireContext();
    await enforceLimit("graph", { limit: 30, windowMs: 60_000, userId: user.id });

    const tag = req.nextUrl.searchParams.get("tag")?.trim().toLowerCase().slice(0, 60) || null;
    const includeOrphans = req.nextUrl.searchParams.get("orphans") !== "0";

    const pages = await prisma.page.findMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: null,
        // Records live inside a database and would swamp the graph with rows
        // nobody thinks of as pages.
        type: { in: ["document", "database"] },
        ...(tag ? { tags: { some: { tag } } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_NODES,
      select: { id: true, title: true, type: true, updatedAt: true },
    });

    const ids = new Set(pages.map((p) => p.id));

    const links = await prisma.pageLink.findMany({
      where: { workspaceId: workspace.id, fromPageId: { in: [...ids] } },
      select: { fromPageId: true, toPageId: true, targetTitle: true },
    });

    // Only edges whose endpoints are both on screen. An edge to a page beyond
    // the cap, or filtered out by a tag, would render as a line into nowhere.
    const seen = new Set<string>();
    const edges: { source: string; target: string; resolved: boolean }[] = [];
    for (const link of links) {
      if (!link.toPageId || !ids.has(link.toPageId)) continue;
      if (link.toPageId === link.fromPageId) continue; // self-links are noise
      const key =
        link.fromPageId < link.toPageId
          ? `${link.fromPageId}|${link.toPageId}`
          : `${link.toPageId}|${link.fromPageId}`;
      if (seen.has(key)) continue; // one line per pair, whichever way it points
      seen.add(key);
      edges.push({ source: link.fromPageId, target: link.toPageId, resolved: true });
    }

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const nodes = pages
      .filter((p) => includeOrphans || (degree.get(p.id) ?? 0) > 0)
      .map((p) => ({
        id: p.id,
        title: p.title || "Untitled",
        type: p.type,
        degree: degree.get(p.id) ?? 0,
        updatedAt: p.updatedAt.toISOString(),
      }));

    // Dropping orphans can strand an edge, so filter once more.
    const visible = new Set(nodes.map((n) => n.id));
    return NextResponse.json({
      nodes,
      edges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
      truncated: pages.length === MAX_NODES,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
