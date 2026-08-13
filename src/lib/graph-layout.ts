// Force-directed layout for the workspace graph.
//
// Written rather than pulled in: d3-force is ~30 kB for one function, and the
// whole point of this app is to stay small and dependency-light. This is the
// standard three-force model - repulsion between every pair, springs along
// edges, and a weak pull to the centre - integrated with velocity damping.
//
// Deterministic on purpose. Seeded placement means the same workspace lays out
// the same way every time you open it, so the graph becomes a place you
// recognise rather than a new picture each visit. It also makes it testable.

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  /** Inbound + outbound links. Drives node size. */
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned by dragging - the simulation stops moving it. */
  fixed?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** False when the link points at a title with no page yet. */
  resolved: boolean;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Higher pushes nodes further apart. */
  repulsion?: number;
  /** 0–1; higher makes edges shorter and stiffer. */
  springStrength?: number;
  springLength?: number;
  /** Pull towards the centre, keeping disconnected nodes from drifting away. */
  gravity?: number;
  damping?: number;
  /**
   * Global force multiplier, 1 down to 0 - the "temperature" of the layout.
   *
   * Without it the simulation never actually stops. Damping alone only balances
   * against the forces, which keep being re-applied every step, so a graph of
   * any size settles into a low-energy jitter and wanders there indefinitely.
   * Cooling the forces towards zero makes coming to rest a property of the
   * model rather than something the caller has to give up and cut short.
   */
  alpha?: number;
}

const DEFAULTS = {
  repulsion: 6000,
  springStrength: 0.02,
  springLength: 110,
  gravity: 0.012,
  damping: 0.82,
  alpha: 1,
};

/** Below this the layout is considered cold and further steps are pointless. */
export const ALPHA_MIN = 0.001;

/** Per-step cooling: reaches ALPHA_MIN in ~300 steps from a standing start. */
export const ALPHA_DECAY = 0.977;

/** Deterministic PRNG (mulberry32) so a workspace always lays out the same. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable numeric seed from a string, so ids map to reproducible positions. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Place nodes on a circle before simulating.
 *
 * Random placement occasionally starts two nodes on top of each other, where
 * the repulsion force is enormous and flings them across the canvas. A ring
 * guarantees separation and converges faster.
 */
export function seedPositions(nodes: GraphNode[], opts: LayoutOptions): void {
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const radius = Math.min(opts.width, opts.height) * 0.35;
  nodes.forEach((node, i) => {
    const rand = seeded(hashString(node.id));
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    // A little jitter breaks the perfect symmetry that stalls the simulation.
    const jitter = 0.85 + rand() * 0.3;
    node.x = cx + Math.cos(angle) * radius * jitter;
    node.y = cy + Math.sin(angle) * radius * jitter;
    node.vx = 0;
    node.vy = 0;
  });
}

/**
 * Advance the simulation one step.
 *
 * O(n²) in the repulsion pass. Barnes–Hut would be asymptotically better, but
 * the caller caps the graph well below the point where that matters, and the
 * quadratic version is a tenth of the code.
 *
 * @returns total kinetic energy, so the caller can stop when it settles.
 */
export function step(nodes: GraphNode[], edges: GraphEdge[], opts: LayoutOptions): number {
  const o = { ...DEFAULTS, ...opts };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cx = o.width / 2;
  const cy = o.height / 2;

  // Repulsion - every pair pushes apart, inverse-square.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        // Exactly coincident: nudge deterministically rather than dividing by
        // zero and producing NaN, which would poison the whole layout.
        dx = (i % 2 === 0 ? 1 : -1) * 0.5;
        dy = (j % 2 === 0 ? 1 : -1) * 0.5;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = (o.repulsion / distSq) * o.alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Springs - linked nodes pull together towards the rest length.
  for (const edge of edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const force = (dist - o.springLength) * o.springStrength * o.alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Gravity, damping, integration.
  let energy = 0;
  for (const node of nodes) {
    if (node.fixed) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx += (cx - node.x) * o.gravity * o.alpha;
    node.vy += (cy - node.y) * o.gravity * o.alpha;
    node.vx *= o.damping;
    node.vy *= o.damping;

    // Cap speed: a dense cluster can otherwise produce one enormous impulse
    // that throws a node off-canvas before damping catches up.
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > 30) {
      node.vx = (node.vx / speed) * 30;
      node.vy = (node.vy / speed) * 30;
    }

    node.x += node.vx;
    node.y += node.vy;
    energy += node.vx * node.vx + node.vy * node.vy;
  }
  return energy;
}

/**
 * Run until the layout settles or the step budget runs out.
 *
 * Used for the initial placement so the graph appears already arranged rather
 * than visibly flailing into shape.
 */
export function settle(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: LayoutOptions,
  maxSteps = 300
): number {
  let steps = 0;
  let alpha = opts.alpha ?? 1;
  for (; steps < maxSteps; steps++) {
    const energy = step(nodes, edges, { ...opts, alpha });
    alpha *= ALPHA_DECAY;
    // Either the layout stopped moving on its own, or it has gone cold and
    // nothing further will change. Both are done.
    if (energy < 0.05 || alpha < ALPHA_MIN) break;
  }
  return steps;
}

/** Bounding box of the laid-out graph, for fit-to-screen. */
export function bounds(nodes: GraphNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Node radius from its degree - well-connected pages read as hubs. */
export function nodeRadius(degree: number): number {
  return 5 + Math.min(14, Math.sqrt(degree) * 3.2);
}

/** Ids reachable from a node in one hop, for hover highlighting. */
export function neighbours(edges: GraphEdge[], id: string): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    else if (e.target === id) out.add(e.source);
  }
  return out;
}
