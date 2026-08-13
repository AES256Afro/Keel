"use client";

import { useState } from "react";
import type { PropertyDTO, SelectOption } from "@/lib/types";

export function OptionChip({ option }: { option: SelectOption }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs opt-${option.color}`}>
      {option.name}
    </span>
  );
}

/**
 * Inline editor for a single property value. Used by the table view and the
 * record page. Commits text-like inputs on blur/Enter; toggles immediately.
 */
export default function PropertyValueCell({
  property,
  value,
  onChange,
  onAddOption,
}: {
  property: PropertyDTO;
  value: unknown;
  onChange: (value: unknown) => void;
  onAddOption?: (name: string) => Promise<SelectOption | null>;
}) {
  // The cell is a controlled input with a local draft so typing doesn't PATCH
  // on every keystroke. When the value changes underneath us (another view,
  // an undo, a board drag), the draft has to follow - adjusted during render
  // rather than in an effect, so there's no flash of the stale value and no
  // cascading second render. This is React's documented pattern for deriving
  // state from props.
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value == null ? "" : String(value));
  }

  const commitText = () => {
    const current = value == null ? "" : String(value);
    if (draft === current) return;
    if (property.type === "number") {
      const n = draft.trim() === "" ? null : Number(draft);
      onChange(n != null && Number.isFinite(n) ? n : null);
    } else {
      onChange(draft.trim() === "" ? null : draft);
    }
  };

  const addOption = async () => {
    if (!onAddOption) return;
    const name = window.prompt("Option name");
    if (!name?.trim()) return;
    const option = await onAddOption(name.trim());
    if (!option) return;
    if (property.type === "select") {
      onChange(option.id);
    } else {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      onChange([...ids, option.id]);
    }
  };

  switch (property.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-blue-600"
        />
      );

    case "date":
      return (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full bg-transparent text-sm focus:outline-none"
        />
      );

    case "select":
    case "person": {
      // Person renders like a select whose options are the workspace members
      // (injected server-side); new options can't be added by hand.
      const options = property.settings.options ?? [];
      const selected = options.find((o) => o.id === value);
      const canAddOption = Boolean(onAddOption) && property.type === "select";
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => {
            if (e.target.value === "__add__") {
              addOption();
            } else {
              onChange(e.target.value || null);
            }
          }}
          className={`w-full bg-transparent text-sm focus:outline-none rounded px-1 py-0.5 ${
            selected ? `opt-${selected.color}` : ""
          }`}
        >
          <option value=""> - </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {property.type === "person" ? `@${o.name}` : o.name}
            </option>
          ))}
          {canAddOption && <option value="__add__">+ New option…</option>}
        </select>
      );
    }

    case "progress": {
      const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
      return (
        <div className="flex items-center gap-2 min-w-32">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={n}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1 accent-blue-600 h-1.5"
          />
          <span className="text-xs text-[var(--muted)] w-9 text-right tabular-nums">{n}%</span>
        </div>
      );
    }

    case "multiSelect": {
      const options = property.settings.options ?? [];
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const chosen = options.filter((o) => ids.includes(o.id));
      return (
        <details className="relative">
          <summary className="list-none cursor-pointer min-h-[1.5rem] flex flex-wrap gap-1 items-center text-sm">
            {chosen.length > 0 ? (
              chosen.map((o) => <OptionChip key={o.id} option={o} />)
            ) : (
              <span className="text-[var(--faint)]"> - </span>
            )}
          </summary>
          <div className="absolute z-30 mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl p-2 space-y-1">
            {options.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={ids.includes(o.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...ids, o.id] : ids.filter((id) => id !== o.id)
                    )
                  }
                  className="h-3.5 w-3.5 accent-blue-600"
                />
                <OptionChip option={o} />
              </label>
            ))}
            {onAddOption && (
              <button onClick={addOption} className="text-xs text-[var(--link)] hover:underline">
                + New option
              </button>
            )}
          </div>
        </details>
      );
    }

    default:
      // text | number | url
      return (
        <input
          type={property.type === "number" ? "number" : "text"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder=" - "
          className={`w-full bg-transparent text-sm focus:outline-none placeholder:text-[var(--faint)] ${
            property.type === "url" ? "text-[var(--link)]" : ""
          }`}
        />
      );
  }
}
