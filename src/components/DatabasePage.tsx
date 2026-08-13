"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import PageHeader, { type HeaderPage } from "@/components/PageHeader";
import SaveIndicator from "@/components/SaveIndicator";
import TableView from "@/components/database/TableView";
import ListView from "@/components/database/ListView";
import BoardView from "@/components/database/BoardView";
import MindMapView from "@/components/database/MindMapView";
import TimelineView from "@/components/database/TimelineView";
import {
  OPTION_COLORS,
  PROPERTY_TYPES,
  type DatabaseDTO,
  type PropertyType,
  type RecordDTO,
  type SelectOption,
} from "@/lib/types";
import { valueToText } from "@/lib/values";
import { VIEW_TYPES, type ViewDTO, type ViewType } from "@/lib/views";
import { useViewConfig } from "@/lib/useViewConfig";

export interface DatabaseActions {
  /** Rename a record. Resolves with the server's response so a caller can
   *  order successive renames (the table's title cell autosaves through it)
   *  instead of firing one unordered PATCH per keystroke. */
  renameRecord: (recordId: string, title: string) => Promise<Response>;
  setValue: (recordId: string, propertyId: string, value: unknown) => void;
  addOption: (propertyId: string, name: string) => Promise<SelectOption | null>;
  addRecord: (initial?: { propertyId: string; value: unknown }) => Promise<void>;
  trashRecord: (recordId: string) => void;
  renameProperty: (propertyId: string) => void;
  deleteProperty: (propertyId: string) => void;

  /* ---- Structure. Shared by the board (order within a column) and the mind
     map (order among siblings, tree shape, canvas position). ---- */

  /** Place a record between two neighbours. */
  moveRecord: (recordId: string, between: { beforeId: string | null; afterId: string | null }) => void;
  /** Change a record's parent in the record tree. */
  reparentRecord: (recordId: string, parentRecordId: string | null) => void;
  /** Optimistic canvas move while dragging - not persisted. */
  moveNodeLocal: (recordId: string, x: number, y: number) => void;
  /** Persist a canvas position when the drag ends. */
  placeNode: (recordId: string, x: number, y: number) => void;
  /** Fold or unfold a branch. */
  toggleCollapsed: (recordId: string, collapsed: boolean) => void;
  /** Create a child node; resolves with the new record id. */
  addChildNode: (parentRecordId: string | null) => Promise<string | null>;
  /** Delete a node, lifting its children to its parent rather than orphaning them. */
  deleteNode: (recordId: string) => void;
  /** Clear manual positions so the tidy-tree layout takes over again. */
  autoLayout: (recordIds: string[]) => void;
}

export default function DatabasePage({
  page,
  database,
  readOnly = false,
  favorite,
}: {
  page: HeaderPage;
  database: DatabaseDTO;
  readOnly?: boolean;
  favorite?: boolean;
}) {
  const router = useRouter();
  const [db, setDb] = useState(database);
  const [views, setViews] = useState<ViewDTO[]>(database.views);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState(database.views[0]?.id ?? "virtual-table");
  const [addingProperty, setAddingProperty] = useState(false);
  const [newPropName, setNewPropName] = useState("");
  const [newPropType, setNewPropType] = useState<PropertyType>("text");
  const [addingView, setAddingView] = useState(false);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  const patch = (url: string, body: unknown) =>
    fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** True while a failed write is waiting for the server's copy to come back. */
  const resyncing = useRef(false);
  /**
   * Armed by the pill's "Try again", disarmed by anything that makes the pill
   * true again. The pill is the only sign this view is diverged, so it is
   * never cleared on the strength of a retry that hasn't landed - only an
   * actual adoption (below) clears it. See the retry handler at the bottom.
   */
  const dismissOnAdopt = useRef(false);
  /** Tracked server writes issued but not yet settled. */
  const pendingWrites = useRef(0);
  /** True once any tracked write settled after the recovery refresh was dispatched. */
  const settledDuringResync = useRef(false);
  /**
   * Brackets our own recovery refreshes so their completion is observable:
   * `refreshPending` is true from the dispatch until the payload of OUR
   * refresh has been applied. The router serializes refreshes, so a payload
   * that lands while it is still true came from an unrelated refresh (a
   * favorite toggle, a title save) dispatched BEFORE resync() ran - rendered
   * before the failure, stale by definition. Without this the adoption effect
   * would adopt that stale payload (its guards only see writes in flight or
   * settled after resync), permanently reverting writes that committed before
   * the failure - and then discard the resync's own fresh payload because
   * `resyncing` had already been cleared.
   */
  const [refreshPending, startRefresh] = useTransition();
  /**
   * The prop identity the adoption effect last saw. A run triggered only by
   * `refreshPending` flipping (a refresh that failed outright delivers no
   * payload) must not be mistaken for an arrival: adopting the old prop would
   * revert every write since the last real payload.
   */
  const lastPayload = useRef(database);

  /**
   * Bracket a server write so the adoption effect below can tell whether a
   * refreshed snapshot is safe to adopt. Every write that can change the
   * server-rendered DatabaseDTO passes through here.
   */
  const track = (req: Promise<Response>) => {
    pendingWrites.current += 1;
    const settle = () => {
      pendingWrites.current -= 1;
      if (resyncing.current) settledDuringResync.current = true;
    };
    return req.then(
      (res) => {
        settle();
        return res;
      },
      (err) => {
        settle();
        throw err;
      }
    );
  };

  /**
   * The failure path the fire-and-forget writes share. Optimistic state the
   * server refused (or never received) is a lie the user would keep building
   * on; the honest recovery is to re-fetch the server's copy and say so. One
   * refresh reconverges everything, so a burst of failures - deleteNode sends
   * one request per lifted child - folds into a single re-fetch.
   */
  const resync = useCallback(() => {
    setSyncError("A change didn't save - this view was reloaded from the server.");
    // A fresh failure re-arms the pill: a dismissal armed by an earlier "Try
    // again" must not carry over and hide this one.
    dismissOnAdopt.current = false;
    if (resyncing.current) return;
    resyncing.current = true;
    settledDuringResync.current = false;
    startRefresh(() => router.refresh());
  }, [router]);

  const { config, update: updateConfig } = useViewConfig(activeView, readOnly, resync);

  /** Route any background write through the shared failure path. */
  const orResync = (req: Promise<Response>) =>
    track(req).then(
      (res) => {
        if (!res.ok) resync();
      },
      () => resync()
    );

  /** A background PATCH whose only follow-up is the shared failure path. */
  const patchOrResync = (url: string, body: unknown) => orResync(patch(url, body));

  // router.refresh() re-runs the server component; the fresh DTO arrives as a
  // new `database` prop, which replaces the diverged optimistic state. Only
  // adopted after a failure - ordinary refreshes (a title save, a favorite
  // toggle) must not clobber edits whose writes are still in flight.
  //
  // Invariant: a snapshot is adopted only when (a) it was produced by our own
  // recovery refresh - `refreshPending` false at arrival; a payload landing
  // while it is still true came from a dispatch that predates resync() and is
  // stale (see the transition note above) - and (b) every tracked write
  // settled BEFORE that refresh was dispatched. A write still in flight, or
  // one that settled after the dispatch, may have committed after the server
  // rendered this snapshot - adopting it would visually revert a write that
  // in fact succeeded (a deleted node would resurrect). Such a snapshot is
  // discarded and one more refresh is dispatched; as soon as the writes go
  // quiet for one full dispatch→arrival window, that window's snapshot is
  // adopted. A pre-resync payload costs nothing extra: our own refresh is
  // already on the way, so the effect just waits for it.
  useEffect(() => {
    const arrived = lastPayload.current !== database;
    lastPayload.current = database;
    if (!resyncing.current) return;
    // A payload arriving before our refresh completed predates its dispatch;
    // ours is still on the way - keep waiting.
    if (refreshPending) return;
    // The transition completed without delivering a payload (the refresh
    // failed outright). The pill stays up - nothing clears it before an
    // adoption - but it must stop claiming a reload that never happened, and
    // the machinery has to be unwedged: leaving `resyncing` true with no
    // refresh in flight makes resync() a no-op for every later failure, and
    // silently swallows the one after that. Try again re-dispatches.
    if (!arrived) {
      resyncing.current = false;
      dismissOnAdopt.current = false;
      setSyncError(
        "A change didn't save, and reloading from the server failed too - " +
          "check your connection, then try again."
      );
      return;
    }
    if (pendingWrites.current > 0 || settledDuringResync.current) {
      settledDuringResync.current = false;
      startRefresh(() => router.refresh());
      return;
    }
    resyncing.current = false;
    setDb(database);
    // Views come from the same snapshot and diverge the same way: a DELETE or
    // rename the server committed but whose response was lost leaves a phantom
    // or stale tab that setDb alone could never repair, so the pill's promise
    // ("reloaded from the server") would be a lie for exactly the case it
    // exists for. Adopting them HERE is safe precisely because of the
    // invariant above: reaching this line means no tracked write is in flight
    // and none settled since this snapshot was requested - and every view
    // write is tracked and confirm-then-apply - so there is no in-flight local
    // view edit to clobber.
    setViews(database.views);
    // The active tab may be the one the server no longer has.
    setActiveViewId((current) =>
      database.views.some((v) => v.id === current)
        ? current
        : database.views[0]?.id ?? "virtual-table"
    );
    if (dismissOnAdopt.current) {
      // The user asked for one more try and got a fresh snapshot: the view now
      // matches the server, so the pill has nothing left to warn about.
      dismissOnAdopt.current = false;
      setSyncError(null);
    }
  }, [database, refreshPending, router]);

  /** Merge a partial update into one record, locally. */
  const patchRecordLocal = (recordId: string, changes: Partial<RecordDTO>) =>
    setDb((prev) => ({
      ...prev,
      records: prev.records.map((r) => (r.id === recordId ? { ...r, ...changes } : r)),
    }));

  /** The server-held position of a node mid-drag: moveNodeLocal is
      optimistic-only, so this - not wherever the cursor happens to be -
      is what a rejected drop must restore. */
  const dragOrigin = useRef(new Map<string, Pick<RecordDTO, "mapX" | "mapY">>());

  const actions: DatabaseActions = {
    renameRecord: (recordId, title) => {
      const record = db.records.find((r) => r.id === recordId);
      // The row is already gone; there is nothing to fail at. Report success
      // so a caller awaiting the write doesn't raise an error nobody can act on.
      if (!record) return Promise.resolve(new Response(null, { status: 204 }));
      patchRecordLocal(recordId, { title });
      const req = patch(`/api/pages/${record.pageId}`, { title });
      // Failures still take the shared resync path whether or not anyone is
      // awaiting; the response is handed back so callers can serialize.
      void orResync(req);
      return req;
    },

    setValue: (recordId, propertyId, value) => {
      setDb((prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === recordId ? { ...r, values: { ...r.values, [propertyId]: value } } : r
        ),
      }));
      patchOrResync(`/api/records/${recordId}/values`, { propertyId, value });
    },

    addOption: async (propertyId, name) => {
      const property = db.properties.find((p) => p.id === propertyId);
      if (!property) return null;
      const options = property.settings.options ?? [];
      const option: SelectOption = {
        id: crypto.randomUUID(),
        name,
        color: OPTION_COLORS[options.length % OPTION_COLORS.length],
      };
      const settings = { ...property.settings, options: [...options, option] };
      setDb((prev) => ({
        ...prev,
        properties: prev.properties.map((p) => (p.id === propertyId ? { ...p, settings } : p)),
      }));
      // The caller only assigns the new option's id to a record when we return
      // it. A refused write must return null instead: the option then exists
      // nowhere server-side, and persisting a value pointing at it would
      // strand the record (the chip renders blank on every other client).
      // resync() reconverges the optimistic option away.
      try {
        const res = await track(patch(`/api/properties/${propertyId}`, { settings }));
        if (!res.ok) {
          resync();
          return null;
        }
      } catch {
        resync();
        return null;
      }
      return option;
    },

    addRecord: async (initial) => {
      await createRecord({ initial });
    },

    trashRecord: (recordId) => {
      const record = db.records.find((r) => r.id === recordId);
      if (!record) return;
      setDb((prev) => ({ ...prev, records: prev.records.filter((r) => r.id !== recordId) }));
      patchOrResync(`/api/pages/${record.pageId}`, { archived: true });
    },

    renameProperty: (propertyId) => {
      const property = db.properties.find((p) => p.id === propertyId);
      const name = window.prompt("Property name", property?.name ?? "");
      if (!name?.trim()) return;
      setDb((prev) => ({
        ...prev,
        properties: prev.properties.map((p) =>
          p.id === propertyId ? { ...p, name: name.trim() } : p
        ),
      }));
      patchOrResync(`/api/properties/${propertyId}`, { name: name.trim() });
    },

    deleteProperty: (propertyId) => {
      if (!confirm("Delete this property and all of its values?")) return;
      setDb((prev) => ({
        ...prev,
        properties: prev.properties.filter((p) => p.id !== propertyId),
      }));
      orResync(fetch(`/api/properties/${propertyId}`, { method: "DELETE" }));
    },

    moveRecord: (recordId, between) => {
      // The server computes the midpoint and tells us the resulting sortOrder,
      // so two people dragging at once converge instead of fighting. That also
      // means the response IS the write's only visible effect: without it the
      // dropped card keeps the order it had, which is a different order from
      // the one the server now holds. So this takes the same failure path as
      // every other tracked write rather than swallowing the outcome - a
      // refused move needs saying, and a dropped connection leaves the outcome
      // unknown, which only the server can settle.
      track(patch(`/api/records/${recordId}`, { between })).then(async (res) => {
        if (!res.ok) {
          resync();
          return;
        }
        const data = await res.json().catch(() => null);
        if (data?.record) patchRecordLocal(recordId, { sortOrder: data.record.sortOrder });
        // Committed, but we can't read where it landed - re-fetch rather than
        // render an order we know may not be the server's.
        else resync();
      }, resync);
    },

    reparentRecord: (recordId, parentRecordId) => {
      const previous = db.records.find((r) => r.id === recordId);
      // `previous` already holds the cursor's last drag position; the position
      // the server still holds is the one captured when the drag began.
      const origin = dragOrigin.current.get(recordId);
      dragOrigin.current.delete(recordId);
      // Clearing the manual position lets the branch tidy into its new home.
      patchRecordLocal(recordId, { parentRecordId, mapX: null, mapY: null });
      track(patch(`/api/records/${recordId}`, { parentRecordId, mapX: null, mapY: null })).then(
        async (res) => {
          if (res.ok || !previous) return;
          // A rejected reparent (a cycle) must not leave the canvas lying:
          // restore what the server holds, not where the cursor let go.
          patchRecordLocal(recordId, {
            parentRecordId: previous.parentRecordId,
            mapX: origin ? origin.mapX : previous.mapX,
            mapY: origin ? origin.mapY : previous.mapY,
          });
          const data = await res.json().catch(() => ({}));
          if (data?.error) alert(data.error);
        },
        // A dropped connection leaves the outcome unknown - only the server
        // can say whether the reparent landed.
        () => resync()
      );
    },

    moveNodeLocal: (recordId, x, y) => {
      // First movement of a drag: remember the position the server holds, so
      // a rejected drop can restore it (see reparentRecord).
      if (!dragOrigin.current.has(recordId)) {
        const record = db.records.find((r) => r.id === recordId);
        if (record) dragOrigin.current.set(recordId, { mapX: record.mapX, mapY: record.mapY });
      }
      patchRecordLocal(recordId, { mapX: x, mapY: y });
    },

    placeNode: (recordId, x, y) => {
      dragOrigin.current.delete(recordId); // this drag ends by persisting
      patchRecordLocal(recordId, { mapX: x, mapY: y });
      patchOrResync(`/api/records/${recordId}`, { mapX: x, mapY: y });
    },

    toggleCollapsed: (recordId, collapsed) => {
      patchRecordLocal(recordId, { collapsed });
      patchOrResync(`/api/records/${recordId}`, { collapsed });
    },

    addChildNode: async (parentRecordId) => {
      const record = await createRecord({ parentRecordId, title: "" });
      return record?.id ?? null;
    },

    deleteNode: (recordId) => {
      const record = db.records.find((r) => r.id === recordId);
      if (!record) return;
      // Lift children to the deleted node's parent so a branch is never lost by
      // accident - the record itself goes to the trash, where it can come back.
      const children = db.records.filter((r) => r.parentRecordId === recordId);
      setDb((prev) => ({
        ...prev,
        records: prev.records
          .filter((r) => r.id !== recordId)
          .map((r) =>
            r.parentRecordId === recordId ? { ...r, parentRecordId: record.parentRecordId } : r
          ),
      }));
      for (const child of children) {
        patchOrResync(`/api/records/${child.id}`, { parentRecordId: record.parentRecordId });
      }
      patchOrResync(`/api/pages/${record.pageId}`, { archived: true });
    },

    autoLayout: (recordIds) => {
      setDb((prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          recordIds.includes(r.id) ? { ...r, mapX: null, mapY: null } : r
        ),
      }));
      for (const id of recordIds) patchOrResync(`/api/records/${id}`, { mapX: null, mapY: null });
    },
  };

  /** Shared record creation for "+ New", board columns and mind-map children. */
  async function createRecord(opts: {
    initial?: { propertyId: string; value: unknown };
    parentRecordId?: string | null;
    title?: string;
  }): Promise<RecordDTO | null> {
    // A refused or lost create must surface like every other failed write:
    // callers fire-and-forget ("+ New", Tab in the mind map), so a bare
    // rejection would be an unhandled promise with zero feedback, and a
    // dropped connection leaves the outcome unknown - only the server can say
    // whether the record landed. The shared failure path covers both.
    let data;
    try {
      const res = await track(
        fetch(`/api/databases/${db.id}/records`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: opts.title ?? "",
            parentRecordId: opts.parentRecordId ?? null,
          }),
        })
      );
      if (!res.ok) {
        resync();
        return null;
      }
      data = await res.json();
    } catch {
      resync();
      return null;
    }
    if (opts.initial) {
      // The record itself landed; a refused initial value must not survive as
      // a lie in the row we're about to show - the shared failure path
      // re-fetches the server's copy (record present, value absent).
      await orResync(patch(`/api/records/${data.record.id}/values`, opts.initial));
    }
    const now = new Date().toISOString();
    const record: RecordDTO = {
      id: data.record.id,
      pageId: data.record.pageId,
      title: opts.title ?? "",
      icon: null,
      sortOrder: data.record.sortOrder ?? (db.records[db.records.length - 1]?.sortOrder ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
      values: opts.initial ? { [opts.initial.propertyId]: opts.initial.value } : {},
      parentRecordId: data.record.parentRecordId ?? null,
      mapX: data.record.mapX ?? null,
      mapY: data.record.mapY ?? null,
      collapsed: false,
    };
    setDb((prev) => ({ ...prev, records: [...prev.records, record] }));
    return record;
  }

  const addProperty = async () => {
    const name = newPropName.trim() || "New property";
    // Tracked like every other DTO write: an untracked POST is invisible to
    // the adoption effect, so a concurrent resync could adopt a snapshot
    // rendered before this property existed and visually revert it.
    let data;
    try {
      const res = await track(
        fetch(`/api/databases/${db.id}/properties`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type: newPropType }),
        })
      );
      if (!res.ok) {
        resync();
        return;
      }
      data = await res.json();
    } catch {
      resync();
      return;
    }
    setDb((prev) => ({
      ...prev,
      properties: [
        ...prev.properties,
        {
          id: data.property.id,
          name,
          type: newPropType,
          settings: data.property.settings ?? { options: [] },
          sortOrder: (prev.properties[prev.properties.length - 1]?.sortOrder ?? 0) + 1,
        },
      ],
    }));
    setAddingProperty(false);
    setNewPropName("");
    setNewPropType("text");
  };

  /* View writes are tracked too - views are part of the server-rendered DTO -
     and confirm-then-apply rather than optimistic, so a refused view change
     never reaches the screen in the first place. The case that needs the
     adoption effect is the other one: a request the server committed whose
     response was lost. That rejects here like a refusal, so these all resync,
     and the adoption effect replaces `views` from the fresh snapshot. Failures
     surface through the shared pill. */

  const addView = async (type: ViewType) => {
    setAddingView(false);
    const label = VIEW_TYPES.find((v) => v.type === type)?.label ?? type;
    let view: ViewDTO;
    try {
      const res = await track(
        fetch(`/api/databases/${db.id}/views`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, name: label }),
        })
      );
      if (!res.ok) {
        resync();
        return;
      }
      ({ view } = await res.json());
    } catch {
      resync();
      return;
    }
    setViews((prev) => [...prev, view]);
    setActiveViewId(view.id);
  };

  const removeView = async (viewId: string) => {
    if (views.length <= 1) return;
    if (!confirm("Delete this view? The records stay - only this way of looking at them goes.")) {
      return;
    }
    try {
      const res = await track(fetch(`/api/views/${viewId}`, { method: "DELETE" }));
      if (!res.ok) {
        resync();
        return;
      }
    } catch {
      resync();
      return;
    }
    const remaining = views.filter((v) => v.id !== viewId);
    setViews(remaining);
    if (activeViewId === viewId) setActiveViewId(remaining[0]?.id ?? "");
  };

  const renameView = async (view: ViewDTO) => {
    const name = window.prompt("View name", view.name);
    if (!name?.trim()) return;
    const applyName = (n: string) =>
      setViews((prev) => prev.map((v) => (v.id === view.id ? { ...v, name: n } : v)));
    if (view.id.startsWith("virtual-")) {
      // The fallback set lives only in memory - nothing server-side to update.
      applyName(name.trim());
      return;
    }
    try {
      const res = await track(patch(`/api/views/${view.id}`, { name: name.trim() }));
      if (!res.ok) {
        resync();
        return;
      }
      // The server's copy is canonical (it truncates to MAX_NAME).
      const data = await res.json();
      applyName(typeof data?.view?.name === "string" ? data.view.name : name.trim());
    } catch {
      resync();
      return;
    }
  };

  /**
   * Filter and sort for the flat views.
   *
   * The mind map deliberately doesn't use this: hiding a parent would sever the
   * branch below it, so the map always shows the whole tree and uses the filter
   * to highlight instead.
   */
  const visibleRecords = useMemo(() => {
    let records = db.records;
    const q = (config.filter ?? "").trim().toLowerCase();
    if (q) {
      records = records.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          db.properties.some((p) => valueToText(r.values[p.id], p).toLowerCase().includes(q))
      );
    }
    const sortKey = config.sortPropertyId;
    if (sortKey) {
      const property = db.properties.find((p) => p.id === sortKey);
      const dir = config.sortDir === "desc" ? -1 : 1;
      records = [...records].sort((a, b) => {
        let cmp: number;
        if (!property) {
          cmp = a.title.localeCompare(b.title);
        } else if (property.type === "number" || property.type === "progress") {
          cmp = (Number(a.values[sortKey]) || 0) - (Number(b.values[sortKey]) || 0);
        } else if (property.type === "checkbox") {
          cmp = Number(Boolean(a.values[sortKey])) - Number(Boolean(b.values[sortKey]));
        } else {
          cmp = valueToText(a.values[sortKey], property).localeCompare(
            valueToText(b.values[sortKey], property)
          );
        }
        return cmp * dir;
      });
    } else {
      records = [...records].sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return records;
  }, [db, config.filter, config.sortPropertyId, config.sortDir]);

  const viewType: ViewType = activeView?.type ?? "table";

  return (
    <div className={`${viewType === "mindmap" ? "max-w-none" : "max-w-5xl"} mx-auto px-8 py-8`}>
      <PageHeader
        page={page}
        exportHref={`/api/databases/${db.id}/export`}
        exportLabel="CSV"
        placeholder="Untitled database"
        readOnly={readOnly}
        favorite={favorite}
      />

      {/* ---- View tabs ---- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-2 mb-4 text-sm">
        <div className="flex flex-wrap gap-1">
          {views.map((v) => {
            const meta = VIEW_TYPES.find((t) => t.type === v.type);
            const active = v.id === activeViewId;
            return (
              <span key={v.id} className="group flex items-center">
                <button
                  onClick={() => setActiveViewId(v.id)}
                  onDoubleClick={() => !readOnly && renameView(v)}
                  title={readOnly ? undefined : "Double-click to rename"}
                  className={`rounded px-2 py-1 ${
                    active ? "bg-[var(--hover)] font-medium" : "text-[var(--muted)] hover:bg-[var(--hover)]"
                  }`}
                >
                  <span className="mr-1 text-[var(--faint)]">{meta?.icon}</span>
                  {v.name}
                </button>
                {active && !readOnly && views.length > 1 && !v.id.startsWith("virtual-") && (
                  <button
                    onClick={() => removeView(v.id)}
                    title="Delete this view"
                    className="ml-0.5 px-1 text-xs text-[var(--faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger)]"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {!readOnly && (
            <span className="relative">
              <button
                onClick={() => setAddingView((v) => !v)}
                className="rounded px-2 py-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
                title="Add a view"
              >
                +
              </button>
              {addingView && (
                <span className="absolute left-0 top-full z-20 mt-1 flex w-40 flex-col rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-1 shadow-lg">
                  {VIEW_TYPES.map((t) => (
                    <button
                      key={t.type}
                      onClick={() => addView(t.type)}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--hover)]"
                    >
                      <span className="text-[var(--faint)]">{t.icon}</span>
                      {t.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={config.filter ?? ""}
            onChange={(e) => updateConfig({ filter: e.target.value })}
            placeholder="Filter…"
            className="rounded border border-[var(--border)] px-2 py-1 text-sm w-36 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          {viewType !== "mindmap" && (
            <>
              <select
                value={config.sortPropertyId ?? ""}
                onChange={(e) => updateConfig({ sortPropertyId: e.target.value || null })}
                className="rounded border border-[var(--border)] px-2 py-1 text-sm bg-[var(--elevated)]"
              >
                <option value="">Manual order</option>
                <option value="__title__">Name</option>
                {db.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {config.sortPropertyId && (
                <button
                  onClick={() =>
                    updateConfig({ sortDir: config.sortDir === "desc" ? "asc" : "desc" })
                  }
                  className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                  title="Toggle sort direction"
                >
                  {config.sortDir === "desc" ? "↓" : "↑"}
                </button>
              )}
            </>
          )}
          {!readOnly && (
            <>
              <button
                onClick={() => setAddingProperty((v) => !v)}
                className="rounded border border-[var(--border)] px-2 py-1 text-sm hover:bg-[var(--hover)]"
              >
                + Property
              </button>
              <button
                onClick={() => actions.addRecord()}
                className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-3 py-1 text-sm hover:bg-[var(--btn-hover)]"
              >
                + New
              </button>
            </>
          )}
        </div>
      </div>

      {addingProperty && (
        <div className="mb-4 flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm">
          <input
            autoFocus
            value={newPropName}
            onChange={(e) => setNewPropName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProperty()}
            placeholder="Property name"
            className="rounded border border-[var(--border)] px-2 py-1 focus:outline-none"
          />
          <select
            value={newPropType}
            onChange={(e) => setNewPropType(e.target.value as PropertyType)}
            className="rounded border border-[var(--border)] px-2 py-1 bg-[var(--elevated)]"
          >
            {PROPERTY_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <button onClick={addProperty} className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-3 py-1">
            Add
          </button>
          <button onClick={() => setAddingProperty(false)} className="text-[var(--muted)]">
            Cancel
          </button>
        </div>
      )}

      {/* fieldset[disabled] makes every input and button inside inert for viewers */}
      <fieldset disabled={readOnly} className="min-w-0">
        {viewType === "table" && (
          <TableView properties={db.properties} records={visibleRecords} actions={actions} />
        )}
        {viewType === "list" && (
          <ListView properties={db.properties} records={visibleRecords} actions={actions} />
        )}
        {viewType === "board" && (
          <BoardView
            properties={db.properties}
            records={visibleRecords}
            actions={actions}
            config={config}
            updateConfig={updateConfig}
            readOnly={readOnly}
          />
        )}
        {viewType === "timeline" && (
          <TimelineView
            properties={db.properties}
            records={visibleRecords}
            actions={actions}
            config={config}
            updateConfig={updateConfig}
            readOnly={readOnly}
          />
        )}
        {viewType === "mindmap" && (
          <MindMapView
            properties={db.properties}
            records={db.records}
            actions={actions}
            config={config}
            updateConfig={updateConfig}
            readOnly={readOnly}
          />
        )}
      </fieldset>

      {/* Only surfaced on failure, like the title's indicator - the pill stays
          up after the resync so the user knows that change is gone. Try again
          re-fetches the server's copy once more, and the pill comes down only
          when that fetch demonstrably lands (the adoption effect clears it).
          Clearing it here instead would silence the pill on exactly the
          failure it exists for: retrying while still offline would leave the
          diverged view on screen with nothing to say so. */}
      {syncError && (
        <SaveIndicator
          state="error"
          error={syncError}
          onRetry={() => {
            dismissOnAdopt.current = true;
            if (resyncing.current) return; // one is already on the way
            resyncing.current = true;
            settledDuringResync.current = false;
            startRefresh(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
