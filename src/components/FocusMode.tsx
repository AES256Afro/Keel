"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export interface FocusSettings {
  /** Dim everything except the paragraph under the cursor. */
  dimSurroundings: boolean;
  /** Keep the caret vertically centred as you type. */
  typewriter: boolean;
  /** Hide the sidebar and page chrome. */
  hideChrome: boolean;
}

const DEFAULTS: FocusSettings = {
  dimSurroundings: true,
  typewriter: true,
  hideChrome: true,
};

const STORAGE_KEY = "keel-focus";

/**
 * Focus mode.
 *
 * Lattics calls this "a perfectly immersive writing experience with a
 * typewriter, focus mode and keyboard sounds". The first two are worth having;
 * keyboard sounds are a novelty that would need audio assets and a mute
 * control, so they're left out.
 *
 * Preferences live in localStorage rather than the database - this is a
 * per-device preference like the theme, and syncing it would make Focus mode on
 * a laptop turn it on for a phone.
 */
/* localStorage as an external store.
 *
 * Reading it in an effect and calling setState renders once with the defaults
 * and again with the real value. useSyncExternalStore is the primitive built
 * for this, and subscribing to `storage` also syncs preferences across tabs for
 * free. The snapshot is cached because the hook requires a stable reference -
 * returning a fresh object each call would loop forever. */
let cachedRaw: string | null = null;
let cachedSettings: FocusSettings = DEFAULTS;

function readSettings(): FocusSettings {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULTS; // private mode
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedSettings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
    } catch {
      cachedSettings = DEFAULTS; // corrupt value
    }
  }
  return cachedSettings;
}

const listeners = new Set<() => void>();
function subscribeSettings(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useFocusMode() {
  const [active, setActive] = useState(false);
  // Server render and first client render both see DEFAULTS, so there is no
  // hydration mismatch; the stored value arrives in the same commit.
  const settings = useSyncExternalStore(subscribeSettings, readSettings, () => DEFAULTS);

  const update = useCallback((patch: Partial<FocusSettings>) => {
    const next = { ...readSettings(), ...patch };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode; the session still works */
    }
    // `storage` only fires in OTHER tabs, so this tab is notified directly.
    for (const listener of listeners) listener();
  }, []);

  // Escape leaves, and the shortcut toggles. Bound at the window so it works
  // whether or not the editor has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setActive((v) => !v);
      }
      if (e.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The class drives the CSS; putting it on <html> means the sidebar can be
  // hidden without this component knowing the layout.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("keel-focus", active);
    root.classList.toggle("keel-focus-dim", active && settings.dimSurroundings);
    root.classList.toggle("keel-focus-typewriter", active && settings.typewriter);
    root.classList.toggle("keel-focus-chrome", active && settings.hideChrome);
    return () => {
      root.classList.remove(
        "keel-focus",
        "keel-focus-dim",
        "keel-focus-typewriter",
        "keel-focus-chrome"
      );
    };
  }, [active, settings]);

  return { active, setActive, settings, update };
}

/** The controls shown while focus mode is on. Rendered into <body>. */
export function FocusBar({
  settings,
  update,
  onExit,
  stats,
}: {
  settings: FocusSettings;
  update: (patch: Partial<FocusSettings>) => void;
  onExit: () => void;
  stats: { words: number; readingMinutes: number };
}) {
  // No mount guard needed: FocusBar only renders once focus mode is active,
  // which requires a click or a keystroke - always after hydration.
  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--elevated)] px-4 py-2 text-xs shadow-xl">
      <span className="tabular-nums text-[var(--muted)]">
        {stats.words.toLocaleString()} words
      </span>
      <span className="text-[var(--faint)]">·</span>
      <span className="tabular-nums text-[var(--faint)]">{stats.readingMinutes} min read</span>

      <span className="mx-1 h-4 w-px bg-[var(--border)]" />

      <label className="flex cursor-pointer items-center gap-1.5 text-[var(--muted)]">
        <input
          type="checkbox"
          checked={settings.dimSurroundings}
          onChange={(e) => update({ dimSurroundings: e.target.checked })}
        />
        Dim
      </label>
      <label className="flex cursor-pointer items-center gap-1.5 text-[var(--muted)]">
        <input
          type="checkbox"
          checked={settings.typewriter}
          onChange={(e) => update({ typewriter: e.target.checked })}
        />
        Typewriter
      </label>

      <span className="mx-1 h-4 w-px bg-[var(--border)]" />

      <button onClick={onExit} className="text-[var(--muted)] hover:text-[var(--fg)]">
        Exit <kbd className="ml-1 text-[10px] text-[var(--faint)]">Esc</kbd>
      </button>
    </div>,
    document.body
  );
}
