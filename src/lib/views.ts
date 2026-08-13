// Saved views.
//
// A database is a set of records; a view is a way of looking at them. Table,
// list, board and mind map are all the same records with different geometry -
// which is the whole point: a task you drag between board columns is the same
// task whose branch you collapse in the mind map.
//
// Everything view-specific lives in `config` (JSON on the row) so adding a new
// knob never needs a migration. Everything RECORD-specific (parent, position)
// lives on the record, so dragging one node writes one small row.

import { parseJson, toJson } from "@/lib/json";

export type ViewType = "table" | "list" | "board" | "mindmap" | "timeline";

export const VIEW_TYPES: { type: ViewType; label: string; icon: string }[] = [
  { type: "table", label: "Table", icon: "▦" },
  { type: "list", label: "List", icon: "☰" },
  { type: "board", label: "Board", icon: "▤" },
  { type: "mindmap", label: "Mind map", icon: "◈" },
  { type: "timeline", label: "Timeline", icon: "⧗" },
];

export type SortDirection = "asc" | "desc";

/** Column key for records whose group value is null - JSON keys can't be null. */
export const NO_GROUP = "__none__";

export interface ViewConfig {
  /** Board columns / list grouping. A select-like property id. */
  groupByPropertyId?: string | null;
  /** Board rows. A second select-like property id; null = no swimlanes. */
  swimlanePropertyId?: string | null;
  /** Quick text filter, applied across the title and all property values. */
  filter?: string;
  sortPropertyId?: string | null;
  sortDir?: SortDirection;
  /** Properties hidden in this view (table columns, card fields). */
  hiddenPropertyIds?: string[];
  /** Board only: max cards per column, keyed by option id or NO_GROUP. */
  wipLimits?: Record<string, number>;
  /** Board only: columns folded to a narrow strip. */
  collapsedColumns?: string[];
  /** Board only: explicit left-to-right column order (option ids). */
  columnOrder?: string[];
  /** Board/mind map: which properties render on a card/node. */
  cardPropertyIds?: string[];
  /** Timeline specifics. */
  timeline?: {
    /** Which date property places a record on the axis. */
    datePropertyId?: string | null;
    /** Optional second date property turning points into spans. */
    endDatePropertyId?: string | null;
  };
  /** Mind map specifics. */
  mindmap?: {
    /** Focus the map on one subtree; null = every root. */
    rootRecordId?: string | null;
    /** "auto" re-lays out on every change; "manual" respects dragged positions. */
    layout?: "auto" | "manual";
    direction?: "right" | "down" | "radial";
    /** Show the group-by property as a coloured dot on each node. */
    showStatus?: boolean;
  };
}

export interface ViewDTO {
  id: string;
  name: string;
  type: ViewType;
  sortOrder: number;
  config: ViewConfig;
}

export function isViewType(value: unknown): value is ViewType {
  return VIEW_TYPES.some((v) => v.type === value);
}

export function parseViewConfig(raw: string | null): ViewConfig {
  const parsed = parseJson<ViewConfig>(raw, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function serializeViewConfig(config: ViewConfig): string {
  return toJson(sanitizeConfig(config));
}

/**
 * Keep only known keys with plausible values.
 *
 * `config` is written straight from the client, and it is a JSON blob the
 * server later reads back and acts on - so it gets the same treatment as any
 * other request body rather than being trusted because it "came from our UI".
 */
export function sanitizeConfig(input: unknown): ViewConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: ViewConfig = {};

  const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);
  const idList = (v: unknown, max = 200) =>
    Array.isArray(v) ? (v.filter((x) => id(x)) as string[]).slice(0, max) : undefined;

  if ("groupByPropertyId" in c) out.groupByPropertyId = id(c.groupByPropertyId);
  if ("swimlanePropertyId" in c) out.swimlanePropertyId = id(c.swimlanePropertyId);
  if (typeof c.filter === "string") out.filter = c.filter.slice(0, 200);
  if ("sortPropertyId" in c) out.sortPropertyId = id(c.sortPropertyId);
  if (c.sortDir === "asc" || c.sortDir === "desc") out.sortDir = c.sortDir;

  const hidden = idList(c.hiddenPropertyIds);
  if (hidden) out.hiddenPropertyIds = hidden;
  const cardProps = idList(c.cardPropertyIds, 20);
  if (cardProps) out.cardPropertyIds = cardProps;
  const colOrder = idList(c.columnOrder);
  if (colOrder) out.columnOrder = colOrder;
  const collapsed = idList(c.collapsedColumns);
  if (collapsed) out.collapsedColumns = collapsed;

  if (c.wipLimits && typeof c.wipLimits === "object") {
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(c.wipLimits as Record<string, unknown>)) {
      const n = Number(value);
      // 0 means "no limit"; anything above a few hundred is meaningless.
      if (id(key) && Number.isFinite(n) && n >= 0 && n <= 999) limits[key] = Math.round(n);
    }
    if (Object.keys(limits).length <= 100) out.wipLimits = limits;
  }

  if (c.timeline && typeof c.timeline === "object") {
    const t = c.timeline as Record<string, unknown>;
    out.timeline = {
      datePropertyId: id(t.datePropertyId),
      endDatePropertyId: id(t.endDatePropertyId),
    };
  }

  if (c.mindmap && typeof c.mindmap === "object") {
    const m = c.mindmap as Record<string, unknown>;
    out.mindmap = {
      rootRecordId: id(m.rootRecordId),
      layout: m.layout === "manual" ? "manual" : "auto",
      direction: m.direction === "down" || m.direction === "radial" ? m.direction : "right",
      showStatus: m.showStatus !== false,
    };
  }

  return out;
}

/** The views a brand-new database starts with. */
export function defaultViews(): { name: string; type: ViewType; sortOrder: number; config: ViewConfig }[] {
  return [
    { name: "Table", type: "table", sortOrder: 1, config: {} },
    { name: "Board", type: "board", sortOrder: 2, config: {} },
  ];
}

/**
 * A view to render when a database has none saved - older databases created
 * before views existed, and the read-only paths that shouldn't write rows.
 */
export function fallbackViews(): ViewDTO[] {
  return [
    { id: "virtual-table", name: "Table", type: "table", sortOrder: 1, config: {} },
    { id: "virtual-list", name: "List", type: "list", sortOrder: 2, config: {} },
    { id: "virtual-board", name: "Board", type: "board", sortOrder: 3, config: {} },
    { id: "virtual-mindmap", name: "Mind map", type: "mindmap", sortOrder: 4, config: {} },
    { id: "virtual-timeline", name: "Timeline", type: "timeline", sortOrder: 5, config: {} },
  ];
}
