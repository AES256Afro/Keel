import { prisma } from "@/lib/prisma";
import { createDocumentPage } from "@/lib/pages";
import { toJson } from "@/lib/json";
import { serializeViewConfig, type ViewConfig } from "@/lib/views";
import { OPTION_COLORS, type PropertyType, type SelectOption } from "@/lib/types";

/* ---------- Tiny TipTap document builders ---------- */

type Node = Record<string, unknown>;

const text = (t: string): Node => ({ type: "text", text: t });
const p = (t?: string): Node => ({
  type: "paragraph",
  ...(t ? { content: [text(t)] } : {}),
});
const h = (level: number, t: string): Node => ({
  type: "heading",
  attrs: { level },
  content: [text(t)],
});
const bullets = (...items: string[]): Node => ({
  type: "bulletList",
  content: items.map((i) => ({ type: "listItem", content: [p(i)] })),
});
const todos = (...items: string[]): Node => ({
  type: "taskList",
  content: items.map((i) => ({
    type: "taskItem",
    attrs: { checked: false },
    content: [p(i)],
  })),
});
const divider = (): Node => ({ type: "horizontalRule" });
const doc = (...content: Node[]) => ({ type: "doc", content });

/* ---------- Template definitions ---------- */

export interface TemplateDef {
  key: string;
  name: string;
  icon: string;
  description: string;
  kind: "document" | "database";
  content?: object;
  properties?: { name: string; type: PropertyType; options?: string[] }[];
  /**
   * `parent` names another record in this list by title, so a template can
   * ship a HIERARCHY rather than a flat table - which is what makes a mind map
   * template meaningful. Parents must appear before their children.
   */
  records?: {
    title: string;
    values?: Record<string, unknown>;
    parent?: string;
  }[];
  /**
   * Saved views the template starts with. The FIRST one is what opens, so a
   * template can land you in the view it was designed around instead of always
   * dropping you in a table.
   *
   * `groupBy` names a property in this template's `properties` list - the live
   * ViewConfig wants a property ID, which exists only once the template is
   * applied, so the applier resolves the name then.
   */
  views?: {
    name: string;
    type: "table" | "list" | "board" | "mindmap" | "timeline";
    config?: { groupBy?: string };
  }[];
}

export const TEMPLATES: TemplateDef[] = [
  {
    key: "meeting-notes",
    name: "Meeting notes",
    icon: "🗓️",
    description: "Agenda, notes, decisions and action items",
    kind: "document",
    content: doc(
      h(2, "Attendees"),
      bullets("…"),
      h(2, "Agenda"),
      bullets("Topic 1", "Topic 2"),
      h(2, "Notes"),
      p(),
      h(2, "Decisions"),
      bullets("…"),
      h(2, "Action items"),
      todos("Owner - task", "Owner - task")
    ),
  },
  {
    key: "project-plan",
    name: "Project plan",
    icon: "🎯",
    description: "Goal, scope, milestones and risks",
    kind: "document",
    content: doc(
      h(2, "Goal"),
      p("What does success look like?"),
      h(2, "Scope"),
      bullets("In scope: …", "Out of scope: …"),
      h(2, "Milestones"),
      todos("Milestone 1", "Milestone 2", "Milestone 3"),
      h(2, "Risks"),
      bullets("Risk - mitigation"),
      divider(),
      p("Links and references go here.")
    ),
  },
  {
    key: "personal-notes",
    name: "Personal notes",
    icon: "📝",
    description: "A simple free-form notes page",
    kind: "document",
    content: doc(h(2, "Notes"), p(), divider(), h(2, "Ideas"), bullets("…")),
  },
  {
    key: "weekly-planning",
    name: "Weekly planning",
    icon: "📆",
    description: "Priorities and a day-by-day plan",
    kind: "document",
    content: doc(
      h(2, "Top priorities"),
      todos("Priority 1", "Priority 2", "Priority 3"),
      h(2, "Monday"),
      todos("…"),
      h(2, "Tuesday"),
      todos("…"),
      h(2, "Wednesday"),
      todos("…"),
      h(2, "Thursday"),
      todos("…"),
      h(2, "Friday"),
      todos("…"),
      h(2, "Review"),
      p("What went well? What should change next week?")
    ),
  },
  {
    key: "mind-map",
    name: "Mind map",
    icon: "🧠",
    description: "Break an idea down branch by branch - then switch to the board to work it",
    kind: "database",
    // Opens in the mind map. The board and table are the same rows seen
    // differently, which is the point: think in the map, work in the board,
    // nothing to keep in sync.
    views: [
      { name: "Map", type: "mindmap" },
      { name: "Board", type: "board", config: { groupBy: "Status" } },
      { name: "All", type: "table" },
    ],
    properties: [
      { name: "Status", type: "select", options: ["Idea", "Exploring", "Decided", "Parked"] },
      { name: "Owner", type: "person" },
      { name: "Notes", type: "text" },
    ],
    // Parents come before children - the applier resolves `parent` by title.
    records: [
      { title: "The idea", values: { Status: "Exploring", Notes: "Rename me: this is the centre of the map." } },
      { title: "Why it matters", parent: "The idea", values: { Status: "Idea" } },
      { title: "Who it's for", parent: "The idea", values: { Status: "Idea" } },
      { title: "How it works", parent: "The idea", values: { Status: "Exploring" } },
      { title: "What could go wrong", parent: "The idea", values: { Status: "Idea" } },
      { title: "First step", parent: "How it works", values: { Status: "Decided" } },
      { title: "Open question", parent: "How it works", values: { Status: "Idea" } },
      { title: "Biggest risk", parent: "What could go wrong", values: { Status: "Exploring" } },
    ],
  },
  {
    key: "task-tracker",
    name: "Task tracker",
    icon: "✅",
    description: "Tasks with assignee, progress, status, priority and due dates",
    kind: "database",
    views: [
      { name: "Board", type: "board", config: { groupBy: "Status" } },
      // Same rows as the board: the map shows how the work breaks down, the
      // board shows where it is. Dragging in either updates the other.
      { name: "Breakdown", type: "mindmap" },
      { name: "All tasks", type: "table" },
    ],
    properties: [
      { name: "Status", type: "select", options: ["To do", "In progress", "Done"] },
      { name: "Assignee", type: "person" },
      { name: "Progress", type: "progress" },
      { name: "Priority", type: "select", options: ["Low", "Medium", "High"] },
      { name: "Due", type: "date" },
    ],
    records: [
      { title: "My first task", values: { Status: "To do", Priority: "High" } },
      { title: "Break it into steps", parent: "My first task", values: { Status: "To do", Priority: "Medium" } },
      { title: "…then do the first one", parent: "My first task", values: { Status: "To do", Priority: "Low" } },
      { title: "Another task", values: { Status: "In progress", Priority: "Medium" } },
    ],
  },
  {
    key: "bug-tracker",
    name: "Bug tracker",
    icon: "🐛",
    description: "Bugs with status, severity and links",
    kind: "database",
    properties: [
      { name: "Status", type: "select", options: ["Open", "In progress", "Fixed", "Won't fix"] },
      { name: "Severity", type: "select", options: ["Low", "Medium", "High", "Critical"] },
      { name: "Link", type: "url" },
    ],
    records: [{ title: "Example bug report", values: { Status: "Open", Severity: "Medium" } }],
  },
  {
    key: "decision-log",
    name: "Decision log",
    icon: "🧭",
    description: "Track decisions, their status and dates",
    kind: "database",
    properties: [
      { name: "Status", type: "select", options: ["Proposed", "Accepted", "Rejected"] },
      { name: "Date", type: "date" },
      { name: "Area", type: "multiSelect", options: ["Product", "Tech", "Process"] },
    ],
    records: [{ title: "Example decision", values: { Status: "Proposed" } }],
  },
  {
    key: "content-calendar",
    name: "Content calendar",
    icon: "🗞️",
    description: "Plan posts with status, channel and publish date",
    kind: "database",
    properties: [
      { name: "Status", type: "select", options: ["Idea", "Drafting", "Review", "Published"] },
      { name: "Channel", type: "multiSelect", options: ["Blog", "Newsletter", "Social"] },
      { name: "Publish date", type: "date" },
    ],
    records: [{ title: "Example post", values: { Status: "Idea", Channel: ["Blog"] } }],
  },
];

/* ---------- Creation ---------- */

function optionsFor(names: string[]): SelectOption[] {
  return names.map((name, i) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    color: OPTION_COLORS[i % OPTION_COLORS.length],
  }));
}

export async function createFromTemplate(
  key: string,
  opts: { workspaceId: string; userId: string; parentPageId?: string | null }
): Promise<{ pageId: string }> {
  const template = TEMPLATES.find((t) => t.key === key);
  if (!template) throw new Error("Unknown template");

  if (template.kind === "document") {
    const page = await createDocumentPage({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      parentPageId: opts.parentPageId ?? null,
      title: template.name,
      icon: template.icon,
      content: toJson(template.content),
    });
    return { pageId: page.id };
  }

  // Database template. One transaction for the whole apply - a template is
  // ~30 creates, and a failure partway (SQLITE_BUSY on a contended server, a
  // restart) must not leave a half-built database in the sidebar that a retry
  // then duplicates.
  return prisma.$transaction(async (tx) => {
    // Same next-slot query as nextSortOrder in pages.ts, on the tx client:
    // without it the page keeps Prisma's @default(0) and pins to the TOP of
    // the sidebar, where every other creation path appends to the bottom.
    const last = await tx.page.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        parentPageId: opts.parentPageId ?? null,
        archivedAt: null,
      },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const page = await tx.page.create({
      data: {
        workspaceId: opts.workspaceId,
        parentPageId: opts.parentPageId ?? null,
        type: "database",
        title: template.name,
        icon: template.icon,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        createdById: opts.userId,
        editedById: opts.userId,
        database: { create: { workspaceId: opts.workspaceId } },
      },
      include: { database: true },
    });
    const databaseId = page.database!.id;

    const propIdByName = new Map<string, string>();
    const optionIdByProp = new Map<string, Map<string, string>>();
    let sortOrder = 1;
    for (const def of template.properties ?? []) {
      const options = def.options ? optionsFor(def.options) : undefined;
      const created = await tx.databaseProperty.create({
        data: {
          databaseId,
          name: def.name,
          type: def.type,
          settings: options ? toJson({ options }) : null,
          sortOrder: sortOrder++,
        },
      });
      propIdByName.set(def.name, created.id);
      if (options) {
        optionIdByProp.set(created.id, new Map(options.map((o) => [o.name, o.id])));
      }
    }

    // Views first, so the database opens in the one the template was designed
    // around. Without this every template landed in a table, which made the mind
    // map and timeline views effectively undiscoverable.
    let viewOrder = 1;
    for (const view of template.views ?? []) {
      // The template names its group-by property; the live config wants the id
      // created above. Resolved here, then written through the same sanitize
      // path as every other view write - an unresolvable name degrades to the
      // reader's fallback rather than storing a key no reader knows.
      const config: ViewConfig = {};
      if (view.config?.groupBy) {
        config.groupByPropertyId = propIdByName.get(view.config.groupBy) ?? null;
      }
      await tx.databaseView.create({
        data: {
          databaseId,
          name: view.name,
          type: view.type,
          sortOrder: viewOrder++,
          config: view.config ? serializeViewConfig(config) : null,
        },
      });
    }

    const recordIdByTitle = new Map<string, string>();
    let recordOrder = 1;
    for (const rec of template.records ?? []) {
      const record = await tx.databaseRecord.create({
        data: {
          database: { connect: { id: databaseId } },
          sortOrder: recordOrder++,
          // Templates name a parent by title; it was created earlier in this
          // loop, so the id is already known. An unknown name degrades to a root
          // node rather than failing the whole template.
          ...(rec.parent && recordIdByTitle.has(rec.parent)
            ? { parent: { connect: { id: recordIdByTitle.get(rec.parent)! } } }
            : {}),
          page: {
            create: {
              workspaceId: opts.workspaceId,
              parentPageId: page.id,
              type: "record",
              title: rec.title,
              content: toJson({ type: "doc", content: [{ type: "paragraph" }] }),
              createdById: opts.userId,
              editedById: opts.userId,
            },
          },
        },
      });
      recordIdByTitle.set(rec.title, record.id);
      for (const [propName, raw] of Object.entries(rec.values ?? {})) {
        const propertyId = propIdByName.get(propName);
        if (!propertyId) continue;
        const optionIds = optionIdByProp.get(propertyId);
        let value: unknown = raw;
        if (optionIds) {
          value = Array.isArray(raw)
            ? raw.map((n) => optionIds.get(String(n))).filter(Boolean)
            : optionIds.get(String(raw)) ?? null;
        }
        await tx.databaseValue.create({
          data: { recordId: record.id, propertyId, value: toJson(value) },
        });
      }
    }

    return { pageId: page.id };
  });
}
