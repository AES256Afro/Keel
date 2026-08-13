#!/usr/bin/env node
// The force-directed layout behind the graph view.
//
// Pure maths with no database and no browser, so this runs in milliseconds and
// covers the failure modes that are invisible on screen: a single NaN anywhere
// in the simulation silently propagates to every node on the next step and the
// graph renders as an empty canvas with no error.
//
//   node --experimental-strip-types --no-warnings scripts/graph-check.mjs
import { register } from "node:module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);
const { ALPHA_DECAY, ALPHA_MIN, bounds, neighbours, nodeRadius, seedPositions, settle, step } =
  await import(
  pathToFileURL(path.join(root, "src/lib/graph-layout.ts")).href
  );

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const OPTS = { width: 1200, height: 800 };
const node = (id, degree = 0) => ({ id, title: id, type: "document", degree, x: 0, y: 0, vx: 0, vy: 0 });
const finite = (list) => list.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));

console.log("\nGraph layout\n");

/* ---- seeding ---- */

{
  const nodes = [node("a"), node("b"), node("c")];
  seedPositions(nodes, OPTS);
  check("seeding places every node at a finite position", finite(nodes));

  const distinct = new Set(nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`));
  check("seeded nodes do not land on top of each other", distinct.size === nodes.length);

  // The whole point of the seeded PRNG: open the graph tomorrow and it is the
  // same picture, so the layout becomes a place you recognise.
  const again = [node("a"), node("b"), node("c")];
  seedPositions(again, OPTS);
  check(
    "seeding is deterministic across runs",
    nodes.every((n, i) => n.x === again[i].x && n.y === again[i].y)
  );

  // Ids drive the seed, so a different id must not reproduce another's jitter.
  const other = [node("x"), node("y"), node("z")];
  seedPositions(other, OPTS);
  check(
    "different ids get different placements",
    other.some((n, i) => n.x !== nodes[i].x || n.y !== nodes[i].y)
  );
}

/* ---- degenerate inputs ---- */

{
  const nodes = [];
  seedPositions(nodes, OPTS);
  check("empty graph seeds without dividing by zero", true);
  check("empty graph settles", Number.isFinite(settle(nodes, [], OPTS)));
  const b = bounds([]);
  check("empty bounds are zeroed rather than ±Infinity", b.minX === 0 && b.maxX === 0);
}

{
  const nodes = [node("solo")];
  seedPositions(nodes, OPTS);
  settle(nodes, [], OPTS);
  check("single node stays finite", finite(nodes));
}

{
  // Exactly coincident nodes are the classic force-layout crash: distance is
  // zero, the inverse-square force is Infinity, and everything becomes NaN.
  const nodes = [node("a"), node("b"), node("c")];
  for (const n of nodes) {
    n.x = 500;
    n.y = 400;
  }
  step(nodes, [], OPTS);
  check("coincident nodes do not produce NaN", finite(nodes));
  check(
    "coincident nodes are pushed apart",
    nodes.some((n) => n.x !== 500 || n.y !== 400)
  );
}

{
  // An edge naming a node that isn't in the set - reachable if the API ever
  // returns an edge whose endpoint was filtered out.
  const nodes = [node("a")];
  seedPositions(nodes, OPTS);
  step(nodes, [{ source: "a", target: "ghost", resolved: false }], OPTS);
  check("edge to a missing node is skipped, not fatal", finite(nodes));
}

/* ---- simulation behaviour ---- */

{
  const nodes = [node("a", 1), node("b", 1)];
  seedPositions(nodes, OPTS);
  const apart = Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y);
  settle(nodes, [{ source: "a", target: "b", resolved: true }], OPTS);
  const together = Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y);
  check("linked nodes are pulled closer than their seed ring", together < apart, `${apart.toFixed(0)} → ${together.toFixed(0)}`);
}

{
  const nodes = [node("a"), node("b")];
  nodes[0].x = 600;
  nodes[0].y = 400;
  nodes[1].x = 610;
  nodes[1].y = 400;
  step(nodes, [], OPTS);
  check("unlinked nodes repel", Math.abs(nodes[0].x - nodes[1].x) > 10);
}

{
  const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`, i % 5));
  const edges = Array.from({ length: 39 }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
    resolved: true,
  }));
  seedPositions(nodes, OPTS);
  const steps = settle(nodes, edges, OPTS, 400);
  check("a 40-node chain settles before the step budget", steps < 400, `${steps} steps`);
  check("settled layout is finite", finite(nodes));

  const b = bounds(nodes);
  check("bounds enclose every node", nodes.every((n) => n.x >= b.minX && n.x <= b.maxX && n.y >= b.minY && n.y <= b.maxY));
}

{
  // Pinning is what makes dragging feel solid - a fixed node must not drift.
  const nodes = [node("a"), node("b")];
  seedPositions(nodes, OPTS);
  nodes[0].fixed = true;
  const { x, y } = nodes[0];
  settle(nodes, [{ source: "a", target: "b", resolved: true }], OPTS);
  check("a fixed node never moves", nodes[0].x === x && nodes[0].y === y);
  check("the unfixed node still moves", nodes[1].x !== undefined && finite(nodes));
}

{
  // Speed capping: without it one huge impulse throws a node off-canvas before
  // damping catches up, and it never comes back.
  const nodes = Array.from({ length: 30 }, (_, i) => node(`c${i}`));
  for (const n of nodes) {
    n.x = 600 + (Math.abs(hash(n.id)) % 3) * 0.05;
    n.y = 400;
  }
  step(nodes, [], OPTS);
  check("dense cluster stays finite", finite(nodes));
  check("no node is flung beyond the speed cap", nodes.every((n) => Math.hypot(n.vx, n.vy) <= 30.0001));
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ---- annealing ---- */

{
  // The reason alpha exists. Damping alone only balances against forces that
  // are re-applied every step, so whether a graph comes to rest depends on
  // where its nodes happened to start - some seeds settle, others wander in a
  // low-energy jitter forever. Cooling removes the dependence on luck: across a
  // spread of seeds, every one of them must reach rest.
  const chain = (prefix, n) => {
    const nodes = Array.from({ length: n }, (_, i) => node(`${prefix}${i}`, 2));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({
      source: `${prefix}${i}`,
      target: `${prefix}${i + 1}`,
      resolved: true,
    }));
    seedPositions(nodes, OPTS);
    return { nodes, edges };
  };

  const seeds = ["h", "q", "w", "z", "m", "t"];
  const uncooled = seeds.map((prefix) => {
    const { nodes, edges } = chain(prefix, 40);
    let energy = 0;
    for (let i = 0; i < 800; i++) energy = step(nodes, edges, { ...OPTS, alpha: 1 });
    return energy;
  });
  const cooled = seeds.map((prefix) => {
    const { nodes, edges } = chain(prefix, 40);
    return settle(nodes, edges, OPTS, 400);
  });

  check(
    "cooling settles every seed, uncooled does not",
    cooled.every((s) => s < 400) && uncooled.some((e) => e >= 0.05),
    `uncooled residual energy ${uncooled.map((e) => e.toFixed(3)).join(", ")}`
  );
  check(
    "no seed needs the full step budget once cooled",
    Math.max(...cooled) < 400,
    `worst ${Math.max(...cooled)} steps`
  );
}

{
  const nodes = Array.from({ length: 40 }, (_, i) => node(`k${i}`, 2));
  const edges = Array.from({ length: 39 }, (_, i) => ({
    source: `k${i}`,
    target: `k${i + 1}`,
    resolved: true,
  }));
  seedPositions(nodes, OPTS);
  const steps = settle(nodes, edges, OPTS, 400);
  check("cooled layout reaches rest well inside the budget", steps < 400, `${steps} steps`);

  // And having reached rest it must stay there - a settled graph that drifts
  // when you come back to it is worse than one that never settled.
  const before = nodes.map((n) => ({ x: n.x, y: n.y }));
  settle(nodes, edges, { ...OPTS, alpha: 0 }, 100);
  const drift = Math.max(...nodes.map((n, i) => Math.hypot(n.x - before[i].x, n.y - before[i].y)));
  check("a cold layout does not drift", drift < 1, `max drift ${drift.toFixed(3)}px`);
}

{
  check("alpha decay actually cools", ALPHA_DECAY > 0 && ALPHA_DECAY < 1);
  const steps = Math.ceil(Math.log(ALPHA_MIN) / Math.log(ALPHA_DECAY));
  check("cooling reaches ALPHA_MIN in a usable number of steps", steps > 50 && steps < 500, `${steps} steps`);
}

{
  // alpha: 0 means no forces at all, so nothing may move.
  const nodes = [node("a"), node("b")];
  nodes[0].x = 100; nodes[0].y = 100;
  nodes[1].x = 101; nodes[1].y = 100;
  const energy = step(nodes, [], { ...OPTS, alpha: 0 });
  check("alpha 0 freezes the layout", energy === 0 && nodes[0].x === 100 && nodes[1].x === 101);
}

/* ---- helpers ---- */

{
  check("radius grows with degree", nodeRadius(10) > nodeRadius(1));
  check("radius is capped for hubs", nodeRadius(10_000) <= 19.0001);
  check("an unlinked node still has a visible radius", nodeRadius(0) >= 5);
}

{
  const edges = [
    { source: "a", target: "b", resolved: true },
    { source: "c", target: "a", resolved: true },
    { source: "c", target: "d", resolved: true },
  ];
  const near = neighbours(edges, "a");
  check("neighbours follows edges in both directions", near.has("b") && near.has("c"), [...near].join(","));
  check("neighbours excludes the node itself", !near.has("a"));
  check("neighbours excludes two-hop nodes", !near.has("d"));
  check("neighbours of an unknown id is empty", neighbours(edges, "nope").size === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
