// Board grouping and drop resolution.
//
// Kept out of BoardView so the two rules that are easy to get subtly wrong -
// "every record is visible somewhere" and "a drop that changes nothing writes
// nothing" - can be tested without a browser (see scripts/mindmap-check.mjs).

import type { PropertyDTO, RecordDTO } from "@/lib/types";
import { NO_GROUP } from "@/lib/views";

/** One column of the board, or one swimlane. */
export interface GroupBucket {
  key: string;
  id: string | null;
  name: string;
  color: string;
  /** True for a bucket that exists only because records still point at a
   *  value whose option is gone. Nothing new should be filed into it. */
  orphan?: boolean;
}

/**
 * The buckets a grouping property produces, in display order: one per option,
 * then one per *orphaned* value, then the catch-all for records with no value.
 *
 * The orphan buckets are the point. For a Person property the options ARE the
 * live member list, so removing a workspace member deletes the option while
 * every DatabaseValue naming that member survives (nothing reconciles them).
 * The same happens to a deleted select option. Those records bucket under a
 * value that matches no column, and a column that is never rendered is never
 * looked up - the cards simply disappeared from the board (not into
 * "Unassigned", whose key is null), silently, while still existing in the
 * table. Giving each surviving value a bucket keeps every record visible,
 * countable against the WIP limit, and draggable back somewhere real.
 */
export function groupBuckets(
  property: Pick<PropertyDTO, "id" | "type" | "settings">,
  records: Pick<RecordDTO, "values">[],
  unassignedLabel: string
): GroupBucket[] {
  const person = property.type === "person";
  const buckets: GroupBucket[] = (property.settings.options ?? []).map((o) => ({
    key: o.id,
    id: o.id,
    name: person ? `@${o.name}` : o.name,
    color: o.color,
  }));

  const known = new Set(buckets.map((b) => b.key));
  for (const record of records) {
    const value = record.values[property.id];
    if (typeof value !== "string" || !value || known.has(value)) continue;
    known.add(value);
    // The name it had is gone with the option, so say what it is rather than
    // inventing one.
    buckets.push({
      key: value,
      id: value,
      name: person ? "@former member" : "Removed option",
      color: "gray",
      orphan: true,
    });
  }

  buckets.push({ key: NO_GROUP, id: null, name: unassignedLabel, color: "gray" });
  return buckets;
}

/** Where a dragged card should be placed: between these two neighbours. */
export interface DropPlan {
  beforeId: string | null;
  afterId: string | null;
}

/**
 * Resolve a drop, or return null when the gesture changed nothing.
 *
 * `siblings` is the destination cell in display order, including the dragged
 * card when it is already in that cell. `dropOnId` is the card it was dropped
 * above (null = dropped on the column's empty space, i.e. the end).
 *
 * Returning null matters: a card is still a drop target while it is being
 * dragged, so picking one up and putting it straight back down used to call
 * moveRecord with `{ beforeId: null, afterId: <itself> }` - the server then
 * computed `sortOrderBetween(null, ownSortOrder)` = own − 1 and the card
 * quietly climbed the column. A gesture that visibly did nothing must write
 * nothing; that also covers dropping a card onto the gap it already occupies.
 */
export function resolveDrop(
  siblings: Pick<RecordDTO, "id">[],
  recordId: string,
  dropOnId: string | null
): DropPlan | null {
  // Dropped on itself: not a move by any reading.
  if (dropOnId === recordId) return null;

  const destination = siblings.filter((r) => r.id !== recordId);
  const index = dropOnId ? destination.findIndex((r) => r.id === dropOnId) : destination.length;
  // A target that isn't in this cell tells us nothing about where to land;
  // treat it as a drop on the column, not as a neighbour we can't see.
  const at = index < 0 ? destination.length : index;
  const afterId = index < 0 ? null : dropOnId;
  const beforeId = at > 0 ? destination[at - 1]?.id ?? null : null;

  const current = siblings.findIndex((r) => r.id === recordId);
  if (current >= 0) {
    const currentBefore = current > 0 ? siblings[current - 1].id : null;
    const currentAfter = current < siblings.length - 1 ? siblings[current + 1].id : null;
    if (beforeId === currentBefore && afterId === currentAfter) return null;
  }

  return { beforeId, afterId };
}
