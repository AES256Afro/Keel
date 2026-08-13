import Link from "next/link";
import { listPublicNews } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function NewsIndex() {
  const news = await listPublicNews();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">News</h1>
      {news.length === 0 ? (
        <p className="text-sm text-[var(--faint)]">No posts yet.</p>
      ) : (
        <ul className="space-y-4">
          {news.map((post) => (
            <li key={post.id} className="border-b border-[var(--border-soft)] pb-4">
              <Link href={`/news/${post.slug}`} className="group">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-medium group-hover:text-[var(--link)]">{post.title}</h2>
                  <span className="shrink-0 text-xs text-[var(--faint)]">
                    {(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {post.excerpt && (
                  <p className="mt-1 text-sm text-[var(--muted)]">{post.excerpt}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
