import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listTags } from "@/lib/links";

export const dynamic = "force-dynamic";

/**
 * Every tag in the workspace, and the pages under the selected one.
 *
 * Server-rendered rather than a client fetch: this is a navigation surface, and
 * the whole point of tags is arriving somewhere quickly.
 */
export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");

  const { tag: rawTag } = await searchParams;
  const selected = rawTag?.trim().toLowerCase().slice(0, 60) || null;

  const tags = await listTags(ctx.workspace.id);
  const pages = selected
    ? await prisma.pageTag.findMany({
        where: { workspaceId: ctx.workspace.id, tag: selected, page: { archivedAt: null } },
        include: {
          page: { select: { id: true, title: true, icon: true, type: true, updatedAt: true } },
        },
        take: 200,
      })
    : [];

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="mb-6 text-2xl font-bold">🏷️ Tags</h1>

      {tags.length === 0 ? (
        <p className="text-sm text-[var(--faint)]">
          No tags yet. Type <code className="rounded bg-[var(--hover)] px-1">#something</code> in
          any page and it will appear here.
        </p>
      ) : (
        <div className="mb-8 flex flex-wrap gap-2">
          {tags.map((t) => (
            <Link
              key={t.tag}
              href={t.tag === selected ? "/tags" : `/tags?tag=${encodeURIComponent(t.tag)}`}
              className={`rounded-full border px-3 py-1 text-sm ${
                t.tag === selected
                  ? "border-[var(--fg)] font-medium"
                  : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)]"
              }`}
            >
              #{t.label}
              <span className="ml-1.5 text-xs text-[var(--faint)]">{t.count}</span>
            </Link>
          ))}
        </div>
      )}

      {selected && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-[var(--muted)]">
            {pages.length} page{pages.length === 1 ? "" : "s"} tagged #{selected}
          </h2>
          <ul className="space-y-1">
            {pages
              .sort((a, b) => b.page.updatedAt.getTime() - a.page.updatedAt.getTime())
              .map((r) => (
                <li key={r.page.id}>
                  <Link
                    href={`/p/${r.page.id}`}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--hover)]"
                  >
                    <span>{r.page.icon ?? (r.page.type === "database" ? "🗂️" : "📄")}</span>
                    <span className="truncate">{r.page.title || "Untitled"}</span>
                    <span className="ml-auto shrink-0 text-xs text-[var(--faint)]">
                      {r.page.updatedAt.toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
