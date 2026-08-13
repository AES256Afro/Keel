import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { projectTags } from "@/lib/site";
import { isInstanceOwner } from "@/lib/instance";
import { resolveSiteSetting } from "@/lib/instance-settings";
import AdminClient from "@/components/AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  // The public-site CMS belongs to whoever runs the server - not to every
  // account that happens to own its own workspace (which is all of them).
  if (!(await isInstanceOwner(ctx.user))) {
    return (
      <div className="max-w-lg mx-auto px-6 py-20 text-center">
        <h1 className="text-xl font-semibold">Not authorized</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          The admin portal is restricted to the instance owner.
        </p>
      </div>
    );
  }

  const [projects, news, notesUrl] = await Promise.all([
    prisma.project.findMany({
      orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    }),
    prisma.newsPost.findMany({ orderBy: [{ createdAt: "desc" }] }),
    resolveSiteSetting("notesUrl"),
  ]);

  return (
    <AdminClient
      notesUrl={notesUrl}
      projects={projects.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        url: p.url,
        repoUrl: p.repoUrl,
        tags: projectTags(p),
        featured: p.featured,
        published: p.published,
      }))}
      news={news.map((n) => ({
        id: n.id,
        title: n.title,
        slug: n.slug,
        excerpt: n.excerpt,
        body: n.body,
        published: n.published,
      }))}
    />
  );
}
