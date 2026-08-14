import { notFound, redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/json";
import { getDatabaseDTO, getDatabaseSchemaDTO } from "@/lib/pages";
import DocumentPage from "@/components/DocumentPage";
import DatabasePage from "@/components/DatabasePage";
import RecordPage from "@/components/RecordPage";
import CommentsPanel from "@/components/CommentsPanel";
import BacklinksPanel from "@/components/BacklinksPanel";
import TrackVisit from "@/components/TrackVisit";
import SplitView from "@/components/SplitView";

export default async function PageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ pageId: string }>;
  searchParams: Promise<{ with?: string }>;
}) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const [{ pageId }, { with: withId }] = await Promise.all([params, searchParams]);
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    include: { database: true, record: true },
  });
  if (!page || page.workspaceId !== ctx.workspace.id) notFound();

  // Mirrored pages are read-only in Keel - OneNote owns them; edits would be
  // overwritten on the next sync. This is a property of the page, not of the
  // route, so it is computed PER page: the split view renders a second one,
  // and giving it the primary page's flag made a mirror editable whenever it
  // was opened beside an ordinary document.
  const isReadOnly = (p: { externalSource: string | null }) =>
    ctx.role === "viewer" || p.externalSource === "onenote";
  const readOnly = isReadOnly(page);

  // ?with=<id> - a second document beside this one. Validated server-side and
  // silently ignored when invalid: the URL is user input, and a stale or
  // hostile id should degrade to the ordinary single-page view, not error.
  // The workspace check is the security boundary - without it, any signed-in
  // user could read another workspace's document by pasting its id.
  if (withId && withId !== page.id && page.type === "document") {
    const other = await prisma.page.findUnique({ where: { id: withId } });
    if (other && other.workspaceId === ctx.workspace.id && other.type === "document") {
      return (
        <div className="h-full min-h-0">
          <TrackVisit pageId={page.id} />
          <SplitView
            left={{
              id: page.id,
              title: page.title,
              icon: page.icon,
              content: page.content,
              archived: page.archivedAt !== null,
              readOnly,
            }}
            right={{
              id: other.id,
              title: other.title,
              icon: other.icon,
              content: other.content,
              archived: other.archivedAt !== null,
              readOnly: isReadOnly(other),
            }}
          />
        </div>
      );
    }
  }

  const favorite = Boolean(
    await prisma.favorite.findUnique({
      where: { userId_pageId: { userId: ctx.user.id, pageId: page.id } },
    })
  );
  const base = {
    id: page.id,
    title: page.title,
    icon: page.icon,
    archived: page.archivedAt !== null,
    updatedAt: page.updatedAt.toISOString(),
  };

  const extras = (width: string) => (
    <>
      <TrackVisit pageId={page.id} />
      <div className={`${width} mx-auto px-8 pb-16`}>
        <BacklinksPanel pageId={page.id} />
        <CommentsPanel pageId={page.id} readOnly={readOnly} />
      </div>
    </>
  );

  if (page.type === "database" && page.database) {
    const dto = await getDatabaseDTO(page.database.id);
    if (!dto) notFound();
    return (
      <>
        <DatabasePage
          key={page.id}
          page={base}
          database={dto}
          readOnly={readOnly}
          favorite={favorite}
        />
        {extras("max-w-5xl")}
      </>
    );
  }

  if (page.type === "record" && page.record) {
    // Schema plus this record's own values - not every sibling row.
    const [dto, values, databasePage] = await Promise.all([
      getDatabaseSchemaDTO(page.record.databaseId),
      prisma.databaseValue.findMany({
        where: { recordId: page.record.id },
        select: { propertyId: true, value: true },
      }),
      prisma.page.findUnique({
        where: { id: page.parentPageId ?? "" },
        select: { id: true, title: true, icon: true },
      }),
    ]);
    if (!dto) notFound();
    const recordValues: Record<string, unknown> = {};
    for (const v of values) recordValues[v.propertyId] = parseJson<unknown>(v.value, null);
    return (
      <>
        <RecordPage
          key={page.id}
          page={{ ...base, content: page.content }}
          readOnly={readOnly}
          favorite={favorite}
          recordId={page.record.id}
          database={dto}
          recordValues={recordValues}
          databasePage={{
            id: databasePage?.id ?? dto.pageId,
            title: databasePage?.title || "Untitled",
            icon: databasePage?.icon ?? null,
          }}
        />
        {extras("max-w-3xl")}
      </>
    );
  }

  return (
    <>
      <DocumentPage
        key={page.id}
        page={{ ...base, content: page.content }}
        readOnly={readOnly}
        favorite={favorite}
        canShare={ctx.role === "owner" && !page.archivedAt && page.externalSource === null}
      />
      {extras("max-w-3xl")}
    </>
  );
}
