import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { serializeTags } from "@/lib/site";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireInstanceOwner();
    const { id } = await params;
    const b = await req.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    if (typeof b.title === "string" && b.title.trim()) data.title = b.title.trim();
    if (typeof b.description === "string") data.description = b.description.trim();
    if (b.url === null || typeof b.url === "string") data.url = b.url ? String(b.url).trim() : null;
    if (b.repoUrl === null || typeof b.repoUrl === "string")
      data.repoUrl = b.repoUrl ? String(b.repoUrl).trim() : null;
    if (Array.isArray(b.tags)) data.tags = serializeTags(b.tags.map(String));
    if (typeof b.featured === "boolean") data.featured = b.featured;
    if (typeof b.published === "boolean") data.published = b.published;
    if (typeof b.sortOrder === "number") data.sortOrder = b.sortOrder;
    const project = await prisma.project.update({ where: { id }, data });
    await audit("site.project.update", ctx.user, {
      target: project.title,
      detail: { fields: Object.keys(data), published: project.published },
    });
    return NextResponse.json({ project });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireInstanceOwner();
    const { id } = await params;
    await prisma.project.delete({ where: { id } });
    await audit("site.project.delete", ctx.user, { target: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
