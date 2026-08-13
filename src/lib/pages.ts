import { prisma } from "@/lib/prisma";
import { parseJson, toJson } from "@/lib/json";
import { documentToPlainText } from "@/lib/plaintext";
import {
  OPTION_COLORS,
  type DatabaseDTO,
  type PageTreeNode,
  type PropertyDTO,
  type PropertySettings,
  type PropertyType,
  type RecordDTO,
  type SelectOption,
} from "@/lib/types";
import {
  defaultViews,
  fallbackViews,
  isViewType,
  parseViewConfig,
  serializeViewConfig,
  type ViewDTO,
} from "@/lib/views";

export const EMPTY_DOC = toJson({ type: "doc", content: [{ type: "paragraph" }] });

async function nextSortOrder(workspaceId: string, parentPageId: string | null) {
  const last = await prisma.page.findFirst({
    where: { workspaceId, parentPageId, archivedAt: null },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? 0) + 1;
}

export async function createDocumentPage(opts: {
  workspaceId: string;
  userId: string;
  parentPageId?: string | null;
  title?: string;
  icon?: string | null;
  content?: string;
}) {
  const parentPageId = opts.parentPageId ?? null;
  return prisma.page.create({
    data: {
      workspaceId: opts.workspaceId,
      parentPageId,
      type: "document",
      title: opts.title ?? "",
      icon: opts.icon ?? null,
      content: opts.content ?? EMPTY_DOC,
      plainText: documentToPlainText(opts.content ?? EMPTY_DOC),
      sortOrder: await nextSortOrder(opts.workspaceId, parentPageId),
      createdById: opts.userId,
      editedById: opts.userId,
    },
  });
}

const DEFAULT_STATUS_OPTIONS: SelectOption[] = [
  { id: "todo", name: "To do", color: "gray" },
  { id: "in-progress", name: "In progress", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

export async function createDatabasePage(opts: {
  workspaceId: string;
  userId: string;
  parentPageId?: string | null;
  title?: string;
}) {
  const parentPageId = opts.parentPageId ?? null;
  const page = await prisma.page.create({
    data: {
      workspaceId: opts.workspaceId,
      parentPageId,
      type: "database",
      title: opts.title ?? "",
      sortOrder: await nextSortOrder(opts.workspaceId, parentPageId),
      createdById: opts.userId,
      editedById: opts.userId,
      database: {
        create: {
          workspaceId: opts.workspaceId,
          properties: {
            create: [
              {
                name: "Status",
                type: "select",
                settings: toJson({ options: DEFAULT_STATUS_OPTIONS }),
                sortOrder: 1,
              },
              { name: "Date", type: "date", sortOrder: 2 },
            ],
          },
          views: {
            create: defaultViews().map((v) => ({
              name: v.name,
              type: v.type,
              sortOrder: v.sortOrder,
              config: serializeViewConfig(v.config),
            })),
          },
        },
      },
    },
    include: { database: true },
  });
  return page;
}

export async function createRecord(opts: {
  databaseId: string;
  workspaceId: string;
  userId: string;
  databasePageId: string;
  title?: string;
  /** Attach to a parent record - how the mind map adds a child node. */
  parentRecordId?: string | null;
  /** Place the node on the mind-map canvas straight away. */
  mapX?: number | null;
  mapY?: number | null;
}) {
  const last = await prisma.databaseRecord.findFirst({
    where: { databaseId: opts.databaseId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return prisma.databaseRecord.create({
    data: {
      database: { connect: { id: opts.databaseId } },
      sortOrder: (last?.sortOrder ?? 0) + 1,
      // Relation form, not a raw parentRecordId: Prisma won't mix connect-style
      // and scalar-style inputs in one create.
      ...(opts.parentRecordId ? { parent: { connect: { id: opts.parentRecordId } } } : {}),
      mapX: opts.mapX ?? null,
      mapY: opts.mapY ?? null,
      page: {
        create: {
          workspaceId: opts.workspaceId,
          parentPageId: opts.databasePageId,
          type: "record",
          title: opts.title ?? "",
          content: EMPTY_DOC,
          plainText: "",
          createdById: opts.userId,
          editedById: opts.userId,
        },
      },
    },
    include: { page: true },
  });
}

/** Sidebar tree: documents and databases only (records stay inside their database). */
export async function getPageTree(workspaceId: string): Promise<PageTreeNode[]> {
  const pages = await prisma.page.findMany({
    where: { workspaceId, archivedAt: null, type: { in: ["document", "database"] } },
    orderBy: { sortOrder: "asc" },
    select: { id: true, title: true, icon: true, type: true, parentPageId: true },
  });
  // Membership set first: pages.some() inside this loop made the sidebar O(n²),
  // and it rebuilds on every navigation.
  const ids = new Set(pages.map((p) => p.id));
  const byParent = new Map<string | null, typeof pages>();
  for (const p of pages) {
    const key = p.parentPageId;
    // A page whose parent is archived (or is a record page) surfaces at the root.
    const bucket = key !== null && ids.has(key) ? key : null;
    const existing = byParent.get(bucket);
    if (existing) existing.push(p);
    else byParent.set(bucket, [p]);
  }
  const build = (parentId: string | null): PageTreeNode[] =>
    (byParent.get(parentId) ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      type: p.type,
      children: build(p.id),
    }));
  return build(null);
}

/** The entry shape consumers index into: `.find(o => o.id …)`, chip text from `o.name`. */
function isOptionEntry(entry: unknown): entry is SelectOption {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as { id?: unknown }).id === "string" &&
    typeof (entry as { name?: unknown }).name === "string"
  );
}

function propertyToDTO(
  p: {
    id: string;
    name: string;
    type: string;
    settings: string | null;
    sortOrder: number;
  },
  personOptions: SelectOption[]
): PropertyDTO {
  // parseJson's fallback only covers text that fails to parse - "null" and
  // "[]" parse fine, and every settings.options consumer dereferences the
  // result. Anything that isn't a plain object degrades to {} here so one bad
  // row can't take the whole database page down.
  const parsed = parseJson<PropertySettings>(p.settings, {});
  const settings = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  // One level deeper, same reasoning: the write path now validates options,
  // but a row poisoned before that gate (or edited by hand) must still
  // render. `{"options": 42}` degrades to no options - a losable chip list,
  // not a database page that throws for every member - and a real array
  // keeps whatever entries are actually option-shaped.
  const rawOptions: unknown = (settings as { options?: unknown }).options;
  if (rawOptions !== undefined) {
    settings.options = Array.isArray(rawOptions) ? rawOptions.filter(isOptionEntry) : [];
  }
  return {
    id: p.id,
    name: p.name,
    type: p.type as PropertyType,
    // Person properties reuse the select machinery (chips, board grouping,
    // filtering, CSV) with options generated from the workspace members.
    settings: p.type === "person" ? { options: personOptions } : settings,
    sortOrder: p.sortOrder,
  };
}

/**
 * A database's shape without its rows.
 *
 * Opening one record used to call getDatabaseDTO(), which loads every record,
 * every page row and every value in the database - then serialises the lot into
 * the RSC payload to render one row's property editors. On a few thousand tasks
 * that is megabytes per click.
 */
export async function getDatabaseSchemaDTO(
  databaseId: string
): Promise<Omit<DatabaseDTO, "records"> | null> {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: {
      page: { select: { id: true, title: true } },
      properties: { orderBy: { sortOrder: "asc" } },
      views: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!db) return null;
  const personOptions = await personOptionsFor(db.workspaceId);
  return {
    id: db.id,
    pageId: db.pageId,
    title: db.page.title,
    properties: db.properties.map((p) => propertyToDTO(p, personOptions)),
    views: viewsToDTO(db.views),
  };
}

/** Person properties render as chips of the workspace's members. */
async function personOptionsFor(workspaceId: string): Promise<SelectOption[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { username: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m, i) => ({
    id: m.userId,
    name: m.user.username ?? m.user.email.split("@")[0],
    color: OPTION_COLORS[i % OPTION_COLORS.length],
  }));
}

function viewsToDTO(
  views: { id: string; name: string; type: string; sortOrder: number; config: string | null }[]
): ViewDTO[] {
  // Databases created before saved views existed have none; give them the
  // standard set to render rather than writing rows from a read path.
  if (views.length === 0) return fallbackViews();
  return views.map((v) => ({
    id: v.id,
    name: v.name,
    type: isViewType(v.type) ? v.type : "table",
    sortOrder: v.sortOrder,
    config: parseViewConfig(v.config),
  }));
}

export async function getDatabaseDTO(databaseId: string): Promise<DatabaseDTO | null> {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: {
      page: true,
      properties: { orderBy: { sortOrder: "asc" } },
      views: { orderBy: { sortOrder: "asc" } },
      records: {
        // Only the three page columns the DTO actually reads. `include: page`
        // pulled every record's ENTIRE page row - including `content`, the whole
        // TipTap document - so opening a 500-row database loaded 500 full
        // documents to render titles and icons.
        include: {
          page: { select: { title: true, icon: true, archivedAt: true } },
          values: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!db) return null;
  const personOptions = await personOptionsFor(db.workspaceId);
  const live = db.records.filter((r) => !r.page.archivedAt);
  // A parent that was archived would otherwise leave its children pointing at a
  // record the client never receives; surfacing them as roots matches how the
  // sidebar treats pages whose parent is in the trash.
  const liveIds = new Set(live.map((r) => r.id));
  const records: RecordDTO[] = live.map((r) => {
    const values: Record<string, unknown> = {};
    for (const v of r.values) {
      values[v.propertyId] = parseJson<unknown>(v.value, null);
    }
    return {
      id: r.id,
      pageId: r.pageId,
      title: r.page.title,
      icon: r.page.icon,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      values,
      parentRecordId:
        r.parentRecordId && liveIds.has(r.parentRecordId) ? r.parentRecordId : null,
      mapX: r.mapX,
      mapY: r.mapY,
      collapsed: r.collapsed,
    };
  });

  return {
    id: db.id,
    pageId: db.pageId,
    title: db.page.title,
    properties: db.properties.map((p) => propertyToDTO(p, personOptions)),
    records,
    views: viewsToDTO(db.views),
  };
}
