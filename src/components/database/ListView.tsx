"use client";

import Link from "next/link";
import type { PropertyDTO, RecordDTO } from "@/lib/types";
import type { DatabaseActions } from "@/components/DatabasePage";
import { valueToText } from "@/lib/values";
import { OptionChip } from "./PropertyValueCell";

export default function ListView({
  properties,
  records,
  actions,
}: {
  properties: PropertyDTO[];
  records: RecordDTO[];
  actions: DatabaseActions;
}) {
  return (
    <div className="divide-y divide-[var(--border-soft)]">
      {records.map((r) => (
        <div key={r.id} className="group flex items-center gap-3 py-2">
          <Link
            href={`/p/${r.pageId}`}
            className="flex items-center gap-2 min-w-0 flex-1 hover:underline"
          >
            <span>{r.icon ?? "📄"}</span>
            <span className="truncate text-sm font-medium">
              {r.title || <span className="text-[var(--faint)]">Untitled</span>}
            </span>
          </Link>
          <div className="flex items-center gap-2 text-xs text-[var(--muted)] shrink-0">
            {properties.slice(0, 4).map((p) => {
              const value = r.values[p.id];
              if (value == null || value === "") return null;
              if (p.type === "select" || p.type === "person") {
                const opt = p.settings.options?.find((o) => o.id === value);
                return opt ? <OptionChip key={p.id} option={opt} /> : null;
              }
              if (p.type === "multiSelect") {
                const ids = Array.isArray(value) ? (value as string[]) : [];
                return (p.settings.options ?? [])
                  .filter((o) => ids.includes(o.id))
                  .slice(0, 3)
                  .map((o) => <OptionChip key={p.id + o.id} option={o} />);
              }
              const text = valueToText(value, p);
              return text ? <span key={p.id}>{text}</span> : null;
            })}
          </div>
          <button
            onClick={() => actions.trashRecord(r.id)}
            title="Move record to trash"
            className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-[var(--danger)]"
          >
            🗑
          </button>
        </div>
      ))}
      <button
        onClick={() => actions.addRecord()}
        className="w-full text-left py-2 text-[var(--faint)] hover:text-[var(--fg)] text-sm"
      >
        + New record
      </button>
    </div>
  );
}
