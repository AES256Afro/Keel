import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const PAGE_SHARE_TOKEN_PREFIX = "keel_share_";
const PAGE_SHARE_TOKEN_RE = /^keel_share_[A-Za-z0-9_-]{43}$/;
export const PAGE_SHARE_EXPIRY_DAYS = new Set([1, 7, 30, 90]);

export function validPageShareToken(token: string): boolean {
  return PAGE_SHARE_TOKEN_RE.test(token);
}

export function hashPageShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newPageShareToken(): string {
  return PAGE_SHARE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function pageShareExpiry(days: number | null, now = new Date()): Date | null {
  if (days === null) return null;
  if (!PAGE_SHARE_EXPIRY_DAYS.has(days)) throw new Error("Unsupported share expiry");
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function issuePageShare(options: {
  pageId: string;
  createdById: string;
  expiresInDays: number | null;
}) {
  const token = newPageShareToken();
  const expiresAt = pageShareExpiry(options.expiresInDays);
  const share = await prisma.pageShare.upsert({
    where: { pageId: options.pageId },
    create: {
      pageId: options.pageId,
      createdById: options.createdById,
      tokenHash: hashPageShareToken(token),
      expiresAt,
    },
    update: {
      createdById: options.createdById,
      tokenHash: hashPageShareToken(token),
      expiresAt,
      createdAt: new Date(),
    },
  });
  return {
    token,
    path: `/share/${token}`,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt?.toISOString() ?? null,
  };
}

export async function pageShareStatus(pageId: string) {
  const share = await prisma.pageShare.findUnique({ where: { pageId } });
  if (!share) return { active: false as const };
  const active = !share.expiresAt || share.expiresAt.getTime() > Date.now();
  return {
    active,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt?.toISOString() ?? null,
  };
}

export async function revokePageShare(pageId: string): Promise<boolean> {
  const result = await prisma.pageShare.deleteMany({ where: { pageId } });
  return result.count > 0;
}

export async function resolvePageShare(token: string, now = new Date()) {
  if (!validPageShareToken(token)) return null;
  const share = await prisma.pageShare.findUnique({
    where: { tokenHash: hashPageShareToken(token) },
    include: {
      page: {
        select: {
          id: true,
          workspaceId: true,
          title: true,
          icon: true,
          content: true,
          type: true,
          archivedAt: true,
          externalSource: true,
          updatedAt: true,
        },
      },
    },
  });
  if (
    !share ||
    share.page.type !== "document" ||
    share.page.archivedAt ||
    share.page.externalSource ||
    (share.expiresAt && share.expiresAt.getTime() <= now.getTime())
  ) {
    return null;
  }
  return share;
}
