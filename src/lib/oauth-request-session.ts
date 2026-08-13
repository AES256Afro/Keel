import type { NextRequest } from "next/server";
import { readSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type ActiveRequestSession = {
  id: string;
  userId: string;
};

/** Resolve the exact database session represented by this request cookie.
 * OAuth connection state binds to this stable id rather than merely to an
 * account, so switching or replacing a session cannot redirect a callback. */
export async function activeRequestSession(
  req: NextRequest,
  userId: string
): Promise<ActiveRequestSession | null> {
  const token = readSessionToken(req.cookies);
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!session || session.userId !== userId || session.expiresAt <= new Date()) {
    return null;
  }
  return { id: session.id, userId: session.userId };
}
