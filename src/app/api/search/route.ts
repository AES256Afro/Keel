import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, enforceLimit, handleApiError } from "@/lib/api";
import { snippet } from "@/lib/plaintext";
import {
  containsInsensitive,
  forDatabaseFilter,
  matchesLiterally,
  parseQuery,
  rankResults,
} from "@/lib/search";

/**
 * Workspace search.
 *
 * Reads Page.plainText - the flattened document - rather than Page.content,
 * which is the serialized editor JSON. Searching the JSON meant every page
 * matched "paragraph", "doc" and "type", while a word split across two marks
 * matched nothing at all.
 *
 * Supports a few operators, because "find the thing I half-remember" is the
 * actual job:
 *   in:title      match titles only
 *   type:database restrict to documents, databases or records
 *   updated:7d    changed within a period
 *   "exact words" phrase match
 */
export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await requireContext();
    await enforceLimit("search", { limit: 60, windowMs: 60_000, userId: user.id });

    const raw = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
    const query = parseQuery(raw);
    if (query.terms.length === 0 && query.phrases.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Every term must appear somewhere (AND), in the title or the body unless
    // in:title narrowed it. Phrases are matched as written.
    const needles = [...query.phrases, ...query.terms];
    const AND = needles.map((needle) => {
      // Wildcard-free for the SQL pre-filter; the literal check below is
      // authoritative. A needle that is nothing but wildcards filters nothing,
      // which is correct - it cannot match anything literally either.
      const filter = forDatabaseFilter(needle);
      if (!filter) return {};
      // Case-insensitive on SQLite *and* PostgreSQL: a plain `contains` is a
      // LIKE, which only folds case on SQLite, so "roadmap" missed "Roadmap"
      // on a PostgreSQL deployment. See containsInsensitive.
      const like = containsInsensitive(filter);
      return {
        OR: query.titleOnly
          ? [{ title: like }]
          : [{ title: like }, { plainText: like }],
      };
    });

    const pages = await prisma.page.findMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: null,
        ...(query.types.length > 0 ? { type: { in: query.types } } : {}),
        ...(query.updatedAfter ? { updatedAt: { gte: query.updatedAfter } } : {}),
        AND,
      },
      orderBy: { updatedAt: "desc" },
      // Over-fetch so ranking has something to sort, then trim.
      take: 60,
      select: {
        id: true,
        title: true,
        icon: true,
        type: true,
        updatedAt: true,
        plainText: true,
      },
    });

    // Drop rows the pre-filter let through because a wildcard was stripped.
    const literal = pages.filter((p) =>
      needles.every((needle) => matchesLiterally(p, needle, query.titleOnly))
    );
    const ranked = rankResults(literal, needles).slice(0, 20);

    return NextResponse.json({
      results: ranked.map((p) => ({
        id: p.id,
        title: p.title || "Untitled",
        icon: p.icon,
        type: p.type,
        updatedAt: p.updatedAt.toISOString(),
        snippet: snippet(p.plainText ?? "", needles[0] ?? raw),
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
