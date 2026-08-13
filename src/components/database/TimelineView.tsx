"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PropertyDTO, RecordDTO } from "@/lib/types";
import type { DatabaseActions } from "@/components/DatabasePage";
import type { ViewConfig } from "@/lib/views";
import {
  formatDay,
  monthTicks,
  pxPerDay,
  rangeOf,
  spanOf,
  type TimelineSpan,
} from "@/lib/timeline";
import { OptionChip } from "./PropertyValueCell";

const ROW_H = 34;
const BAR_H = 22;

/** Option colours, matching the chips used everywhere else. */
const BAR_COLORS: Record<string, string> = {
  gray: "#9b9a97",
  red: "#df5452",
  orange: "#d9730d",
  yellow: "#cb9433",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
};

/**
 * Records on a time axis - the fifth way of looking at the same rows.
 *
 * Placement comes from an ordinary date property, so the timeline needs no
 * schema of its own: pick which date drives it (and optionally a second one to
 * give records duration) and every bar is just those values drawn to scale.
 * Dragging a bar writes the dates back through the same setValue path a table
 * cell uses.
 */
export default function TimelineView({
  properties,
  records,
  actions,
  config,
  updateConfig,
  readOnly,
}: {
  properties: PropertyDTO[];
  records: RecordDTO[];
  actions: DatabaseActions;
  config: ViewConfig;
  updateConfig: (patch: Partial<ViewConfig>) => void;
  readOnly: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const dateProps = useMemo(() => properties.filter((p) => p.type === "date"), [properties]);
  const dateProp =
    dateProps.find((p) => p.id === config.timeline?.datePropertyId) ?? dateProps[0] ?? null;
  const endProp =
    dateProps.find(
      (p) => p.id === config.timeline?.endDatePropertyId && p.id !== dateProp?.id
    ) ?? null;

  // Bars pick up the colour of the select property the board groups by - the
  // same knob, so switching views keeps the same colour language.
  const colorProp = useMemo(
    () =>
      properties.find(
        (p) => p.id === config.groupByPropertyId && (p.type === "select" || p.type === "person")
      ) ?? null,
    [properties, config.groupByPropertyId]
  );

  // "Today" is stable for the life of the component render; midnight rollover
  // mid-session moving the line one row is not worth a timer.
  const today = useMemo(() => {
    const d = new Date();
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  }, []);

  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: { record: RecordDTO; span: TimelineSpan }[] = [];
    const unscheduled: RecordDTO[] = [];
    for (const r of records) {
      const span = dateProp
        ? spanOf(r.id, r.values[dateProp.id], endProp ? r.values[endProp.id] : null)
        : null;
      if (span) scheduled.push({ record: r, span });
      else unscheduled.push(r);
    }
    scheduled.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    return { scheduled, unscheduled };
  }, [records, dateProp, endProp]);

  const range = useMemo(
    () => rangeOf(scheduled.map((s) => s.span), today),
    [scheduled, today]
  );
  // A fixed reference width keeps the maths independent of the flexing
  // container; the strip scrolls horizontally when the range outgrows it.
  const scale = pxPerDay(range, 1000);
  const width = Math.ceil((range.max - range.min + 1) * scale);
  const x = (day: number) => (day - range.min) * scale;
  const ticks = useMemo(() => monthTicks(range), [range]);

  /* ---- Dragging a bar moves its dates, preserving duration ---- */
  const dragRef = useRef<{
    recordId: string;
    startX: number;
    origStart: number;
    origEnd: number;
  } | null>(null);
  // Live preview offset in days, applied to the dragged bar only.
  const [preview, setPreview] = useState<{ recordId: string; days: number } | null>(null);

  const onBarPointerDown = (e: React.PointerEvent, s: TimelineSpan) => {
    if (readOnly || !dateProp) return;
    e.preventDefault();
    dragRef.current = { recordId: s.recordId, startX: e.clientX, origStart: s.start, origEnd: s.end };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBarPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPreview({ recordId: drag.recordId, days: Math.round((e.clientX - drag.startX) / scale) });
  };
  const onBarPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !dateProp) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already have been released by a pointercancel.
    }
    const days = Math.round((e.clientX - drag.startX) / scale);
    setPreview(null);
    if (days === 0) return;
    actions.setValue(drag.recordId, dateProp.id, formatDay(drag.origStart + days));
    // Duration is data the user typed; a move must not stretch or shrink it.
    if (endProp && drag.origEnd !== drag.origStart) {
      actions.setValue(drag.recordId, endProp.id, formatDay(drag.origEnd + days));
    }
  };

  const schedule = useCallback(
    (recordId: string) => {
      if (dateProp) actions.setValue(recordId, dateProp.id, formatDay(today));
    },
    [actions, dateProp, today]
  );

  if (!dateProp) {
    return (
      <p className="rounded border border-[var(--border)] px-4 py-6 text-sm text-[var(--muted)]">
        The timeline places records by a <strong>Date</strong> property, and this database has
        none yet - add one with “+ Add property”.
      </p>
    );
  }

  return (
    <div>
      {/* ---- Which dates drive the axis ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
        <label className="flex items-center gap-1">
          Date
          <select
            value={dateProp.id}
            onChange={(e) => updateConfig({ timeline: { ...config.timeline, datePropertyId: e.target.value } })}
            className="rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-1"
          >
            {dateProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {dateProps.length > 1 && (
          <label className="flex items-center gap-1">
            End
            <select
              value={endProp?.id ?? ""}
              onChange={(e) =>
                updateConfig({
                  timeline: { ...config.timeline, datePropertyId: dateProp.id, endDatePropertyId: e.target.value || null },
                })
              }
              className="rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-1"
            >
              <option value="">none</option>
              {dateProps
                .filter((p) => p.id !== dateProp.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <span className="ml-auto tabular-nums">
          {scheduled.length} scheduled · {unscheduled.length} not
        </span>
      </div>

      {/* ---- The strip ---- */}
      <div ref={scrollRef} className="overflow-x-auto rounded border border-[var(--border)]">
        <div style={{ width, minWidth: "100%" }} className="relative">
          {/* Month gridlines + labels */}
          <div className="sticky top-0 flex h-7 border-b border-[var(--border-soft)] text-xs text-[var(--faint)]">
            {ticks.map((t) => (
              <span
                key={t.day}
                style={{ left: x(t.day) }}
                className="absolute top-1.5 border-l border-[var(--border-soft)] pl-1.5 whitespace-nowrap"
              >
                {t.label}
              </span>
            ))}
          </div>
          <div className="relative" style={{ height: Math.max(1, scheduled.length) * ROW_H + 8 }}>
            {ticks.map((t) => (
              <span
                key={t.day}
                style={{ left: x(t.day) }}
                className="absolute inset-y-0 border-l border-[var(--border-soft)]"
              />
            ))}
            {/* Today */}
            <span
              style={{ left: x(today) }}
              data-timeline-today
              className="absolute inset-y-0 z-10 border-l-2 border-[var(--link)] opacity-60"
              title={`Today · ${formatDay(today)}`}
            />
            {scheduled.length === 0 && (
              <p className="px-4 py-6 text-sm text-[var(--faint)]">
                Nothing scheduled yet - set a {dateProp.name} on a record, or drag one up from
                below.
              </p>
            )}
            {scheduled.map(({ record, span }, row) => {
              const shift = preview?.recordId === record.id ? preview.days : 0;
              const start = span.start + shift;
              const end = span.end + shift;
              const barX = x(start);
              const barW = Math.max(8, (end - start + 1) * scale);
              const optId = colorProp ? record.values[colorProp.id] : null;
              const opt = colorProp?.settings.options?.find((o) => o.id === optId);
              const color = opt ? (BAR_COLORS[opt.color] ?? BAR_COLORS.gray) : "var(--muted)";
              // The label sits inside a wide bar, after a narrow one - a title
              // clipped to a 10px sliver is a title lost.
              const labelInside = barW > 140;
              return (
                <div
                  key={record.id}
                  data-timeline-row
                  style={{ top: row * ROW_H + 6, height: BAR_H }}
                  className="absolute inset-x-0"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    data-timeline-bar={record.id}
                    onPointerDown={(e) => onBarPointerDown(e, span)}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={onBarPointerUp}
                    style={{ left: barX, width: barW, background: color }}
                    title={`${record.title || "Untitled"} · ${formatDay(start)}${end !== start ? ` → ${formatDay(end)}` : ""}`}
                    className={`absolute flex h-full items-center overflow-hidden rounded px-2 text-xs text-white ${
                      readOnly ? "" : "cursor-grab active:cursor-grabbing"
                    } ${shift !== 0 ? "ring-2 ring-[var(--link)]" : ""}`}
                  >
                    {labelInside && (
                      <span className="truncate">{record.title || "Untitled"}</span>
                    )}
                  </div>
                  {!labelInside && (
                    <Link
                      href={`/p/${record.pageId}`}
                      style={{ left: barX + barW + 6 }}
                      className="absolute top-0.5 max-w-56 truncate text-xs hover:underline"
                    >
                      {record.title || "Untitled"}
                    </Link>
                  )}
                  {labelInside && (
                    <Link
                      href={`/p/${record.pageId}`}
                      style={{ left: barX + barW + 6 }}
                      className="absolute top-0.5 text-xs text-[var(--faint)] hover:underline"
                      title="Open record"
                    >
                      ↗
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---- Records with no date yet ---- */}
      {unscheduled.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">
            Not scheduled
          </h3>
          <div className="divide-y divide-[var(--border-soft)]">
            {unscheduled.map((r) => (
              <div key={r.id} className="group flex items-center gap-3 py-1.5 text-sm">
                <Link
                  href={`/p/${r.pageId}`}
                  className="flex min-w-0 items-center gap-2 hover:underline"
                >
                  <span>{r.icon ?? "📄"}</span>
                  <span className="truncate">
                    {r.title || <span className="text-[var(--faint)]">Untitled</span>}
                  </span>
                </Link>
                {colorProp &&
                  (() => {
                    const opt = colorProp.settings.options?.find(
                      (o) => o.id === r.values[colorProp.id]
                    );
                    return opt ? <OptionChip option={opt} /> : null;
                  })()}
                {!readOnly && (
                  <button
                    onClick={() => schedule(r.id)}
                    className="ml-auto rounded px-2 py-0.5 text-xs text-[var(--muted)] opacity-0 hover:bg-[var(--hover)] group-hover:opacity-100"
                  >
                    Schedule today
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
