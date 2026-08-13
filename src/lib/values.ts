import type { PropertyDTO } from "@/lib/types";

/** Render a property value as plain text (CSV export, list chips, sorting, filtering). */
export function valueToText(value: unknown, property: PropertyDTO): string {
  if (value == null) return "";
  switch (property.type) {
    case "checkbox":
      return value ? "true" : "false";
    case "progress":
      return `${Number(value) || 0}%`;
    case "person":
    case "select": {
      const opt = property.settings.options?.find((o) => o.id === value);
      return opt?.name ?? "";
    }
    case "multiSelect": {
      const ids = Array.isArray(value) ? value : [];
      return ids
        .map((id) => property.settings.options?.find((o) => o.id === id)?.name ?? "")
        .filter(Boolean)
        .join(", ");
    }
    default:
      return String(value);
  }
}
