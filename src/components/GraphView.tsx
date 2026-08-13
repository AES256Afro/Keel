"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ALPHA_DECAY,
  ALPHA_MIN,
  bounds,
  neighbours,
  nodeRadius,
  seedPositions,
  settle,
  step,
  type GraphEdge,
  type GraphNode,
} from "@/lib/graph-layout";
import { travelledPastThreshold, wheelDelta } from "@/lib/canvas-gesture";

interface ApiNode {
  id: string;
  title: string;
  type: string;
  degree: number;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const CANVAS = { width: 1200, height: 800 };

/** How warm to run the layout after an interaction - enough to rearrange, not
 *  enough to throw away the shape you already recognise. */
const REHEAT = 0.4;

/**
 * The workspace link graph - Lattics calls this the "Aerial" view.
 *
 * Rendered to a canvas rather than SVG: a few hundred nodes with edges is
 * thousands of DOM elements, and every simulation tick would mutate all of
 * them. Canvas redraws the frame instead, which stays smooth while the layout
 * settles and while panning.
 *
 * The graph is the payoff for the link layer - it only becomes interesting once
 * pages actually reference each other, which is why it ships after wikilinks
 * rather than as a standalone toy.
 */
export default function GraphView({ initialTag }: { initialTag?: string | null }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  // Which filter the nodes currently on screen were fetched for. "Loading" is
  // derived from this rather than stored, so changing a filter doesn't require
  // setting state synchronously inside the fetch effect.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [tag, setTag] = useState(initialTag ?? "");
  // What the fetch actually filters on. The input updates on every keystroke;
  // the request must not - /api/graph allows 30 calls a minute per user, and
  // typing one tag name spends most of that budget on results nobody sees, so
  // the view throttles itself into a blank screen (see the error state below).
  const [queryTag, setQueryTag] = useState(initialTag ?? "");
  const [showOrphans, setShowOrphans] = useState(true);
  /**
   * Why the graph on screen isn't what was asked for. Distinct from "the graph
   * is empty": a refused request left the previous nodes in place and must say
   * so, because rendering "Nothing tagged #x" over a 429 tells the user a
   * falsehood about their own workspace.
   */
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Try again to re-run the fetch effect for the same filter. */
  const [reloads, setReloads] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);

  // Mutable simulation state, deliberately outside React: the animation loop
  // mutates positions 60 times a second and re-rendering for each would be
  // pointless work - the canvas is redrawn directly.
  const simRef = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // Where the press started, and whether it ever travelled past DRAG_THRESHOLD
  // - the same test the mind map applies to its node drags. Refs, not state:
  // written inside pointermove at event rate, and read in the click that the
  // browser synthesises immediately after pointerup, before any re-render.
  const gestureRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const hoveredRef = useRef<string | null>(null);
  // Layout temperature. Starts cold because the initial arrangement is settled
  // up front, off-screen; only interaction reheats it.
  const alphaRef = useRef(0);

  /* ---------------- Load ---------------- */

  // Declared before the effect that calls it - a `useCallback` referenced above
  // its own definition is a use-before-declare, and the React compiler bails out
  // of memoising the whole component when it sees one.
  const fitToScreen = useCallback((list: GraphNode[]) => {
    const el = wrapperRef.current;
    if (!el || list.length === 0) return;
    const b = bounds(list);
    const pad = 60;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const zoom = Math.min(
      2,
      Math.max(0.15, Math.min((el.clientWidth - pad * 2) / w, (el.clientHeight - pad * 2) / h))
    );
    setViewport({
      zoom,
      x: (el.clientWidth - w * zoom) / 2 - b.minX * zoom,
      y: (el.clientHeight - h * zoom) / 2 - b.minY * zoom,
    });
  }, []);

  // Settle the typing before spending a request on it.
  useEffect(() => {
    if (tag === queryTag) return;
    const timer = setTimeout(() => setQueryTag(tag), 300);
    return () => clearTimeout(timer);
  }, [tag, queryTag]);

  const filterKey = `${queryTag}|${showOrphans ? "1" : "0"}`;
  const loading = loadedKey !== filterKey;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (queryTag) params.set("tag", queryTag);
    if (!showOrphans) params.set("orphans", "0");

    fetch(`/api/graph?${params}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        // A refused request is not an empty workspace. 429 is the one a user
        // meets in ordinary use - the per-minute budget, which then blocks for
        // a further minute - so it says how to get out of it.
        throw new Error(
          r.status === 429
            ? "Too many graph requests just now - give it a minute, then try again."
            : `Couldn't load the graph (${r.status}).`
        );
      })
      .then((data: { nodes: ApiNode[]; edges: GraphEdge[]; truncated?: boolean }) => {
        if (cancelled) return;
        const laid: GraphNode[] = data.nodes.map((n) => ({
          ...n,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
        }));
        seedPositions(laid, CANVAS);
        // Settle before the first paint so the graph appears arranged rather
        // than visibly flailing into shape - but cap the work. Each step is
        // O(n²); at the 600-node ceiling an unbounded 300-step settle is ~108M
        // operations run synchronously here, blocking the main thread on load.
        // Bound total pre-settle work to a few frames' worth (~4M ops); the
        // live animation loop, which cools via alpha, finishes the arranging.
        const preSteps = Math.max(20, Math.min(300, Math.floor(4_000_000 / Math.max(1, laid.length ** 2))));
        settle(laid, data.edges, CANVAS, preSteps);
        simRef.current = { nodes: laid, edges: data.edges };
        setNodes(laid);
        setEdges(data.edges);
        setTruncated(Boolean(data.truncated));
        fitToScreen(laid);
        // Warm the live loop so it finishes arranging across frames - for a
        // large graph the capped pre-settle above only got it partway, and the
        // rAF loop cooling from here spreads the rest over time instead of
        // blocking. Small graphs are already settled, so this is a brief,
        // invisible top-up.
        alphaRef.current = REHEAT;
        setError(null);
        // Last, so the spinner clears only once there is something to show.
        setLoadedKey(filterKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Say what happened and leave whatever was already on screen alone:
        // blanking the canvas here is what turned a throttled request into a
        // confident claim that the workspace has no pages.
        setError(err instanceof Error && err.message ? err.message : "Couldn't load the graph.");
        // A failed fetch still has to clear the spinner, or the view hangs on it
        // forever with no way back.
        setLoadedKey(filterKey);
      });
    return () => {
      cancelled = true;
    };
  }, [queryTag, showOrphans, filterKey, fitToScreen, reloads]);

  /* ---------------- Draw ---------------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = wrapper.clientWidth;
    const height = wrapper.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Colours come from the theme so the graph follows light/dark.
    const styles = getComputedStyle(document.documentElement);
    const fg = styles.getPropertyValue("--fg").trim() || "#111";
    const muted = styles.getPropertyValue("--muted").trim() || "#666";
    const link = styles.getPropertyValue("--link").trim() || "#2563eb";

    const { nodes: sim, edges: simEdges } = simRef.current;
    const active = hoveredRef.current;
    const near = active ? neighbours(simEdges, active) : null;

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    const byId = new Map(sim.map((n) => [n.id, n]));

    // Edges are drawn in the muted text colour, not --border. Border is tuned
    // to separate large blocks of UI and is far too faint for a hairline on a
    // white field - at 1px it disappears, and a graph whose edges you cannot
    // see has failed at the only thing it is for.
    for (const edge of simEdges) {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) continue;
      const touched = active && (edge.source === active || edge.target === active);
      ctx.strokeStyle = touched ? link : muted;
      // Hovering dims everything unrelated hard, so the neighbourhood reads as
      // a shape rather than as slightly-bolder lines in a thicket.
      ctx.globalAlpha = active ? (touched ? 0.95 : 0.06) : 0.32;
      ctx.lineWidth = (touched ? 1.8 : 1) / viewport.zoom;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const node of sim) {
      const r = nodeRadius(node.degree);
      const isActive = node.id === active;
      const isNear = near?.has(node.id) ?? false;
      const dimmed = active && !isActive && !isNear;

      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node.type === "database" ? link : muted;
      ctx.fill();
      if (isActive) {
        ctx.lineWidth = 2 / viewport.zoom;
        ctx.strokeStyle = fg;
        ctx.stroke();
      }

      // Labels only when they'd be legible, and always for the hovered node -
      // drawing every label at low zoom is unreadable mush and slow.
      const showLabel = isActive || isNear || (viewport.zoom > 0.55 && node.degree > 0);
      if (showLabel) {
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.fillStyle = isActive ? fg : muted;
        ctx.font = `${isActive ? 600 : 400} ${12 / viewport.zoom}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
        ctx.fillText(label, node.x, node.y + r + 3 / viewport.zoom);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [viewport]);

  /* ---------------- Animate ---------------- */

  useEffect(() => {
    let alive = true;
    // Redraw only when something actually changed. `draw` reads the theme with
    // getComputedStyle, which forces a style recalculation - running that every
    // frame on a graph that has come to rest is pure battery burn.
    let dirty = true;
    let lastHovered = hoveredRef.current;

    const tick = () => {
      if (!alive) return;
      const { nodes: sim, edges: simEdges } = simRef.current;

      // A graph that never stops moving is exhausting to look at, so the
      // simulation cools rather than running to a fixed frame budget: it comes
      // to rest because the forces have gone to zero, not because we cut it off
      // mid-jitter.
      if (alphaRef.current > ALPHA_MIN && sim.length > 0) {
        step(sim, simEdges, { ...CANVAS, alpha: alphaRef.current });
        alphaRef.current *= ALPHA_DECAY;
        dirty = true;
      }
      // Dragging moves a node directly, so it needs redrawing even when cold.
      if (dragRef.current) dirty = true;
      if (hoveredRef.current !== lastHovered) {
        lastHovered = hoveredRef.current;
        dirty = true;
      }

      if (dirty) {
        draw();
        dirty = false;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      alive = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [draw]);

  /* ---------------- Interaction ---------------- */

  const toGraph = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport]
  );

  const nodeAt = useCallback((x: number, y: number): GraphNode | null => {
    // Reverse order so the topmost drawn node wins, matching what's visible.
    const sim = simRef.current.nodes;
    for (let i = sim.length - 1; i >= 0; i--) {
      const node = sim[i];
      const r = nodeRadius(node.degree) + 4;
      if ((node.x - x) ** 2 + (node.y - y) ** 2 <= r * r) return node;
    }
    return null;
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    gestureRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
    // A gesture that ended in pointercancel never produced a click, so its
    // verdict is still sitting here; clearing it on every press keeps a stale
    // one from swallowing the next, genuine click.
    suppressClickRef.current = false;
    const { x, y } = toGraph(e.clientX, e.clientY);
    const node = nodeAt(x, y);
    if (node) {
      node.fixed = true;
      // Warm the layout so the rest of the graph gives way as you drag.
      alphaRef.current = REHEAT;
      dragRef.current = { id: node.id, dx: x - node.x, dy: y - node.y };
    } else {
      panRef.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
      setPanning(true);
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (gesture && !gesture.moved) {
      gesture.moved = travelledPastThreshold(
        gesture.startX,
        gesture.startY,
        e.clientX,
        e.clientY
      );
    }

    const pan = panRef.current;
    if (pan) {
      setViewport((v) => ({
        ...v,
        x: pan.vx + (e.clientX - pan.x),
        y: pan.vy + (e.clientY - pan.y),
      }));
      return;
    }

    const { x, y } = toGraph(e.clientX, e.clientY);
    const drag = dragRef.current;
    if (drag) {
      const node = simRef.current.nodes.find((n) => n.id === drag.id);
      if (node) {
        node.x = x - drag.dx;
        node.y = y - drag.dy;
      }
      return;
    }

    const over = nodeAt(x, y);
    if (over?.id !== hoveredRef.current) {
      hoveredRef.current = over?.id ?? null;
      setHovered(over?.id ?? null);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    // A drag keeps the node pinned under the cursor, so the click that follows
    // release always lands on it and used to navigate away - rearranging the
    // graph dumped you on the page you had just moved. A pan that happens to
    // end over a node did the same. Only a press that never travelled is a
    // click; hand that verdict to onClick, which runs next.
    suppressClickRef.current = gestureRef.current?.moved ?? false;
    gestureRef.current = null;
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
    }
    if (dragRef.current) {
      const node = simRef.current.nodes.find((n) => n.id === dragRef.current!.id);
      // Released nodes rejoin the simulation, so the graph re-settles around
      // where you put things rather than snapping back.
      if (node) node.fixed = false;
      alphaRef.current = REHEAT;
      dragRef.current = null;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onClick = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      // Consumed here rather than left set: the next click must be believed.
      suppressClickRef.current = false;
      return;
    }
    const { x, y } = toGraph(e.clientX, e.clientY);
    const node = nodeAt(x, y);
    if (node) router.push(`/p/${node.id}`);
  };

  /**
   * Zoom on wheel, from a NATIVE listener rather than React's onWheel.
   *
   * React attaches wheel at the root as a passive listener, so preventDefault()
   * from a synthetic handler is ignored: a trackpad pinch (which arrives as
   * ctrl+wheel) zoomed the whole browser page instead of the graph, and an
   * ordinary wheel scrolled the workspace behind the canvas while also zooming.
   * A non-passive listener on the wrapper is the only way to claim the gesture.
   */
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      // deltaMode is 0 (pixels) for trackpads but 1 (lines) or 2 (pages) for
      // some mice and for Firefox - normalised by the same helper MindMapView
      // uses, so the two canvases stay literally identical here.
      const { dx, dy } = wheelDelta(e, el);
      // A horizontal gesture - a two-finger trackpad swipe, shift+wheel on
      // Windows - arrives as deltaX with deltaY exactly 0. Zooming keys off the
      // SIGN of deltaY, so zero used to fall into the zoom-out branch: every
      // event of a horizontal burst multiplied zoom by 0.89 and a sustained
      // swipe pinned the graph at the 0.15 floor, while preventDefault() below
      // suppressed the browser's own scroll, so the gesture did nothing but
      // destroy the viewport. Pan on the horizontal axis instead (matching the
      // drag-to-pan sign convention), and let a genuinely empty event do
      // nothing at all.
      if (dy === 0) {
        if (dx !== 0) setViewport((v) => ({ ...v, x: v.x - dx }));
        return;
      }
      setViewport((v) => {
        const zoom = Math.min(2.5, Math.max(0.15, v.zoom * (dy < 0 ? 1.12 : 0.89)));
        const scale = zoom / v.zoom;
        // Keep the point under the cursor fixed while zooming.
        return { zoom, x: ox - (ox - v.x) * scale, y: oy - (oy - v.y) * scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const hoveredNode = useMemo(
    () => (hovered ? nodes.find((n) => n.id === hovered) ?? null : null),
    [hovered, nodes]
  );

  const linkedCount = edges.length;
  const orphanCount = nodes.filter((n) => n.degree === 0).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted)]">
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value.replace(/^#/, ""))}
          placeholder="Filter by tag…"
          className="w-40 rounded border border-[var(--border)] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showOrphans}
            onChange={(e) => setShowOrphans(e.target.checked)}
          />
          Show unlinked ({orphanCount})
        </label>
        <button
          onClick={() => fitToScreen(simRef.current.nodes)}
          className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)]"
        >
          Fit
        </button>
        <span className="ml-auto text-xs text-[var(--faint)]">
          {nodes.length} page{nodes.length === 1 ? "" : "s"} · {linkedCount} link
          {linkedCount === 1 ? "" : "s"}
          {truncated && " · showing the most recent 600"}
        </span>
      </div>

      <div
        ref={wrapperRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        className="relative h-[72vh] min-h-[440px] w-full touch-none overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]"
        style={{ cursor: panning ? "grabbing" : hovered ? "pointer" : "grab" }}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />

        {loading && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-[var(--faint)]">
            Building the graph…
          </p>
        )}

        {error && (
          <div
            role="alert"
            // The wrapper turns clicks into node navigation; this pill's own
            // button must not be one of them.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="absolute left-1/2 top-3 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--danger)] bg-[var(--elevated)] px-3 py-2 text-xs shadow-lg"
          >
            <span className="shrink-0 text-[var(--danger)]">⚠ Not loaded</span>
            <span className="min-w-0 flex-1 text-[var(--muted)]">{error}</span>
            <button
              onClick={() => {
                setError(null);
                setLoadedKey(null);
                setReloads((n) => n + 1);
              }}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
            >
              Try again
            </button>
          </div>
        )}

        {/* Emptiness is only claimed when the server actually said the graph is
            empty - never when the request was refused. */}
        {!loading && !error && nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm text-[var(--faint)]">
              {queryTag ? `Nothing tagged #${queryTag}.` : "No pages to graph yet."}
            </p>
            {!queryTag && (
              <p className="max-w-sm text-xs text-[var(--faint)]">
                Link pages with{" "}
                <code className="rounded bg-[var(--hover)] px-1">[[double brackets]]</code> and
                they&apos;ll appear here, connected.
              </p>
            )}
          </div>
        )}

        {hoveredNode && (
          <div className="pointer-events-none absolute left-3 top-3 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm shadow-lg">
            <span className="font-medium">{hoveredNode.title}</span>
            <span className="ml-2 text-xs text-[var(--faint)]">
              {hoveredNode.degree} link{hoveredNode.degree === 1 ? "" : "s"}
            </span>
          </div>
        )}

        <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-[var(--faint)]">
          Click to open · drag to rearrange · scroll to zoom
        </p>
      </div>
    </div>
  );
}
