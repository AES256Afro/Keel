import Link from "next/link";
import { keelEnv } from "@/lib/env";
import { listPublicProjects, listPublicNews, projectTags } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function SiteHome() {
  const [projects, news] = await Promise.all([listPublicProjects(), listPublicNews()]);
  const siteName = keelEnv("SITE_NAME") ?? "My projects";
  const siteTagline = keelEnv("SITE_TAGLINE") ?? "Projects, notes, and experiments.";

  return (
    <div className="space-y-14">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">{siteName}</h1>
        <p className="mt-2 text-[var(--muted)] max-w-2xl">
          {siteTagline}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--faint)] mb-4">
          Projects
        </h2>
        {projects.length === 0 ? (
          <p className="text-sm text-[var(--faint)]">Nothing published yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {projects.map((p) => (
              <article
                key={p.id}
                className="rounded-lg border border-[var(--border)] p-4 hover:bg-[var(--hover)] transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium">{p.title}</h3>
                  {p.featured && (
                    <span className="text-[10px] uppercase tracking-wide text-[var(--link)]">
                      Featured
                    </span>
                  )}
                </div>
                {p.description && (
                  <p className="mt-1 text-sm text-[var(--muted)]">{p.description}</p>
                )}
                {projectTags(p).length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {projectTags(p).map((t) => (
                      <li
                        key={t}
                        className="rounded-full border border-[var(--border-soft)] px-2 py-0.5 text-[11px] text-[var(--faint)]"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex gap-3 text-sm">
                  {p.url && (
                    <a href={p.url} className="text-[var(--link)] hover:underline">
                      Visit ↗
                    </a>
                  )}
                  {p.repoUrl && (
                    <a href={p.repoUrl} className="text-[var(--link)] hover:underline">
                      Source ↗
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {news.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--faint)] mb-4">
            News
          </h2>
          <ul className="divide-y divide-[var(--border-soft)] rounded-lg border border-[var(--border)]">
            {news.slice(0, 5).map((post) => (
              <li key={post.id}>
                <Link
                  href={`/news/${post.slug}`}
                  className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-[var(--hover)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{post.title}</span>
                    {post.excerpt && (
                      <span className="block truncate text-sm text-[var(--muted)]">
                        {post.excerpt}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--faint)]">
                    {(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/news" className="mt-3 inline-block text-sm text-[var(--link)] hover:underline">
            All news →
          </Link>
        </section>
      )}
    </div>
  );
}
