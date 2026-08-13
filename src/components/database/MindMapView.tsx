"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PropertyDTO, RecordDTO, SelectOption } from "@/lib/types";
import type { DatabaseActions } from "@/components/DatabasePage";
import type { ViewConfig } from "@/lib/views";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePath,
  layoutMindMap,
  type LayoutNode,
} from "@/lib/mindmap-layout";
import { travelledPastThreshold, wheelDelta } from "@/lib/canvas-gesture";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Mind map over the same records the board shows.
 *
 * A node IS a record: the same row that appears as a card in the board and
 * opens as a page. Edges are the parentRecordId tree. So decomposing a task
 * here and moving it through columns there are two views of one thing, which is
 * the entire reason this is a database view rather than a separate page type.
 *
 * Keyboard model follows every mind-mapper people already know:
 *   Tab           new child of the selection
 *   Enter         new sibling
 *   F2 / dbl-click  rename in place
 *   Space         collapse / expand the branch
 *   ⌫             delete (with its subtree re-parented up, never orphaned)
 *   Arrows        move the selection through the tree
 */
export default function MindMapView({
  properties,
  records,
  actions,
  config,
  updateConfig,
  readOnly = false,
}: {
  properties: PropertyDTO[];
  records: RecordDTO[];
  actions: DatabaseActions;
  config: ViewConfig;
  updateConfig: (patch: Partial<ViewConfig>) => void;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 40, zoom: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [dragNode, setDragNode] = useState<{ id: string; dx: number; dy: number } | null>(null);
  // Where the press started and whether it ever travelled past DRAG_THRESHOLD.
  // A ref, not state: read/written inside pointermove at event rate, and its
  // synchronous null-ing in endDrag is what makes a late lostpointercapture
  // after a normal pointerup harmless.
  const dragMeta = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const [dropOnto, setDropOnto] = useState<string | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // Mirrored in state because the cursor style is rendered from it, and a ref
  // read during render doesn't re-render when it changes.
  const [panning, setPanning] = useState(false);

  const direction = config.mindmap?.direction === "down" ? "down" : "right";
  const showStatus = config.mindmap?.showStatus !== false;

  const statusProp = useMemo(
    () =>
      properties.find((p) => p.id === config.groupByPropertyId) ??
      properties.find((p) => p.type === "select") ??
      null,
    [properties, config.groupByPropertyId]
  );
  const progressProp = properties.find((p) => p.type === "progress");

  const layout = useMemo(
    () =>
      layoutMindMap(
        records.map((r) => ({
          id: r.id,
          parentRecordId: r.parentRecordId,
          sortOrder: r.sortOrder,
          collapsed: r.collapsed,
          mapX: r.mapX,
          mapY: r.mapY,
        })),
        direction
      ),
    [records, direction]
  );

  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const visible = useMemo(
    () => records.filter((r) => !layout.nodes.get(r.id)?.hidden),
    [records, layout]
  );

  const statusOf = useCallback(
    (r: RecordDTO): SelectOption | undefined => {
      if (!statusProp || !showStatus) return undefined;
      return statusProp.settings.options?.find((o) => o.id === r.values[statusProp.id]);
    },
    [statusProp, showStatus]
  );

  /* ---------------- Viewport ---------------- */

  const zoomBy = useCallback((factor: number, originX?: number, originY?: number) => {
    setViewport((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      if (originX == null || originY == null) return { ...v, zoom };
      // Keep the point under the cursor fixed while zooming.
      const scale = zoom / v.zoom;
      return { zoom, x: originX - (originX - v.x) * scale, y: originY - (originY - v.y) * scale };
    });
  }, []);

  const fitToScreen = useCallback(() => {
    const el = canvasRef.current;
    if (!el || layout.width === 0) return;
    const pad = 60;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (el.clientWidth - pad * 2) / Math.max(1, layout.width),
          (el.clientHeight - pad * 2) / Math.max(1, layout.height)
        )
      )
    );
    setViewport({ zoom, x: pad, y: pad });
  }, [layout.width, layout.height]);

  /**
   * Wheel and pinch, on a NATIVE non-passive listener.
   *
   * React registers its `wheel` listener once at the root, and since React 17
   * that listener is passive: preventDefault from an onWheel prop does nothing
   * at all. Without it the browser's own default runs alongside ours - a
   * trackpad pinch (which arrives as ctrl+wheel) zooms the whole page while
   * the canvas zooms, and a plain wheel scrolls the workspace column behind
   * the canvas while we pan, sliding the map out from under the cursor. Both
   * defaults have to be cancelled, so the listener is attached here with
   * { passive: false } instead.
   */
  useEffect(() => {
    const el = canvasRef.current;
    // The empty state below renders no canvas at all; re-running when the
    // first record arrives is what attaches the listener to the one that
    // replaces it.
    if (!el || records.length === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Lines/pages normalised to pixels (shared with GraphView, so the two
      // canvases cannot drift apart again).
      const { dx, dy } = wheelDelta(e, el);
      if (e.ctrlKey || e.metaKey) {
        // A horizontal gesture with ctrl/meta held - a two-finger trackpad
        // swipe, ctrl+shift+wheel, a tilt wheel - arrives as deltaX with
        // deltaY exactly 0. Zoom keys off the SIGN of deltaY, so zero used to
        // fall into the zoom-out branch: every event of such a burst multiplied
        // zoom by 0.9 and discarded deltaX, so a sustained swipe pinned the map
        // at MIN_ZOOM while preventDefault() suppressed the browser's own
        // response - the gesture did nothing but wreck the viewport. Pan on the
        // horizontal axis instead, and let a genuinely empty event do nothing.
        if (dy === 0) {
          if (dx !== 0) setViewport((v) => ({ ...v, x: v.x - dx }));
          return;
        }
        // Zoom about the cursor, so the node under the pointer stays put.
        zoomBy(dy < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setViewport((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, records.length]);

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // Anything the map paints is pointer-transparent except the nodes, and a
    // node stops propagation, so a press that reaches here targeting a child is
    // a press on nothing interactive - treat it as blank canvas. (Requiring
    // target === currentTarget instead is what made pan and deselect dead
    // across the whole map: the transform layer is full-bleed, so it, not the
    // canvas, was the target of every press on empty space.)
    if ((e.target as HTMLElement).closest?.("[data-mindmap-node]")) return;
    setSelected(null);
    panRef.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const pan = panRef.current;
    if (pan) {
      setViewport((v) => ({ ...v, x: pan.vx + (e.clientX - pan.x), y: pan.vy + (e.clientY - pan.y) }));
      return;
    }
    if (!dragNode) return;
    const meta = dragMeta.current;
    // No meta means the drag already ended (endDrag nulls it synchronously);
    // a straggling move event must not revive it.
    if (!meta) return;
    if (!meta.moved) {
      // A press only becomes a drag once the pointer commits to moving. A
      // motionless click must select without pinning: placeNode would freeze
      // the node at its laid-out spot forever and cost a PATCH per click.
      if (!travelledPastThreshold(meta.startX, meta.startY, e.clientX, e.clientY)) return;
      meta.moved = true;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left - viewport.x) / viewport.zoom - dragNode.dx;
    const y = (e.clientY - rect.top - viewport.y) / viewport.zoom - dragNode.dy;
    actions.moveNodeLocal(dragNode.id, x, y);

    // Hovering another node means "make me its child" rather than "put me here".
    const over = visible.find((r) => {
      if (r.id === dragNode.id) return false;
      const n = layout.nodes.get(r.id);
      if (!n) return false;
      const cx = x + NODE_WIDTH / 2;
      const cy = y + NODE_HEIGHT / 2;
      return cx > n.x && cx < n.x + NODE_WIDTH && cy > n.y && cy < n.y + NODE_HEIGHT;
    });
    setDropOnto(over?.id ?? null);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
    if (dragNode) {
      const meta = dragMeta.current;
      dragMeta.current = null;
      // Only a real drag persists anything - a motionless click already did
      // its whole job (selection) on pointerdown.
      if (meta?.moved) {
        const node = layout.nodes.get(dragNode.id);
        if (dropOnto) {
          // Reparent, and clear the manual position so the branch tidies itself
          // into its new home instead of staying where the cursor let go.
          actions.reparentRecord(dragNode.id, dropOnto);
        } else if (node) {
          actions.placeNode(dragNode.id, node.x, node.y);
        }
      }
      setDragNode(null);
      setDropOnto(null);
    }
  };

  /* ---------------- Keyboard ---------------- */

  const siblingsOf = useCallback(
    (id: string) => {
      const record = byId.get(id);
      if (!record) return [];
      return records
        .filter((r) => r.parentRecordId === record.parentRecordId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    [byId, records]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing || readOnly) return;
      const id = selected;

      if (e.key === "Tab") {
        e.preventDefault();
        void actions.addChildNode(id ?? null).then((newId) => newId && setSelected(newId));
        return;
      }
      if (!id) return;
      const record = byId.get(id);
      if (!record) return;

      switch (e.key) {
        case "Enter": {
          e.preventDefault();
          void actions
            .addChildNode(record.parentRecordId)
            .then((newId) => newId && setSelected(newId));
          break;
        }
        case "F2": {
          e.preventDefault();
          setDraftTitle(record.title);
          setEditing(id);
          break;
        }
        case " ": {
          e.preventDefault();
          if ((layout.nodes.get(id)?.childCount ?? 0) > 0) {
            actions.toggleCollapsed(id, !record.collapsed);
          }
          break;
        }
        case "Backspace":
        case "Delete": {
          e.preventDefault();
          const children = records.filter((r) => r.parentRecordId === id);
          if (
            children.length > 0 &&
            !confirm(
              `“${record.title || "Untitled"}” has ${children.length} child node(s). ` +
                `They'll move up to its parent, not be deleted. Continue?`
            )
          ) {
            return;
          }
          setSelected(record.parentRecordId);
          actions.deleteNode(id);
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (record.parentRecordId) setSelected(record.parentRecordId);
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const first = records
            .filter((r) => r.parentRecordId === id)
            .sort((a, b) => a.sortOrder - b.sortOrder)[0];
          if (first) setSelected(first.id);
          break;
        }
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const sibs = siblingsOf(id);
          const i = sibs.findIndex((r) => r.id === id);
          const next = sibs[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) setSelected(next.id);
          break;
        }
      }
    },
    [selected, editing, readOnly, byId, records, layout.nodes, actions, siblingsOf]
  );

  useEffect(() => {
    if (records.length > 0 && viewport.x === 60 && viewport.y === 40 && viewport.zoom === 1) {
      // Only on the very first render with data - after that the user owns the
      // viewport and it must not jump under them.
      fitToScreen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length > 0]);

  const commitTitle = (id: string) => {
    const record = byId.get(id);
    setEditing(null);
    if (record && draftTitle !== record.title) actions.renameRecord(id, draftTitle);
  };

  if (records.length === 0) {
    return (
      <div className="py-16 text-center space-y-3">
        <p className="text-sm text-[var(--faint)]">
          Nothing to map yet. Every record in this database is a node.
        </p>
        {!readOnly && (
          <button
            onClick={() => void actions.addChildNode(null).then((id) => id && setSelected(id))}
            className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium"
          >
            Add the first node
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* ---- Toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
        <button onClick={fitToScreen} className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)]">
          Fit
        </button>
        <button onClick={() => zoomBy(0.9)} className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)]" title="Zoom out">
          −
        </button>
        <span className="tabular-nums text-xs w-10 text-center">{Math.round(viewport.zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.1)} className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)]" title="Zoom in">
          +
        </button>
        <label className="flex items-center gap-1.5 ml-2">
          Direction
          <select
            value={direction}
            onChange={(e) =>
              updateConfig({
                mindmap: { ...config.mindmap, direction: e.target.value as "right" | "down" },
              })
            }
            className="rounded border border-[var(--border)] px-2 py-1 bg-[var(--elevated)]"
          >
            <option value="right">Left to right</option>
            <option value="down">Top down</option>
          </select>
        </label>
        {statusProp && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showStatus}
              onChange={(e) =>
                updateConfig({ mindmap: { ...config.mindmap, showStatus: e.target.checked } })
              }
            />
            Show {statusProp.name}
          </label>
        )}
        {!readOnly && (
          <button
            onClick={() => actions.autoLayout(records.map((r) => r.id))}
            className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)] ml-auto"
            title="Discard manual positions and re-tidy the whole map"
          >
            Tidy up
          </button>
        )}
      </div>

      {/* ---- Canvas ---- */}
      <div
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Mind map canvas"
        // No onWheel here: React's root wheel listener is passive, so the
        // handler is attached natively above (see the wheel effect).
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // A capture lost mid-drag (node unmounted, browser takeover) must
        // still end the drag; bubbles here from the capturing node. After a
        // normal pointerup this fires again, but endDrag already nulled
        // dragMeta synchronously, so nothing is persisted twice.
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
        className="relative h-[70vh] min-h-[420px] w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] focus:outline-none focus:ring-2 focus:ring-blue-400/40 touch-none"
        style={{ cursor: panning ? "grabbing" : "grab" }}
      >
        {/* The transform layer is full-bleed (`inset-0`), and an element's hit
            region is its border box whether or not it painted anything there -
            so while it was hit-testable it swallowed every press on empty map
            area and the canvas below never saw a pointerdown to pan or deselect
            with. Only the nodes inside it take the pointer (they opt back in
            with pointer-events-auto); the rest falls through. */}
        <div
          className="absolute inset-0 origin-top-left pointer-events-none"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          {/* Edges sit under the nodes and don't intercept the pointer. */}
          <svg
            className="absolute pointer-events-none overflow-visible"
            width={Math.max(1, layout.width)}
            height={Math.max(1, layout.height)}
          >
            {layout.edges.map(({ from, to }) => {
              const a = layout.nodes.get(from);
              const b = layout.nodes.get(to);
              if (!a || !b || a.hidden || b.hidden) return null;
              return (
                <path
                  key={`${from}->${to}`}
                  d={edgePath(a, b, direction)}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={2}
                />
              );
            })}
          </svg>

          {visible.map((r) => {
            const node = layout.nodes.get(r.id) as LayoutNode | undefined;
            if (!node) return null;
            const status = statusOf(r);
            const progress =
              progressProp && typeof r.values[progressProp.id] === "number"
                ? (r.values[progressProp.id] as number)
                : null;
            const isSelected = selected === r.id;
            const isDropTarget = dropOnto === r.id;

            return (
              <div
                key={r.id}
                data-mindmap-node={r.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  // A press inside the rename editor is text editing - placing
                  // the caret, drag-selecting - never a node interaction.
                  // Arming the drag would let a selection drag move and pin
                  // the node (a PATCH the user never intended), and focusing
                  // the canvas would blur the input, committing the edit on
                  // the very click meant to continue it.
                  const target = e.target as HTMLElement;
                  if (target.closest?.("input, textarea") || target.isContentEditable) return;
                  setSelected(r.id);
                  canvasRef.current?.focus();
                  if (readOnly) return;
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const px = (e.clientX - rect.left - viewport.x) / viewport.zoom;
                  const py = (e.clientY - rect.top - viewport.y) / viewport.zoom;
                  dragMeta.current = { startX: e.clientX, startY: e.clientY, moved: false };
                  setDragNode({ id: r.id, dx: px - node.x, dy: py - node.y });
                  // Hold the pointer so the drag survives the cursor leaving
                  // the canvas: without capture a release outside never reaches
                  // endDrag, and the node chases the cursor on re-entry. The
                  // capture's pointermove/pointerup retarget to this node and
                  // bubble up to the canvas handlers.
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* pointer already gone - bubbling still reaches endDrag */
                  }
                }}
                onDoubleClick={() => {
                  if (readOnly) return;
                  setDraftTitle(r.title);
                  setEditing(r.id);
                }}
                style={{
                  left: node.x,
                  top: node.y,
                  width: NODE_WIDTH,
                  minHeight: NODE_HEIGHT,
                }}
                className={`pointer-events-auto absolute rounded-lg border bg-[var(--elevated)] px-2.5 py-1.5 shadow-sm select-none ${
                  isDropTarget
                    ? "border-blue-400 ring-2 ring-blue-400"
                    : isSelected
                      ? "border-[var(--fg)] ring-1 ring-[var(--fg)]"
                      : "border-[var(--border)]"
                } ${dragNode?.id === r.id ? "opacity-70" : ""} ${readOnly ? "" : "cursor-grab active:cursor-grabbing"}`}
              >
                <div className="flex items-start gap-1.5">
                  {status && (
                    <span
                      title={status.name}
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full opt-${status.color}`}
                    />
                  )}
                  {editing === r.id ? (
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onBlur={() => commitTitle(r.id)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitTitle(r.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      // select-text: the node carries select-none, which would
                      // otherwise inherit and block drag-selection in here.
                      className="w-full select-text bg-transparent text-sm focus:outline-none"
                    />
                  ) : (
                    <span className="text-sm leading-snug break-words">
                      {r.title || <span className="text-[var(--faint)]">Untitled</span>}
                    </span>
                  )}
                </div>

                {progress !== null && (
                  <div className="mt-1 h-1 rounded-full bg-[var(--hover)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500"
                      style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                    />
                  </div>
                )}

                {/* Open the record as a page - the same page the board links to. */}
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => router.push(`/p/${r.pageId}`)}
                  title="Open as page"
                  className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--elevated)] text-[10px] text-[var(--muted)] hover:text-[var(--fg)] group-hover:flex [div:hover>&]:flex"
                >
                  ↗
                </button>

                {node.childCount > 0 && (
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => actions.toggleCollapsed(r.id, !r.collapsed)}
                    title={r.collapsed ? "Expand branch" : "Collapse branch"}
                    style={
                      direction === "down"
                        ? { left: "50%", bottom: -10, transform: "translateX(-50%)" }
                        : { right: -10, top: "50%", transform: "translateY(-50%)" }
                    }
                    className="absolute flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--elevated)] px-1 text-[10px] tabular-nums text-[var(--muted)] hover:text-[var(--fg)]"
                  >
                    {r.collapsed ? node.childCount : "−"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {!readOnly && (
          <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-[var(--faint)]">
            Tab child · Enter sibling · F2 rename · Space fold · drag onto a node to re-parent
          </p>
        )}
      </div>
    </div>
  );
}
