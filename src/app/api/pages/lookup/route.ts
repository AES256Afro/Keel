import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, enforceLimit, handleApiError } from "@/lib/api";
import { forDatabaseFilter } from "@/lib/search";

/**
 * Title autocomplete for the `[[` picker.
 *
 * Deliberately separate from /api/search: this matches titles only, needs to
 * answer on every keystroke, and returns whether an exact title already exists
 * so the editor can offer "create this page" without a second round trip.
 */
export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await requireContext();
    await enforceLimit("page-lookup", { limit: 120, windowMs: 60_000, userId: user.id });

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);

    const normalized = q.toLowerCase();
    const pages = await prisma.page.findMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: null,
        // Records live inside their database and are linkable, but the picker
        // leads with documents and databases - those are what people name.
        // See forDatabaseFilter: Prisma leaves LIKE wildcards unescaped.
        ...(forDatabaseFilter(q) ? { title: { contains: forDatabaseFilter(q) } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, icon: true, type: true },
    });

    // `exactMatch` decides whether the picker offers "create this page", so it
    // must be authoritative - deriving it from the 20-row window above offered
    // creation (and minted a duplicate) whenever the exact title sorted past
    // row 20. Ask separately: the indexed equality on (workspaceId, title)
    // answers the common case - the picker inserts titles verbatim - and the
    // `contains` fallback covers case/whitespace differences, because SQLite's
    // `=` is case-sensitive and Prisma's insensitive mode is PostgreSQL-only.
    let exactMatch = false;
    if (normalized) {
      exactMatch = Boolean(
        await prisma.page.findFirst({
          where: { workspaceId: workspace.id, archivedAt: null, title: q },
          select: { id: true },
        })
      );
      if (!exactMatch && forDatabaseFilter(q)) {
        const candidates = await prisma.page.findMany({
          where: {
            workspaceId: workspace.id,
            archivedAt: null,
            title: { contains: forDatabaseFilter(q) },
          },
          select: { title: true },
          take: 500, // same bound resolveTargets uses for the identical trick
        });
        exactMatch = candidates.some((p) => p.title.trim().toLowerCase() === normalized);
      }
    }

    return NextResponse.json({
      pages: pages
        .filter((p) => p.title && (!q || p.title.toLowerCase().includes(normalized)))
        .map((p) => ({ id: p.id, title: p.title, icon: p.icon, type: p.type })),
      // Lets the editor decide whether to offer creation without asking again.
      exactMatch,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
