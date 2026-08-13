"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Backlink {
  pageId: string;
  title: string;
  icon: string | null;
  type: string;
  excerpt: string | null;
}

/**
 * What links here.
 *
 * Collapsed by default when empty so it costs nothing visually on the many
 * pages nothing points at yet - the value of backlinks is that they appear on
 * their own as a workspace grows, not that they take up room while it doesn't.
 */
export default function BacklinksPanel({ pageId }: { pageId: string }) {
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pages/${pageId}/backlinks`)
      .then((r) => (r.ok ? r.json() : { backlinks: [] }))
      .then((d) => {
        if (!cancelled) setBacklinks(d.backlinks ?? []);
      })
      .catch(() => {
        if (!cancelled) setBacklinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (!backlinks || backlinks.length === 0) return null;

  return (
    <section className="mt-8 border-t border-[var(--border-soft)] pt-4">
      <h2 className="mb-3 text-sm font-medium text-[var(--muted)]">
        🔗 Linked from {backlinks.length} page{backlinks.length === 1 ? "" : "s"}
      </h2>
      <ul className="space-y-2">
        {backlinks.map((b) => (
          <li key={b.pageId}>
            <Link
              href={`/p/${b.pageId}`}
              className="block rounded border border-[var(--border-soft)] px-3 py-2 hover:bg-[var(--hover)]"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <span>{b.icon ?? (b.type === "database" ? "🗂️" : "📄")}</span>
                {b.title}
              </span>
              {b.excerpt && (
                <span className="mt-0.5 block text-xs text-[var(--faint)]">{b.excerpt}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
