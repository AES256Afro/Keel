import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireEditor,
  requirePage,
  handleApiError,
  collectSubtreeIds,
  ApiError,
} from "@/lib/api";
import { MAX_CONTENT, MAX_TITLE, tooLarge } from "@/lib/limits";
import { documentToPlainText } from "@/lib/plaintext";
import { resolveLinksTo, syncPageLinks, unresolveStaleLinks } from "@/lib/links";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { user, workspace } = await requireEditor();
    const { pageId } = await params;
    const page = await requirePage(pageId, workspace.id);
    const body = await req.json().catch(() => ({}));

    // Trash / restore act on the whole subtree.
    if (typeof body.archived === "boolean") {
      const ids = await collectSubtreeIds(page.id, workspace.id);
      await prisma.page.updateMany({
        where: { id: { in: ids } },
        data: { archivedAt: body.archived ? new Date() : null },
      });
      if (!body.archived && page.parentPageId) {
        // If the restored page's parent is still in the trash, surface it at the root.
        const parent = await prisma.page.findUnique({ where: { id: page.parentPageId } });
        if (parent?.archivedAt) {
          await prisma.page.update({ where: { id: page.id }, data: { parentPageId: null } });
        }
      }
      return NextResponse.json({ ok: true });
    }

    const data: Record<string, unknown> = { editedById: user.id };
    if (typeof body.title === "string") data.title = body.title.slice(0, MAX_TITLE);
    if (typeof body.icon === "string" || body.icon === null) {
      data.icon = typeof body.icon === "string" ? body.icon.slice(0, 32) : null;
    }
    if (typeof body.content === "string") {
      if (body.content.length > MAX_CONTENT) {
        throw new ApiError(413, tooLarge("This page", MAX_CONTENT));
      }
      data.content = body.content;
      // Derived on write so search never has to parse the editor document.
      data.plainText = documentToPlainText(body.content);
    }
    if (body.parentPageId !== undefined) {
      const newParentId = body.parentPageId as string | null;
      if (newParentId !== null) await requirePage(newParentId, workspace.id);
      data.parentPageId = newParentId;
      const last = await prisma.page.findFirst({
        where: { workspaceId: workspace.id, parentPageId: newParentId, archivedAt: null },
        orderBy: { sortOrder: "desc" },
      });
      data.sortOrder = (last?.sortOrder ?? 0) + 1;
    }
    // A move's inside-itself check must commit with the write it gates: two
    // concurrent moves (A under B, B under A) each pass a pre-write check and
    // jointly commit a cycle - which getPageTree can reach from no root, so the
    // whole subtree vanishes from the sidebar. SQLite serializes writers, so
    // one transaction closes the window. Non-move updates skip the ceremony.
    const updated =
      typeof data.parentPageId === "string"
        ? await prisma.$transaction(async (tx) => {
            const subtree = await collectSubtreeIds(page.id, workspace.id, tx);
            if (subtree.includes(data.parentPageId as string)) {
              throw new ApiError(400, "Cannot move a page inside itself");
            }
            return tx.page.update({ where: { id: page.id }, data });
          })
        : await prisma.page.update({ where: { id: page.id }, data });

    // The link graph is derived from the document, so it is rebuilt whenever
    // the document changes. A rename additionally re-points inbound links:
    // [[Old name]] should stop resolving here, and [[New name]] written
    // elsewhere earlier should start.
    if (data.content !== undefined) {
      await syncPageLinks({
        id: updated.id,
        workspaceId: updated.workspaceId,
        plainText: updated.plainText,
        title: updated.title,
      });
    }
    if (data.title !== undefined && data.title !== page.title) {
      await unresolveStaleLinks({ id: updated.id, title: updated.title });
      await resolveLinksTo({
        id: updated.id,
        workspaceId: updated.workspaceId,
        title: updated.title,
      });
    }

    return NextResponse.json({ page: { id: updated.id, title: updated.title } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { pageId } = await params;
    const page = await requirePage(pageId, workspace.id);
    const ids = await collectSubtreeIds(page.id, workspace.id);
    // Delete leaves-first so child rows never dangle.
    await prisma.page.deleteMany({ where: { id: { in: ids.reverse() } } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
