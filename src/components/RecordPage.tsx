"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Editor from "@/components/Editor";
import PageHeader, { type HeaderPage } from "@/components/PageHeader";
import PropertyValueCell from "@/components/database/PropertyValueCell";
import SaveIndicator from "@/components/SaveIndicator";
import { useAutosave } from "@/lib/useAutosave";
import { OPTION_COLORS, type DatabaseDTO, type SelectOption } from "@/lib/types";

export default function RecordPage({
  page,
  recordId,
  database,
  recordValues,
  databasePage,
  readOnly = false,
  favorite,
}: {
  page: HeaderPage & { content: string | null };
  recordId: string;
  /** Schema only - properties and views. Sibling records are not loaded: this
   *  page renders one row, and pulling the whole database to find it made
   *  opening a task cost megabytes. */
  database: Omit<DatabaseDTO, "records">;
  /** This record's property values, fetched on their own. */
  recordValues: Record<string, unknown>;
  databasePage: { id: string; title: string; icon: string | null };
  readOnly?: boolean;
  favorite?: boolean;
}) {
  const router = useRouter();
  const [properties, setProperties] = useState(database.properties);
  const [values, setValues] = useState<Record<string, unknown>>(recordValues);
  const [syncError, setSyncError] = useState<string | null>(null);
  const save = useCallback(
    (content: string) =>
      fetch(`/api/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    [page.id]
  );
  const { state, error, schedule, retry } = useAutosave(save);

  // The same recovery contract as DatabasePage, in miniature: a refused or
  // lost write re-fetches the server's copy rather than leaving optimistic
  // state the user would keep building on. See DatabasePage for the adoption
  // invariant; this page has only two writers, but the rules are identical.
  const resyncing = useRef(false);
  const pendingWrites = useRef(0);
  const settledDuringResync = useRef(false);
  // Brackets our own recovery refreshes so the adoption effect can tell them
  // from unrelated ones already in flight when resync() ran - see the
  // matching transition note in DatabasePage.
  const [refreshPending, startRefresh] = useTransition();
  // The payload identity the adoption effect last saw; a `refreshPending`
  // flip without a fresh payload (the refresh failed) is not an arrival.
  const lastPayload = useRef(recordValues);
  // Armed only by "Try again": the pill is dismissed when an adoption really
  // completes, never merely because the button was pressed.
  const dismissOnAdopt = useRef(false);

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

  const resync = () => {
    setSyncError("A change didn't save - this page was reloaded from the server.");
    dismissOnAdopt.current = false;
    if (resyncing.current) return;
    resyncing.current = true;
    settledDuringResync.current = false;
    startRefresh(() => router.refresh());
  };

  const orResync = (req: Promise<Response>) =>
    track(req).then(
      (res) => {
        if (!res.ok) resync();
        return res;
      },
      () => {
        resync();
        return null;
      }
    );

  // Adopt the server's copy only after a failure, and only once (a) the
  // payload came from our own recovery refresh - while `refreshPending` is
  // true, an arriving payload was rendered by a dispatch that predates
  // resync() and is stale - and (b) every tracked write settled before that
  // refresh was dispatched. Same invariant as DatabasePage's effect, so a
  // write that succeeded mid-resync is never visually reverted.
  useEffect(() => {
    const arrived = lastPayload.current !== recordValues;
    lastPayload.current = recordValues;
    if (!resyncing.current) return;
    if (refreshPending) return; // ours is still on the way
    if (!arrived) {
      // The refresh landed but delivered nothing - it failed. Stand down so a
      // later failure can dispatch again (leaving resyncing armed with no
      // refresh in flight would make resync() a permanent no-op), and say what
      // actually happened rather than claiming a reload that did not occur.
      resyncing.current = false;
      setSyncError(
        "A change didn't save, and reloading from the server failed too - check your connection, then try again."
      );
      return;
    }
    if (pendingWrites.current > 0 || settledDuringResync.current) {
      settledDuringResync.current = false;
      startRefresh(() => router.refresh());
      return;
    }
    resyncing.current = false;
    setProperties(database.properties);
    setValues(recordValues);
    // Only an adoption that actually happened may dismiss the pill, and only
    // when the user asked for it - otherwise the indicator beneath would flip
    // to "Saved" over values the server refused.
    if (dismissOnAdopt.current) {
      dismissOnAdopt.current = false;
      setSyncError(null);
    }
  }, [database.properties, recordValues, refreshPending, router]);

  const setValue = (propertyId: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [propertyId]: value }));
    void orResync(
      fetch(`/api/records/${recordId}/values`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId, value }),
      })
    );
  };

  const addOption = async (propertyId: string, name: string): Promise<SelectOption | null> => {
    const property = properties.find((p) => p.id === propertyId);
    if (!property) return null;
    const options = property.settings.options ?? [];
    const option: SelectOption = {
      id: crypto.randomUUID(),
      name,
      color: OPTION_COLORS[options.length % OPTION_COLORS.length],
    };
    const settings = { ...property.settings, options: [...options, option] };
    setProperties((prev) =>
      prev.map((p) => (p.id === propertyId ? { ...p, settings } : p))
    );
    const res = await orResync(
      fetch(`/api/properties/${propertyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })
    );
    // A refused option must not hand its id to the follow-up value write -
    // the caller skips onChange on null, and resync reconverges the phantom.
    if (!res || !res.ok) return null;
    return option;
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <nav className="text-sm text-[var(--muted)] mb-2">
        <Link href={`/p/${databasePage.id}`} className="hover:underline">
          {databasePage.icon ?? "🗂️"} {databasePage.title}
        </Link>
        <span className="mx-1">/</span>
        <span>{page.title || "Untitled"}</span>
      </nav>

      <PageHeader
        page={page}
        exportHref={`/api/pages/${page.id}/export`}
        exportLabel="Markdown"
        canDuplicate={false}
        readOnly={readOnly}
        favorite={favorite}
      />

      <fieldset
        disabled={readOnly}
        className="mb-6 rounded-lg border border-[var(--border)] divide-y divide-[var(--border-soft)]"
      >
        {properties.map((p) => (
          <div key={p.id} className="flex items-center gap-4 px-4 py-2">
            <span className="w-36 shrink-0 text-sm text-[var(--muted)] truncate">{p.name}</span>
            <div className="flex-1 min-w-0">
              <PropertyValueCell
                property={p}
                value={values[p.id]}
                onChange={(v) => setValue(p.id, v)}
                onAddOption={(name) => addOption(p.id, name)}
              />
            </div>
          </div>
        ))}
        {properties.length === 0 && (
          <p className="px-4 py-3 text-sm text-[var(--faint)]">
            No properties yet. Add them from the database page.
          </p>
        )}
      </fieldset>

      <Editor
        content={page.content}
        editable={!page.archived && !readOnly}
        onChange={schedule}
        pageId={page.id}
      />
      {/* One pill at a time - every SaveIndicator renders at the same fixed
          spot, so two error pills would superimpose and hide each other's
          Try again. The sync error wins while present; the autosave pill
          (and its own retry) comes back once it is dismissed or resolved. */}
      {!readOnly && !syncError && <SaveIndicator state={state} error={error} onRetry={retry} />}
      {syncError && (
        <SaveIndicator
          state="error"
          error={syncError}
          onRetry={() => {
            dismissOnAdopt.current = true;
            if (resyncing.current) return; // a refresh is already on its way
            resyncing.current = true;
            // Cleared only on the path that actually dispatches a refresh -
            // the flag means "a tracked write settled after the refresh now in
            // flight was dispatched", so clearing it without dispatching a new
            // one tells the effect that the OLD payload (rendered before that
            // write committed) is safe to adopt. It isn't: adopting it reverts
            // the committed write on screen and, with dismissOnAdopt armed
            // above, takes the pill down with it. Same order as DatabasePage.
            settledDuringResync.current = false;
            startRefresh(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
