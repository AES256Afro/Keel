// Tidy-tree layout for the mind map.
//
// A simplified Reingold–Tilford: walk the forest depth-first, give every leaf
// the next free slot on the cross axis, and centre each parent on its children.
// That produces the "no crossed edges, no wasted space" look people expect from
// a mind map, and it is deterministic - the same tree always lays out the same
// way, so the canvas doesn't reshuffle itself when someone renames a node.
//
// Nodes with a saved position keep it (someone dragged them deliberately); the
// layout only fills in the ones that have never been placed.

export interface LayoutInput {
  id: string;
  parentRecordId: string | null;
  sortOrder: number;
  collapsed: boolean;
  mapX: number | null;
  mapY: number | null;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  depth: number;
  /** Hidden because an ancestor is collapsed. */
  hidden: boolean;
  childCount: number;
  /** Position came from the record, not the layout. */
  pinned: boolean;
}

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 44;
/** Horizontal gap between depth levels. */
export const LEVEL_GAP = 90;
/** Vertical gap between sibling rows. */
export const ROW_GAP = 16;

const ROW_PITCH = NODE_HEIGHT + ROW_GAP;
const COL_PITCH = NODE_WIDTH + LEVEL_GAP;

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  /** Edges to draw: parent → child, both visible. */
  edges: { from: string; to: string }[];
  width: number;
  height: number;
}

export function layoutMindMap(records: LayoutInput[], direction: "right" | "down" = "right"): LayoutResult {
  const present = new Set(records.map((r) => r.id));
  const byParent = new Map<string | null, LayoutInput[]>();
  for (const r of records) {
    // An orphan (parent archived or filtered away) becomes a root rather than
    // disappearing off the canvas.
    const key = r.parentRecordId && present.has(r.parentRecordId) ? r.parentRecordId : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(r);
    else byParent.set(key, [r]);
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);

  const nodes = new Map<string, LayoutNode>();
  const edges: { from: string; to: string }[] = [];
  const visited = new Set<string>();
  let nextRow = 0;

  /** Returns the cross-axis slot this node was centred on. */
  const place = (node: LayoutInput, depth: number, hidden: boolean): number => {
    // Defensive: a cycle that slipped past validation must terminate.
    if (visited.has(node.id)) return nextRow;
    visited.add(node.id);

    const children = byParent.get(node.id) ?? [];
    const childrenHidden = hidden || node.collapsed;

    let slot: number;
    if (children.length === 0) {
      slot = nextRow;
      // A hidden node occupies no space - its whole branch is folded away.
      if (!hidden) nextRow += 1;
    } else if (childrenHidden) {
      // Folded: this node takes a single row, and the subtree is still walked
      // so every descendant gets a position and a `hidden` flag. Skipping the
      // walk here would leave them out of the node map entirely, and the
      // unreachable-node fallback below would then dump them at the origin.
      slot = nextRow;
      if (!hidden) nextRow += 1;
      for (const child of children) place(child, depth + 1, true);
    } else {
      const slots = children.map((c) => place(c, depth + 1, false));
      slot = (Math.min(...slots) + Math.max(...slots)) / 2;
    }

    const auto =
      direction === "down"
        ? { x: slot * (NODE_WIDTH + ROW_GAP), y: depth * (NODE_HEIGHT + LEVEL_GAP) }
        : { x: depth * COL_PITCH, y: slot * ROW_PITCH };

    const pinned = node.mapX != null && node.mapY != null;
    nodes.set(node.id, {
      id: node.id,
      x: pinned ? node.mapX! : auto.x,
      y: pinned ? node.mapY! : auto.y,
      depth,
      hidden,
      childCount: children.length,
      pinned,
    });

    if (!childrenHidden) {
      for (const child of children) edges.push({ from: node.id, to: child.id });
    }
    return slot;
  };

  for (const root of byParent.get(null) ?? []) {
    place(root, 0, false);
    nextRow += 0.5; // a little air between separate trees
  }

  // Anything unreachable (a cycle among non-roots) still needs a position.
  for (const r of records) {
    if (nodes.has(r.id)) continue;
    nodes.set(r.id, {
      id: r.id,
      x: r.mapX ?? 0,
      y: r.mapY ?? nextRow++ * ROW_PITCH,
      depth: 0,
      hidden: false,
      childCount: 0,
      pinned: r.mapX != null && r.mapY != null,
    });
  }

  let width = 0;
  let height = 0;
  for (const n of nodes.values()) {
    if (n.hidden) continue;
    width = Math.max(width, n.x + NODE_WIDTH);
    height = Math.max(height, n.y + NODE_HEIGHT);
  }
  return { nodes, edges, width, height };
}

/**
 * A cubic Bézier from the right edge of one node to the left edge of the next.
 * Control points sit halfway between, which keeps the curve flat for siblings
 * and gently S-shaped across levels.
 */
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  direction: "right" | "down" = "right"
): string {
  if (direction === "down") {
    const x1 = from.x + NODE_WIDTH / 2;
    const y1 = from.y + NODE_HEIGHT;
    const x2 = to.x + NODE_WIDTH / 2;
    const y2 = to.y;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/** Ids hidden because an ancestor is collapsed - used to skip rendering. */
export function hiddenIds(result: LayoutResult): Set<string> {
  const out = new Set<string>();
  for (const [id, node] of result.nodes) if (node.hidden) out.add(id);
  return out;
}
