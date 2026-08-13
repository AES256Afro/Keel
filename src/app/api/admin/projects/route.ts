import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { serializeTags } from "@/lib/site";

export async function GET() {
  try {
    await requireInstanceOwner();
    const projects = await prisma.project.findMany({
      orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    });
    return NextResponse.json({ projects });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change public projects from Keel Admin");
    requireJsonRequest(req, "Public-project requests must use application/json");
    const b = await req.json().catch(() => ({}));
    const title = String(b.title ?? "").trim();
    if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });
    const project = await prisma.project.create({
      data: {
        title,
        description: String(b.description ?? "").trim(),
        url: b.url ? String(b.url).trim() : null,
        repoUrl: b.repoUrl ? String(b.repoUrl).trim() : null,
        tags: serializeTags(Array.isArray(b.tags) ? b.tags.map(String) : []),
        featured: Boolean(b.featured),
        published: b.published === undefined ? true : Boolean(b.published),
      },
    });
    await audit("site.project.create", ctx.user, { target: project.title });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
