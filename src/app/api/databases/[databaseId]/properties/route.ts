import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, requireDatabase, handleApiError, ApiError } from "@/lib/api";
import { parseJson, toJson } from "@/lib/json";
import { OPTION_COLORS, PROPERTY_TYPES, type PropertySettings } from "@/lib/types";
import { MAX_NAME } from "@/lib/limits";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ databaseId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { databaseId } = await params;
    const db = await requireDatabase(databaseId, workspace.id);
    const body = await req.json().catch(() => ({}));
    const type = String(body.type ?? "text");
    if (!PROPERTY_TYPES.some((t) => t.type === type)) {
      throw new ApiError(400, "Unknown property type");
    }
    const last = await prisma.databaseProperty.findFirst({
      where: { databaseId: db.id },
      orderBy: { sortOrder: "desc" },
    });
    const property = await prisma.databaseProperty.create({
      data: {
        databaseId: db.id,
        // Capped like every other name (views, workspace): properties are
        // re-read and parsed on every database open and serialized into every
        // backup, so an unbounded one is a cost everyone pays forever.
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, MAX_NAME)
            : "New property",
        type,
        settings:
          type === "select" || type === "multiSelect" ? toJson({ options: [] }) : null,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });

    // Person options are the workspace members, resolved server-side so the
    // client can render the picker immediately.
    let settings: PropertySettings = parseJson(property.settings, { options: [] });
    if (type === "person") {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: workspace.id },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      });
      settings = {
        options: members.map((m, i) => ({
          id: m.userId,
          name: m.user.username ?? m.user.email.split("@")[0],
          color: OPTION_COLORS[i % OPTION_COLORS.length],
        })),
      };
    }
    return NextResponse.json({ property: { id: property.id, settings } }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
