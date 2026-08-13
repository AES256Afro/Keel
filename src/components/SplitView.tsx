"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Editor from "@/components/Editor";
import SaveIndicator from "@/components/SaveIndicator";
import { useAutosave } from "@/lib/useAutosave";

export interface SplitPane {
  id: string;
  title: string;
  icon: string | null;
  content: string | null;
  archived: boolean;
  /* Per pane, never shared: read-only is a property of the DOCUMENT (a OneNote
   * mirror is owned by OneNote), not only of the viewer's role. One flag for
   * both panes let a mirror opened beside an ordinary page be edited, and the
   * next sync overwrote those edits. */
  readOnly: boolean;
}

/* localStorage as an external store, the same pattern as FocusMode: the server
 * knows nothing about the saved ratio, so reading it during render would make
 * hydration disagree with the first client render. useSyncExternalStore gives
 * the server snapshot explicitly and swaps in the real value cleanly. */
const RATIO_KEY = "keel:split-ratio";
const DEFAULT_RATIO = 0.5;

function readRatio(): number {
  const raw = window.localStorage.getItem(RATIO_KEY);
  const n = raw === null ? NaN : Number(raw);
  // Clamp hard: a corrupted value must not produce a 0-width pane, which would
  // look exactly like the split feature being broken.
  return Number.isFinite(n) ? Math.min(0.8, Math.max(0.2, n)) : DEFAULT_RATIO;
}

let ratioListeners: (() => void)[] = [];
function subscribeRatio(cb: () => void) {
  ratioListeners.push(cb);
  return () => {
    ratioListeners = ratioListeners.filter((l) => l !== cb);
  };
}
function writeRatio(value: number) {
  window.localStorage.setItem(RATIO_KEY, String(value));
  for (const l of ratioListeners) l();
}

/**
 * One editing pane. Each pane owns its autosave completely - two documents
 * being edited at once are two independent failure domains, and a save error
 * in one must not be silenced by a success in the other.
 */
function Pane({
  page,
  side,
  onSwap,
  onClose,
}: {
  page: SplitPane;
  side: "left" | "right";
  onSwap: () => void;
  onClose: () => void;
}) {
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

  return (
    <section
      className="flex h-full min-w-0 flex-1 flex-col"
      data-split-pane={side}
      aria-label={`${page.title || "Untitled"} (${side} pane)`}
    >
      <header className="flex items-center gap-2 border-b border-[var(--border-soft)] px-4 py-2 text-sm">
        <Link
          href={`/p/${page.id}`}
          className="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
          title="Open on its own"
        >
          <span>{page.icon ?? "📄"}</span>
          <span className="truncate">{page.title || "Untitled"}</span>
        </Link>
        {page.readOnly && !page.archived && (
          <span className="shrink-0 rounded bg-[var(--hover)] px-1.5 text-xs text-[var(--muted)]">
            read-only
          </span>
        )}
        {page.archived && (
          <span className="shrink-0 rounded bg-[var(--danger-bg)] px-1.5 text-xs text-[var(--danger)]">
            in trash
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[var(--muted)]">
          {/* Two panes, two possible pills - the right pane stacks above so
              neither error hides the other's Try again. */}
          <SaveIndicator state={state} error={error} onRetry={retry} slot={side === "right" ? 1 : 0} />
          <button
            onClick={onSwap}
            className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
            title="Swap sides"
          >
            ⇄
          </button>
          <button
            onClick={onClose}
            className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
            title="Close this pane"
          >
            ✕
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Editor
          content={page.content}
          editable={!page.archived && !page.readOnly}
          onChange={schedule}
          pageId={page.id}
        />
      </div>
    </section>
  );
}

/**
 * Two documents side by side - Lattics calls this "bi-article comparison".
 *
 * The split is a URL (`/p/A?with=B`), not client state: it survives reload,
 * the back button undoes it, and a colleague can be sent the exact pair. The
 * server validates `with` (same workspace, a document, not the same page) and
 * decides each pane's own read-only flag, so by the time this component
 * renders both panes are known-good.
 */
export default function SplitView({ left, right }: { left: SplitPane; right: SplitPane }) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const ratio = useSyncExternalStore(subscribeRatio, readRatio, () => DEFAULT_RATIO);
  const [dragging, setDragging] = useState(false);

  const swap = () => router.push(`/p/${right.id}?with=${left.id}`);
  // Closing a pane keeps the *other* one, which is what "close" means from
  // inside that pane. Both end up at a plain single-page URL.
  const closeLeft = () => router.push(`/p/${right.id}`);
  const closeRight = () => router.push(`/p/${left.id}`);

  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    writeRatio(Math.min(0.8, Math.max(0.2, (e.clientX - rect.left) / rect.width)));
  };
  const onDividerUp = (e: React.PointerEvent) => {
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (e.g. pointercancel); nothing to release.
    }
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      <div style={{ flexBasis: `${ratio * 100}%` }} className="flex min-w-0 shrink-0 grow-0">
        <Pane page={left} side="left" onSwap={swap} onClose={closeLeft} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
        className={`w-1 shrink-0 cursor-col-resize transition-colors ${
          dragging ? "bg-[var(--link)]" : "bg-[var(--border)] hover:bg-[var(--muted)]"
        }`}
        title="Drag to resize"
      />
      <Pane page={right} side="right" onSwap={swap} onClose={closeRight} />
    </div>
  );
}
