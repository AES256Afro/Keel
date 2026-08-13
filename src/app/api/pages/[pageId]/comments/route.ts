import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireContext, requireEditor, requirePage, handleApiError, ApiError } from "@/lib/api";

function commentDTO(
  c: {
    id: string;
    body: string;
    resolvedAt: Date | null;
    createdAt: Date;
    authorId: string;
    author: { username: string | null; email: string };
  },
  currentUserId: string,
  isWorkspaceOwner: boolean
) {
  return {
    id: c.id,
    body: c.body,
    resolved: c.resolvedAt !== null,
    createdAt: c.createdAt.toISOString(),
    author: c.author.username ?? c.author.email.split("@")[0],
    canManage: c.authorId === currentUserId || isWorkspaceOwner,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace, role } = await requireContext();
    const { pageId } = await params;
    await requirePage(pageId, workspace.id);
    // Bounded, but never at the cost of hiding work. A flat "newest 200" made
    // an older UNRESOLVED comment permanently unreachable: the panel's default
    // view is unresolved comments and it has no pagination, so anything past
    // the cap could not be read, resolved or deleted. Unresolved comments are
    // the actionable ones, so they are fetched first and in full (to their own
    // generous ceiling); resolved ones fill the remaining budget, newest first.
    const MAX_COMMENTS = 400;
    const unresolved = await prisma.comment.findMany({
      where: { pageId, resolvedAt: null },
      include: { author: true },
      orderBy: { createdAt: "asc" },
      take: MAX_COMMENTS,
    });
    const resolved =
      unresolved.length < MAX_COMMENTS
        ? await prisma.comment.findMany({
            where: { pageId, resolvedAt: { not: null } },
            include: { author: true },
            orderBy: { createdAt: "desc" },
            take: MAX_COMMENTS - unresolved.length,
          })
        : [];
    const comments = [...unresolved, ...resolved].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    // Say WHICH class was left behind. A page with more than MAX_COMMENTS
    // unresolved comments hides unresolved ones, and a notice claiming only
    // resolved ones are hidden would assert the opposite of what happened -
    // on exactly the case where the hidden work still needs doing.
    const total = await prisma.comment.count({ where: { pageId } });
    const truncated = total > comments.length;
    const truncatedUnresolved = unresolved.length >= MAX_COMMENTS;
    return NextResponse.json({
      comments: comments.map((c) => commentDTO(c, user.id, role === "owner")),
      truncated,
      truncatedUnresolved,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace, role } = await requireEditor();
    const { pageId } = await params;
    const page = await requirePage(pageId, workspace.id);
    const body = String((await req.json().catch(() => ({}))).body ?? "").trim();
    if (!body) throw new ApiError(400, "Comment cannot be empty");
    if (body.length > 5000) throw new ApiError(400, "Comment is too long");

    const comment = await prisma.comment.create({
      data: { pageId, authorId: user.id, body },
      include: { author: true },
    });

    // @mentions: notify workspace members whose username appears in the body.
    const handles = [...body.matchAll(/@([a-z0-9._-]{3,30})/gi)].map((m) => m[1].toLowerCase());
    if (handles.length > 0) {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: workspace.id },
        include: { user: true },
      });
      const authorName = user.username ?? user.email.split("@")[0];
      const pageTitle = page.title || "Untitled";
      // One insert for every mentioned member, not one round trip each: a
      // comment mentioning a dozen people was a dozen sequential writes while
      // the author waited on the response.
      const rows = members
        .filter((member) => {
          const handle = (member.user.username ?? member.user.email.split("@")[0]).toLowerCase();
          return member.userId !== user.id && handles.includes(handle);
        })
        .map((member) => ({
          userId: member.userId,
          type: "mention",
          pageId,
          message: `@${authorName} mentioned you on “${pageTitle}”`,
        }));
      if (rows.length) await prisma.notification.createMany({ data: rows });
    }

    return NextResponse.json(
      { comment: commentDTO(comment, user.id, role === "owner") },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
