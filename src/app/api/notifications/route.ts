import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, handleApiError } from "@/lib/api";

export async function GET() {
  try {
    const { user } = await requireContext();
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return NextResponse.json({
      unreadCount,
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        pageId: n.pageId,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** Mark all notifications read. */
export async function POST(_req: NextRequest) {
  try {
    const { user } = await requireContext();
    await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
