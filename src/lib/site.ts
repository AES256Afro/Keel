// Optional built-in public-site content: projects and news posts, managed from
// the owner-only /admin portal. Single owner, so no per-user scoping.
import { prisma } from "@/lib/prisma";
import { parseJson, toJson } from "@/lib/json";

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "post"
  );
}

/**
 * A slug unique among news posts.
 *
 * One query instead of a query per collision: fetch everything already using
 * this stem and pick the first free suffix. The database enforces uniqueness,
 * so a concurrent insert still loses cleanly rather than creating a duplicate.
 */
export async function uniqueNewsSlug(title: string, excludeId?: string): Promise<string> {
  const base = slugify(title);
  const existing = await prisma.newsPost.findMany({
    where: { slug: { startsWith: base }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { slug: true },
  });
  const taken = new Set(existing.map((p) => p.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function projectTags(project: { tags: string | null }): string[] {
  const parsed = parseJson<string[]>(project.tags, []);
  return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
}

export function serializeTags(tags: string[]): string {
  return toJson(tags.map((t) => t.trim()).filter(Boolean));
}

export async function listPublicProjects() {
  return prisma.project.findMany({
    where: { published: true },
    orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
  });
}

export async function listPublicNews() {
  return prisma.newsPost.findMany({
    where: { published: true },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function getPublishedNews(slug: string) {
  return prisma.newsPost.findFirst({ where: { slug, published: true } });
}
