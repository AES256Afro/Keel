"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SaveIndicator from "@/components/SaveIndicator";
import PageShareButton from "@/components/PageShareButton";
import { useAutosave } from "@/lib/useAutosave";

const EMOJIS = [
  "📄", "📌", "📝", "📚", "📁", "🗂️", "✅", "📆", "🎯", "🚀",
  "💡", "🔥", "⭐", "🧠", "🛠️", "🐛", "🏠", "💼", "🧭", "❤️",
  "🍀", "🌊", "🌸", "☕", "🎨", "🎵", "🏃", "✈️", "💰", "🔒",
];

export interface HeaderPage {
  id: string;
  title: string;
  icon: string | null;
  archived: boolean;
}

export default function PageHeader({
  stats,
  onEnterFocus,
  onSplit,
  readHref,
  page,
  exportHref,
  exportLabel,
  placeholder = "Untitled",
  canDuplicate = true,
  readOnly = false,
  favorite,
  canShare = false,
  onTitleChange,
}: {
  page: HeaderPage;
  exportHref?: string;
  exportLabel?: string;
  placeholder?: string;
  canDuplicate?: boolean;
  readOnly?: boolean;
  /** Initial favorite state; the star toggle renders only when provided. */
  favorite?: boolean;
  /** Workspace owners may create a revocable read-only link for active documents. */
  canShare?: boolean;
  onTitleChange?: (title: string) => void;
  /** Live word count, shown next to the page actions. */
  stats?: { words: number; readingMinutes: number };
  /** Provided when focus mode is available (omitted for read-only viewers). */
  onEnterFocus?: () => void;
  /** Provided when this page can open a second document beside it. */
  onSplit?: () => void;
  /** Sequence-reading view for this page and its subtree. */
  readHref?: string;
}) {
  const router = useRouter();
  const [icon, setIcon] = useState(page.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [starred, setStarred] = useState(favorite ?? false);

  /**
   * The page actions below all write to the server and then act as though it
   * agreed - the star flips, the icon changes, trashing navigates home. A
   * refused or lost request therefore has to be undone AND said out loud, or
   * the header keeps showing a state the server never recorded (and, for the
   * star, keeps showing it: `starred` is seeded from the prop once and a
   * router.refresh() cannot correct it). Same contract as the title autosave
   * beneath: report the failure, offer the whole action again.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const retryAction = useRef<() => void>(() => {});

  /** Did the write land? Never throws - a rejection is just a failure. */
  const landed = async (request: Promise<Response>) => {
    try {
      return (await request).ok;
    } catch {
      return false;
    }
  };

  const actionFailed = (message: string, retry: () => void) => {
    retryAction.current = retry;
    setActionError(message);
  };

  const toggleFavorite = async (on: boolean) => {
    setStarred(on);
    const ok = await landed(
      fetch(`/api/pages/${page.id}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on }),
      })
    );
    if (!ok) {
      // The star must not keep claiming something the server didn't record.
      setStarred(!on);
      actionFailed(
        on ? "Couldn't add this page to favorites." : "Couldn't remove this page from favorites.",
        () => void toggleFavorite(on)
      );
      return;
    }
    setActionError(null);
    router.refresh();
  };

  // A silently lost title is the same class of bug as a silently lost body:
  // the header autosaves through the same reporting path.
  const saveTitleRequest = useCallback(
    (title: string) =>
      fetch(`/api/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((res) => {
        // Refresh the sidebar/tree only once the title actually landed.
        if (res.ok) router.refresh();
        return res;
      }),
    [page.id, router]
  );
  const {
    state: titleState,
    error: titleError,
    schedule: saveTitle,
    retry: retryTitle,
  } = useAutosave(saveTitleRequest, { delay: 500 });

  const saveIcon = async (value: string | null) => {
    const previous = icon;
    setIcon(value);
    setPickerOpen(false);
    const ok = await landed(
      fetch(`/api/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon: value }),
      })
    );
    if (!ok) {
      setIcon(previous);
      actionFailed("Couldn't change this page's icon.", () => void saveIcon(value));
      return;
    }
    setActionError(null);
    router.refresh();
  };

  const setArchived = async (archived: boolean) => {
    const ok = await landed(
      fetch(`/api/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      })
    );
    if (!ok) {
      actionFailed(
        archived ? "Couldn't move this page to the trash." : "Couldn't restore this page.",
        () => void setArchived(archived)
      );
      return;
    }
    setActionError(null);
    // Only leave the page once the server agrees it's in the trash - walking
    // away from a failed PATCH is how a page looks deleted and isn't.
    if (archived) router.push("/");
    router.refresh();
  };

  const duplicate = async () => {
    let data;
    try {
      const res = await fetch(`/api/pages/${page.id}/duplicate`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch {
      actionFailed("Couldn't duplicate this page.", () => void duplicate());
      return;
    }
    setActionError(null);
    router.push(`/p/${data.pageId}`);
    router.refresh();
  };

  const deleteForever = async () => {
    if (!confirm("Delete this page permanently? This cannot be undone.")) return;
    const ok = await landed(fetch(`/api/pages/${page.id}`, { method: "DELETE" }));
    if (!ok) {
      actionFailed("Couldn't delete this page.", () => void deleteForever());
      return;
    }
    setActionError(null);
    router.push("/");
    router.refresh();
  };

  return (
    <header className="mb-4">
      {page.archived && (
        <div className="mb-4 flex items-center gap-3 rounded border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2 text-sm text-[var(--danger)]">
          This page is in the trash.
          {!readOnly && (
            <>
              <button onClick={() => setArchived(false)} className="font-medium underline">
                Restore
              </button>
              <button onClick={deleteForever} className="font-medium underline">
                Delete forever
              </button>
            </>
          )}
        </div>
      )}
      <div className="keel-page-actions flex flex-wrap items-center justify-end gap-3 text-sm text-[var(--muted)] mb-6">
        {stats !== undefined && stats.words > 0 && (
          <span
            className="mr-auto text-xs tabular-nums text-[var(--faint)]"
            title={`${stats.words.toLocaleString()} words · about ${stats.readingMinutes} min to read`}
          >
            {stats.words.toLocaleString()} words · {stats.readingMinutes} min
          </span>
        )}
        {onEnterFocus && (
          <button
            onClick={onEnterFocus}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title="Focus mode (⌘⇧F)"
          >
            ◎ Focus
          </button>
        )}
        {onSplit && (
          <button
            onClick={onSplit}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title="Open another document beside this one"
          >
            ◫ Side by side
          </button>
        )}
        {readHref && (
          <a
            href={readHref}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title="Read this page and everything under it as one scroll"
          >
            📖 Read
          </a>
        )}
        {canShare && <PageShareButton pageId={page.id} />}
        {favorite !== undefined && (
          <button
            onClick={() => void toggleFavorite(!starred)}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title={starred ? "Remove from favorites" : "Add to favorites"}
          >
            {starred ? "★ Favorited" : "☆ Favorite"}
          </button>
        )}
        {exportHref && (
          <a href={exportHref} className="rounded px-2 py-1 hover:bg-[var(--hover)]" title="Export">
            ⬇ {exportLabel ?? "Export"}
          </a>
        )}
        {canDuplicate && !page.archived && !readOnly && (
          <button
            onClick={duplicate}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title="Duplicate page"
          >
            ⧉ Duplicate
          </button>
        )}
        {!page.archived && !readOnly && (
          <button
            onClick={() => setArchived(true)}
            className="rounded px-2 py-1 hover:bg-[var(--hover)]"
            title="Move to trash"
          >
            🗑 Trash
          </button>
        )}
      </div>
      <div className="relative">
        <button
          onClick={() => !readOnly && setPickerOpen((v) => !v)}
          className="text-5xl leading-none mb-3 hover:bg-[var(--hover)] rounded p-1"
          title={readOnly ? undefined : "Change icon"}
        >
          {icon ?? "📄"}
        </button>
        {pickerOpen && (
          <div className="absolute z-40 top-16 left-0 w-72 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl p-3">
            <div className="grid grid-cols-10 gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => saveIcon(e)}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--hover)]"
                >
                  {e}
                </button>
              ))}
            </div>
            <button
              onClick={() => saveIcon(null)}
              className="mt-2 text-xs text-[var(--muted)] hover:underline"
            >
              Remove icon
            </button>
          </div>
        )}
      </div>
      <input
        defaultValue={page.title}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => {
          if (readOnly) return;
          onTitleChange?.(e.target.value);
          saveTitle(e.target.value);
        }}
        className="w-full text-4xl font-bold focus:outline-none placeholder:text-[var(--faint)] bg-transparent"
      />
      {/* Only surfaced on failure - the body editor owns the ambient
          "Saving…/Saved" indicator, and two of them would be noise. */}
      {titleState === "error" && (
        // Slot 1: the page below may be showing its own pill (content
        // autosave or a sync error) in slot 0 at the same moment.
        <SaveIndicator state={titleState} error={titleError} onRetry={retryTitle} slot={1} />
      )}
      {/* Slot 2: above the title's pill, since both can be up at once. Not
          cleared when Try again is pressed - only the action's own outcome
          clears it, so a retry that fails again leaves the warning standing. */}
      {actionError && (
        <SaveIndicator
          state="error"
          error={actionError}
          onRetry={() => retryAction.current()}
          slot={2}
          label="Action failed"
        />
      )}
    </header>
  );
}
