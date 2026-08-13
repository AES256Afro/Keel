import type { ViewDTO } from "@/lib/views";

export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "url"
  | "person"
  | "progress";

export const PROPERTY_TYPES: { type: PropertyType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multiSelect", label: "Multi-select" },
  { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" },
  { type: "url", label: "URL" },
  { type: "person", label: "Person (assignee)" },
  { type: "progress", label: "Progress (%)" },
];

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface PropertySettings {
  options?: SelectOption[];
}

export const OPTION_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;

export interface PropertyDTO {
  id: string;
  name: string;
  type: PropertyType;
  settings: PropertySettings;
  sortOrder: number;
}

export interface RecordDTO {
  id: string;
  pageId: string;
  title: string;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  // propertyId -> parsed value (string | number | boolean | string[] | null)
  values: Record<string, unknown>;
  /** Record tree - the edge the mind map draws. Null for a root. */
  parentRecordId: string | null;
  /** Mind-map canvas position. Null means auto-layout places it. */
  mapX: number | null;
  mapY: number | null;
  /** Mind map: this record's branch is folded. */
  collapsed: boolean;
}

export interface DatabaseDTO {
  id: string;
  pageId: string;
  title: string;
  properties: PropertyDTO[];
  records: RecordDTO[];
  views: ViewDTO[];
}

export interface PageTreeNode {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  children: PageTreeNode[];
}
