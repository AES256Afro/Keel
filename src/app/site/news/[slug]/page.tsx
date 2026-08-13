import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedNews } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const post = await getPublishedNews((await params).slug);
  return post
    ? { title: post.title, description: post.excerpt ?? undefined }
    : { title: "News" };
}

// Render owner-authored text safely: paragraphs on blank lines, line breaks
// preserved, bare URLs turned into links (built as React nodes, never HTML).
function renderBody(body: string) {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  const isUrl = (s: string) => /^https?:\/\//.test(s);
  return body
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((para, i) => (
      <p key={i} className="mb-4 whitespace-pre-wrap leading-relaxed">
        {para.split(urlRe).map((part, j) =>
          isUrl(part) ? (
            <a key={j} href={part} className="text-[var(--link)] hover:underline">
              {part}
            </a>
          ) : (
            part
          )
        )}
      </p>
    ));
}

export default async function NewsPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPublishedNews(slug);
  if (!post) notFound();

  return (
    <article className="max-w-2xl">
      <Link href="/news" className="text-sm text-[var(--muted)] hover:text-[var(--fg)]">
        ← News
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">{post.title}</h1>
      <p className="mt-1 text-sm text-[var(--faint)]">
        {(post.publishedAt ?? post.createdAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })}
      </p>
      <div className="mt-6 text-[var(--fg)]">{renderBody(post.body)}</div>
    </article>
  );
}
