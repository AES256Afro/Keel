import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { uniqueNewsSlug } from "@/lib/site";

export async function GET() {
  try {
    await requireInstanceOwner();
    const news = await prisma.newsPost.findMany({
      orderBy: [{ createdAt: "desc" }],
    });
    return NextResponse.json({ news });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireInstanceOwner();
    const b = await req.json().catch(() => ({}));
    const title = String(b.title ?? "").trim();
    if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });
    const published = Boolean(b.published);
    const post = await prisma.newsPost.create({
      data: {
        title,
        slug: await uniqueNewsSlug(title),
        excerpt: String(b.excerpt ?? "").trim(),
        body: String(b.body ?? ""),
        published,
        publishedAt: published ? new Date() : null,
      },
    });
    await audit("site.news.create", ctx.user, { target: post.slug, detail: { published } });
    return NextResponse.json({ post }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
