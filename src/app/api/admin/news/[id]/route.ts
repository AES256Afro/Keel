import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { uniqueNewsSlug } from "@/lib/site";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change public news from Keel Admin");
    requireJsonRequest(req, "Public-news requests must use application/json");
    const { id } = await params;
    const b = await req.json().catch(() => ({}));
    const existing = await prisma.newsPost.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (typeof b.title === "string" && b.title.trim()) {
      data.title = b.title.trim();
      data.slug = await uniqueNewsSlug(b.title.trim(), id);
    }
    if (typeof b.excerpt === "string") data.excerpt = b.excerpt.trim();
    if (typeof b.body === "string") data.body = b.body;
    if (typeof b.published === "boolean") {
      data.published = b.published;
      // Stamp publishedAt the first time it goes live; keep it thereafter.
      if (b.published && !existing.publishedAt) data.publishedAt = new Date();
    }
    const post = await prisma.newsPost.update({ where: { id }, data });
    await audit("site.news.update", ctx.user, {
      target: post.slug,
      detail: { fields: Object.keys(data), published: post.published },
    });
    return NextResponse.json({ post });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Delete public news from Keel Admin");
    const { id } = await params;
    await prisma.newsPost.delete({ where: { id } });
    await audit("site.news.delete", ctx.user, { target: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
