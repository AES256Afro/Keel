/**
 * Pointer and wheel arithmetic shared by the two pannable canvases -
 * GraphView (the link graph) and MindMapView (a database's mind map).
 *
 * They are separate components for good reasons (one paints to a <canvas> and
 * runs a force simulation, the other lays out DOM nodes and persists positions)
 * but the *input* layer underneath is the same gesture in both: press-drag-pan,
 * press-drag-move-a-node, wheel-to-pan, ctrl+wheel-to-zoom. That duplication has
 * now bitten twice - a movement threshold was added to the mind map alone, and a
 * deltaY-of-exactly-zero guard to the graph alone - so the pieces that are
 * genuinely identical live here, where a fix cannot land in one file only.
 */

/**
 * Pointer travel (in client px) below which a press is a click, not a drag.
 *
 * Under this, a press must behave as a plain click: no node gets pinned to a
 * hand-placed position and no navigation is suppressed. Above it, the gesture
 * has committed to dragging and the click that the browser synthesises on
 * release is not a click the user meant.
 */
export const DRAG_THRESHOLD = 3;

/** Whether a pointer has travelled far enough for the press to count as a drag. */
export function travelledPastThreshold(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): boolean {
  return Math.hypot(clientX - startX, clientY - startY) >= DRAG_THRESHOLD;
}

/**
 * A wheel event's delta in CSS pixels.
 *
 * deltaMode is 0 (pixels) for trackpads and most mice, but 1 (lines) on Firefox
 * and some mice and 2 (pages) rarely - left raw, a three-line notch would pan
 * three pixels. A "page" is the scrollport itself, so it is measured per axis.
 *
 * Callers must test `dy === 0` before deciding a zoom direction: a horizontal
 * trackpad swipe (and shift+wheel, and a tilt wheel) reports deltaX with deltaY
 * exactly 0, and a `dy < 0 ? in : out` test silently reads that as zoom-out.
 */
export function wheelDelta(
  e: WheelEvent,
  el: { clientWidth: number; clientHeight: number }
): { dx: number; dy: number } {
  const unitX = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
  const unitY = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
  return { dx: e.deltaX * unitX, dy: e.deltaY * unitY };
}
