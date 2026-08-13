#!/usr/bin/env node
// Mind-map layout and record-tree unit tests.
//
// Pure functions, no server - these run in milliseconds and catch the failure
// modes that are expensive to spot by eye: a folded branch whose nodes escape
// to the origin, a cycle that hangs the walk, siblings that overlap.
//
//   node scripts/mindmap-check.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` - ${detail}` : ""}`);
  }
}

// The modules under test are TypeScript. Node strips the types itself; the
// loader only teaches it the "@/*" path alias.
register("./ts-loader.mjs", import.meta.url);

const { layoutMindMap, NODE_HEIGHT, NODE_WIDTH } = await import(
  pathToFileURL(path.join(root, "src/lib/mindmap-layout.ts")).href
);
const { buildForest, collectDescendants, sortOrderBetween, needsRenumber } = await import(
  pathToFileURL(path.join(root, "src/lib/record-tree.ts")).href
);
const { groupBuckets, resolveDrop } = await import(
  pathToFileURL(path.join(root, "src/lib/board.ts")).href
);
const { NO_GROUP } = await import(pathToFileURL(path.join(root, "src/lib/views.ts")).href);

const node = (id, parentRecordId, sortOrder, extra = {}) => ({
  id,
  parentRecordId,
  sortOrder,
  collapsed: false,
  mapX: null,
  mapY: null,
  ...extra,
});

/* ---------------- Layout ---------------- */
console.log("\nTidy-tree layout");
{
  const records = [
    node("root", null, 1),
    node("a", "root", 1),
    node("b", "root", 2),
    node("a1", "a", 1),
    node("a2", "a", 2),
  ];
  const { nodes, edges } = layoutMindMap(records);

  check("every record gets a node", nodes.size === records.length, `${nodes.size}`);
  check("nothing is hidden in an expanded tree", [...nodes.values()].every((n) => !n.hidden));
  check("depth increases away from the root", nodes.get("a1").depth === 2 && nodes.get("root").depth === 0);
  check("children sit to the right of their parent", nodes.get("a").x > nodes.get("root").x);
  check("edges connect parents to children", edges.length === 4, `${edges.length}`);

  const parentY = nodes.get("a").y;
  const kids = [nodes.get("a1").y, nodes.get("a2").y];
  check(
    "a parent is centred on its children",
    Math.abs(parentY - (kids[0] + kids[1]) / 2) < 0.001,
    `parent ${parentY} vs children ${kids}`
  );

  const ys = [...nodes.values()].filter((n) => n.depth === 2).map((n) => n.y).sort((p, q) => p - q);
  check("siblings never overlap", ys.every((y, i) => i === 0 || y - ys[i - 1] >= NODE_HEIGHT));
}

/* ---------------- Collapse ---------------- */
console.log("\nFolded branches");
{
  const records = [
    node("root", null, 1),
    node("open", "root", 1),
    node("shut", "root", 2, { collapsed: true }),
    node("openKid", "open", 1),
    node("shutKid", "shut", 1),
    node("shutGrandkid", "shutKid", 1),
  ];
  const { nodes, edges } = layoutMindMap(records);

  // The regression this file exists for: descendants of a collapsed node used
  // to be skipped by the walk entirely, then re-added at the origin by the
  // unreachable-node fallback - so they rendered on top of the canvas.
  check("every descendant of a folded node is present", nodes.size === records.length, `${nodes.size}`);
  check("folded descendants are marked hidden", nodes.get("shutKid").hidden && nodes.get("shutGrandkid").hidden);
  check("the folded node itself stays visible", !nodes.get("shut").hidden);
  check("visible siblings stay visible", !nodes.get("open").hidden && !nodes.get("openKid").hidden);
  check(
    "no edge points into a folded branch",
    edges.every(({ from, to }) => !nodes.get(from).hidden && !nodes.get(to).hidden)
  );
  check(
    "hidden nodes are not dumped at the origin",
    nodes.get("shutKid").x !== 0 || nodes.get("shutKid").depth !== 0,
    JSON.stringify(nodes.get("shutKid"))
  );
  check("a folded node reports how many children it hides", nodes.get("shut").childCount === 1);
}

/* ---------------- Pinned positions ---------------- */
console.log("\nManual positions");
{
  const records = [node("root", null, 1), node("moved", "root", 1, { mapX: 500, mapY: -20 })];
  const { nodes } = layoutMindMap(records);
  check("a dragged node keeps its position", nodes.get("moved").x === 500 && nodes.get("moved").y === -20);
  check("it is flagged as pinned", nodes.get("moved").pinned === true);
  check("an unplaced node is not pinned", nodes.get("root").pinned === false);
}

/* ---------------- Hostile input ---------------- */
console.log("\nMalformed trees terminate");
{
  // A cycle should never reach the layout (the API rejects it), but if bad data
  // exists the renderer must not hang.
  const cyclic = [node("x", "y", 1), node("y", "x", 1)];
  const started = Date.now();
  const { nodes } = layoutMindMap(cyclic);
  check("a cycle terminates", Date.now() - started < 1000);
  check("a cycle still yields a node per record", nodes.size === 2, `${nodes.size}`);

  const orphan = layoutMindMap([node("lonely", "missing-parent", 1)]);
  check("an orphan surfaces as a root", orphan.nodes.get("lonely").depth === 0);
  check("an orphan is visible", !orphan.nodes.get("lonely").hidden);

  const empty = layoutMindMap([]);
  check("an empty database lays out cleanly", empty.nodes.size === 0 && empty.width === 0);
}

/* ---------------- Canvas bounds ---------------- */
console.log("\nCanvas size");
{
  const records = [node("root", null, 1), node("a", "root", 1), node("b", "root", 2)];
  const { width, height, nodes } = layoutMindMap(records);
  const maxX = Math.max(...[...nodes.values()].map((n) => n.x));
  check("width covers the widest node", width >= maxX + NODE_WIDTH);
  check("height covers the tallest column", height >= NODE_HEIGHT);
}

/* ---------------- Record tree helpers ---------------- */
console.log("\nRecord tree helpers");
{
  const records = [
    node("root", null, 1),
    node("b", "root", 2),
    node("a", "root", 1),
    node("a1", "a", 1),
  ];
  const forest = buildForest(records);
  check("one root", forest.length === 1);
  check("children come back in sortOrder", forest[0].children.map((c) => c.record.id).join() === "a,b");
  check("depth is tracked", forest[0].children[0].children[0].depth === 2);

  const descendants = collectDescendants(records, "a");
  check("descendants are inclusive of the root", descendants.has("a") && descendants.has("a1"));
  check("descendants exclude siblings", !descendants.has("b"));

  check("midpoint between two orders", sortOrderBetween(1, 2) === 1.5);
  check("dropping at the top", sortOrderBetween(null, 5) === 4);
  check("dropping at the bottom", sortOrderBetween(5, null) === 6);
  check("dropping into an empty column", sortOrderBetween(null, null) === 1);
  check("collapsed floats are detected", needsRenumber(1, 1 + 1e-9) === true);
  check("healthy gaps are left alone", needsRenumber(1, 2) === false);
}

/* ---------------- Board columns ---------------- */
console.log("\nBoard grouping");
{
  const assignee = {
    id: "person",
    type: "person",
    settings: { options: [{ id: "u1", name: "Ada", color: "blue" }] },
  };
  const rec = (values) => ({ values });

  const plain = groupBuckets(assignee, [rec({ person: "u1" }), rec({})], "Unassigned");
  check("one column per option", plain[0].key === "u1" && plain[0].name === "@Ada");
  check("plus the catch-all, last", plain[plain.length - 1].key === NO_GROUP);
  check("no phantom columns", plain.length === 2, JSON.stringify(plain.map((b) => b.key)));

  // The regression: removing a workspace member deletes the option but leaves
  // every DatabaseValue naming them, and a column that is never rendered is
  // never looked up - those cards vanished from the board altogether.
  const departed = groupBuckets(
    assignee,
    [rec({ person: "u1" }), rec({ person: "gone" }), rec({})],
    "Unassigned"
  );
  const orphan = departed.find((b) => b.key === "gone");
  check("a value whose option was removed still gets a column", Boolean(orphan),
    JSON.stringify(departed.map((b) => b.key)));
  check("it is flagged as an orphan", orphan?.orphan === true);
  check("it is not folded into Unassigned", orphan?.id === "gone");
  check("the catch-all stays last", departed[departed.length - 1].key === NO_GROUP);
  check(
    "every stored value has somewhere to be",
    [{ person: "u1" }, { person: "gone" }, {}].every((v) =>
      departed.some((b) => b.id === (v.person ?? null))
    )
  );

  const twice = groupBuckets(assignee, [rec({ person: "gone" }), rec({ person: "gone" })], "Unassigned");
  check("a repeated orphan value makes one column", twice.filter((b) => b.orphan).length === 1);

  const select = groupBuckets(
    { id: "status", type: "select", settings: { options: [] } },
    [rec({ status: "deleted-option" })],
    "No Status"
  );
  check("a deleted select option is surfaced too", select[0].orphan === true && select[0].id === "deleted-option");
  check("select options are not @-prefixed", select[0].name === "Removed option", select[0].name);
}

/* ---------------- Board drops ---------------- */
console.log("\nBoard drops");
{
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];

  // The regression: a card is still a drop target while it is being dragged,
  // so picking B up and putting it straight back down called moveRecord with
  // { beforeId: null, afterId: "b" } - the server wrote sortOrderBetween(null,
  // own) = own - 1 and B quietly climbed above A.
  check("dropping a card on itself writes nothing", resolveDrop(cards, "b", "b") === null);
  check("dropping it back in its own gap writes nothing", resolveDrop(cards, "b", "c") === null);
  check("dropping the last card at the end writes nothing", resolveDrop(cards, "c", null) === null);
  check("dropping the first card on the second writes nothing", resolveDrop(cards, "a", "b") === null);

  const toTop = resolveDrop(cards, "c", "a");
  check("a real move to the top", toTop?.beforeId === null && toTop?.afterId === "a", JSON.stringify(toTop));

  const toMiddle = resolveDrop(cards, "a", "c");
  check("a real move into the middle", toMiddle?.beforeId === "b" && toMiddle?.afterId === "c", JSON.stringify(toMiddle));

  const toEnd = resolveDrop(cards, "a", null);
  check("a real move to the end", toEnd?.beforeId === "c" && toEnd?.afterId === null, JSON.stringify(toEnd));

  // Arriving from another column: the card is not among its new siblings.
  const arriving = resolveDrop(cards, "z", "b");
  check("a card from another column lands above its target", arriving?.beforeId === "a" && arriving?.afterId === "b", JSON.stringify(arriving));
  const appended = resolveDrop(cards, "z", null);
  check("or at the end of the column", appended?.beforeId === "c" && appended?.afterId === null, JSON.stringify(appended));
  const emptyColumn = resolveDrop([], "z", null);
  check("an empty column takes it whole", emptyColumn?.beforeId === null && emptyColumn?.afterId === null, JSON.stringify(emptyColumn));
  const stale = resolveDrop(cards, "z", "vanished");
  check("a target that isn't there falls back to the end", stale?.beforeId === "c" && stale?.afterId === null, JSON.stringify(stale));
  const single = resolveDrop([{ id: "only" }], "only", null);
  check("the only card in a column cannot move", single === null);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
