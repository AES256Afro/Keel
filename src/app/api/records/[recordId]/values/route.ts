import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, handleApiError, ApiError } from "@/lib/api";
import { toJson } from "@/lib/json";
import { MAX_VALUE, tooLarge } from "@/lib/limits";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ recordId: string }> }
) {
  try {
    const { user, workspace } = await requireEditor();
    const { recordId } = await params;
    const record = await prisma.databaseRecord.findUnique({
      where: { id: recordId },
      include: { database: true },
    });
    if (!record || record.database.workspaceId !== workspace.id) {
      throw new ApiError(404, "Record not found");
    }
    const body = await req.json().catch(() => ({}));
    const propertyId = String(body.propertyId ?? "");
    const property = await prisma.databaseProperty.findUnique({ where: { id: propertyId } });
    if (!property || property.databaseId !== record.databaseId) {
      throw new ApiError(400, "Property does not belong to this database");
    }
    const encoded = toJson(body.value);
    if (encoded && encoded.length > MAX_VALUE) {
      throw new ApiError(413, tooLarge("This value", MAX_VALUE));
    }
    await prisma.databaseValue.upsert({
      where: { recordId_propertyId: { recordId: record.id, propertyId } },
      create: { recordId: record.id, propertyId, value: encoded },
      update: { value: encoded },
    });
    await prisma.databaseRecord.update({
      where: { id: record.id },
      data: { updatedAt: new Date() },
    });

    // Assigning someone via a Person property notifies them (never yourself).
    if (
      property.type === "person" &&
      typeof body.value === "string" &&
      body.value &&
      body.value !== user.id
    ) {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: body.value } },
      });
      if (member) {
        const page = await prisma.page.findUnique({ where: { id: record.pageId } });
        const authorName = user.username ?? user.email.split("@")[0];
        await prisma.notification.create({
          data: {
            userId: body.value,
            type: "assignment",
            pageId: record.pageId,
            message: `@${authorName} assigned you to “${page?.title || "Untitled"}”`,
          },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
