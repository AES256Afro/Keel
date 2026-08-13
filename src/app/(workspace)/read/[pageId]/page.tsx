import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import RichDoc from "@/components/RichDoc";

export const dynamic = "force-dynamic";

/** Beyond this a single scroll stops being a reading mode and starts being a
 *  denial of service against your own browser. */
const MAX_SECTIONS = 80;

interface Section {
  id: string;
  title: string;
  icon: string | null;
  content: string | null;
  depth: number;
}

/**
 * Sequence reading - a page and everything under it as one continuous scroll.
 *
 * Lattics frames this as reading a project the way you would read a book:
 * the tree is the outline, so flattening it depth-first IS the reading order.
 * Only documents take part; databases and their records are working surfaces,
 * not prose. Everything renders server-side as static markup - no editor
 * instances, so an 80-section read is one HTML response, not 80 TipTap
 * mounts.
 */
export default async function ReadPage({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const { pageId } = await params;

  const root = await prisma.page.findUnique({ where: { id: pageId } });
  if (!root || root.workspaceId !== ctx.workspace.id || root.type !== "document") notFound();

  // Depth-first flatten in sidebar order, level by level from the database -
  // one query per depth, not per page.
  const sections: Section[] = [
    { id: root.id, title: root.title, icon: root.icon, content: root.content, depth: 0 },
  ];
  let truncated = false;
  const childrenOf = new Map<string, Section[]>();
  let frontier = [root.id];
  // Never pull more page bodies than the view can show. A workspace could have
  // thousands of descendants under one root; without a bound the BFS would load
  // every full `content` into memory and only then discard all but MAX_SECTIONS
  // in walk(). Fetch one extra so the cap can still detect "there was more".
  let fetched = 1; // the root
  for (let depth = 1; frontier.length > 0 && depth <= 6 && fetched <= MAX_SECTIONS; depth++) {
    const rows = await prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        parentPageId: { in: frontier },
        type: "document",
        archivedAt: null,
      },
      orderBy: { sortOrder: "asc" },
      select: { id: true, title: true, icon: true, content: true, parentPageId: true },
      take: MAX_SECTIONS + 1 - fetched,
    });
    for (const row of rows) {
      const list = childrenOf.get(row.parentPageId!) ?? [];
      list.push({ ...row, depth });
      childrenOf.set(row.parentPageId!, list);
    }
    fetched += rows.length;
    frontier = rows.map((r) => r.id);
  }
  // Stitch depth-first so children read directly under their parent.
  const walk = (id: string) => {
    for (const child of childrenOf.get(id) ?? []) {
      if (sections.length >= MAX_SECTIONS) {
        truncated = true;
        return;
      }
      sections.push(child);
      walk(child.id);
    }
  };
  walk(root.id);

  return (
    <div className="mx-auto flex max-w-5xl gap-10 px-8 py-10">
      {/* Outline - the tree, doubling as scroll navigation. */}
      {sections.length > 1 && (
        <nav className="sticky top-10 hidden max-h-[80vh] w-56 shrink-0 self-start overflow-y-auto text-sm lg:block">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">
            Contents
          </p>
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#s-${s.id}`}
              style={{ paddingLeft: s.depth * 12 }}
              className="block truncate rounded px-1 py-0.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            >
              {s.title || "Untitled"}
            </a>
          ))}
        </nav>
      )}

      <article className="min-w-0 flex-1" data-sequence-read>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Reading {sections.length} {sections.length === 1 ? "page" : "pages"} in sequence ·{" "}
          <Link href={`/p/${root.id}`} className="hover:underline">
            back to editing
          </Link>
        </p>
        {sections.map((s, i) => (
          <section key={s.id} id={`s-${s.id}`} data-read-section={s.id} className="mb-10">
            {i > 0 && <hr className="mb-8 border-[var(--border-soft)]" />}
            <div className="mb-3 flex items-baseline gap-2">
              <h1 className={s.depth === 0 ? "text-3xl font-bold" : "text-2xl font-semibold"}>
                {s.icon ? `${s.icon} ` : ""}
                {s.title || "Untitled"}
              </h1>
              <Link
                href={`/p/${s.id}`}
                className="text-xs text-[var(--faint)] hover:underline"
                title="Open for editing"
              >
                edit
              </Link>
            </div>
            <RichDoc content={s.content} />
          </section>
        ))}
        {truncated && (
          <p className="rounded border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
            Stopped at {MAX_SECTIONS} pages - open a deeper page and read from there.
          </p>
        )}
      </article>
    </div>
  );
}
