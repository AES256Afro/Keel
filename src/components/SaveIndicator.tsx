"use client";

import type { SaveState } from "@/lib/useAutosave";

/**
 * The save status.
 *
 * A failure is loud and offers a way out, because the alternative - a quiet
 * "Saved" over work that never reached the server - is the worst thing a
 * notes app can do.
 */
export default function SaveIndicator({
  state,
  error,
  onRetry,
  slot = 0,
  label = "Not saved",
}: {
  state: SaveState;
  error: string | null;
  onRetry: () => void;
  /** Vertical stacking position. Pages that can show more than one indicator
   *  at once (a title error over a sync error, say) give each its own slot so
   *  neither pill hides the other's Try again. */
  slot?: number;
  /** Short description of the failed operation. Save failures use the default;
   *  action callers provide a noun that matches what the user attempted. */
  label?: string;
}) {
  const bottom = `${12 + slot * 44}px`;
  if (state === "error") {
    return (
      <div
        role="alert"
        style={{ bottom }}
        className="fixed right-4 z-40 flex max-w-sm flex-col gap-1 rounded-lg border border-[var(--danger)] bg-[var(--elevated)] px-3 py-2 text-xs shadow-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-[var(--danger)]">⚠ {label}</span>
          <button
            onClick={onRetry}
            className="ml-auto shrink-0 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
          >
            Try again
          </button>
        </div>
        {/* The message gets the pill's whole width and wraps.
         *
         * It used to share the row above with the label and the button and
         * carry `truncate`, which left it about 30 characters - so a refusal
         * the server deliberately phrased to be actionable ("… over its 400 MB
         * limit. Free space or raise KEEL_ATTACHMENT_QUOTA_MB, then try
         * again.") reached the user as "Restoring this backup would p…". The
         * only reason those refusals are a 400 carrying a sentence rather than
         * an opaque 500 is that the sentence reaches the person who can act on
         * it; clipping it here threw that away at the last hop.
         *
         * Bounded, not unbounded: a pathological message scrolls inside four
         * lines rather than growing a pill tall enough to cover the page (the
         * pills stack 44px apart, so an unbounded one would hide its
         * neighbours' Try again). At this width the refusal sentences we
         * actually send fit in three lines with no scrolling, and `title`
         * keeps anything longer recoverable. */}
        {error && (
          <p
            title={error}
            className="max-h-16 overflow-y-auto break-words text-[var(--muted)]"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ bottom }} className="fixed right-4 text-xs text-[var(--faint)]">
      {state === "saving" ? "Saving…" : "Saved"}
    </div>
  );
}
