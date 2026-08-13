"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { PropertyDTO, RecordDTO } from "@/lib/types";
import type { DatabaseActions } from "@/components/DatabasePage";
import { useAutosave } from "@/lib/useAutosave";
import PropertyValueCell from "./PropertyValueCell";

/**
 * The record's title cell.
 *
 * This used to PATCH on every keystroke: typing "Roadmap" put seven
 * unordered requests on the wire carrying "R", "Ro", "Roa", … and whichever
 * prefix committed last was the title you were left with - while each one
 * re-scanned every unresolved wikilink in the workspace. Every other text
 * input in this table already keeps a local draft (PropertyValueCell commits
 * on blur); the page header's title saves through useAutosave. This does the
 * same: a draft while you type, then one debounced save at a time, each
 * carrying the latest text - see the ordering guarantee in useAutosave.
 */
function TitleCell({ record, actions }: { record: RecordDTO; actions: DatabaseActions }) {
  const [draft, setDraft] = useState(record.title);
  const [adopted, setAdopted] = useState(record.title);

  const save = useCallback(
    (title: string) => actions.renameRecord(record.id, title),
    [actions, record.id]
  );
  const { state, error, schedule, retry } = useAutosave(save, { delay: 500 });

  // Follow a rename that happened elsewhere - the mind map, a resync - but
  // only while we have nothing of our own outstanding: adopting mid-edit would
  // yank the caret back to a prefix the user has already typed past (our own
  // optimistic echo arrives as a prop change too). Derived during render, as
  // PropertyValueCell does, so there's no flash of the stale value.
  if (record.title !== adopted) {
    setAdopted(record.title);
    if (state === "saved") setDraft(record.title);
  }

  return (
    <>
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          schedule(e.target.value);
        }}
        placeholder="Untitled"
        aria-invalid={state === "error" || undefined}
        className={`flex-1 bg-transparent font-medium focus:outline-none placeholder:text-[var(--faint)] ${
          state === "error" ? "text-[var(--danger)]" : ""
        }`}
      />
      {state === "error" && (
        <button
          onClick={retry}
          title={error ?? "This title didn't save"}
          className="shrink-0 text-xs text-[var(--danger)] hover:underline"
        >
          ⚠ Retry
        </button>
      )}
    </>
  );
}

export default function TableView({
  properties,
  records,
  actions,
}: {
  properties: PropertyDTO[];
  records: RecordDTO[];
  actions: DatabaseActions;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
            <th className="py-1.5 pr-3 font-medium min-w-56">Name</th>
            {properties.map((p) => (
              <th key={p.id} className="py-1.5 px-3 font-medium min-w-36 group">
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => actions.renameProperty(p.id)}
                    title="Rename property"
                    className="hover:underline"
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => actions.deleteProperty(p.id)}
                    title="Delete property"
                    className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-[var(--danger)]"
                  >
                    ×
                  </button>
                </span>
              </th>
            ))}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border-soft)] group hover:bg-[var(--row-hover)]">
              <td className="py-1 pr-3">
                <div className="flex items-center gap-1">
                  <TitleCell record={r} actions={actions} />
                  <Link
                    href={`/p/${r.pageId}`}
                    title="Open as page"
                    className="opacity-0 group-hover:opacity-100 rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--elevated)] shrink-0"
                  >
                    Open ↗
                  </Link>
                </div>
              </td>
              {properties.map((p) => (
                <td key={p.id} className="py-1 px-3 align-middle">
                  <PropertyValueCell
                    property={p}
                    value={r.values[p.id]}
                    onChange={(v) => actions.setValue(r.id, p.id, v)}
                    onAddOption={(name) => actions.addOption(p.id, name)}
                  />
                </td>
              ))}
              <td className="py-1 text-right">
                <button
                  onClick={() => actions.trashRecord(r.id)}
                  title="Move record to trash"
                  className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-[var(--danger)]"
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={properties.length + 2}>
              <button
                onClick={() => actions.addRecord()}
                className="w-full text-left py-1.5 text-[var(--faint)] hover:text-[var(--fg)] text-sm"
              >
                + New record
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
