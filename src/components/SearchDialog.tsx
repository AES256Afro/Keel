"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  icon: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

interface Snippet {
  text: string;
  matchStart: number;
  matchLength: number;
}

interface Result {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  updatedAt: string;
  snippet: Snippet | null;
}

/** Highlight the matched span without dangerouslySetInnerHTML. */
function Excerpt({ snippet }: { snippet: Snippet }) {
  const { text, matchStart, matchLength } = snippet;
  const before = text.slice(0, matchStart);
  const match = text.slice(matchStart, matchStart + matchLength);
  const after = text.slice(matchStart + matchLength);
  return (
    <span className="block truncate text-xs text-[var(--faint)]">
      {before}
      <mark className="bg-transparent font-medium text-[var(--fg)]">{match}</mark>
      {after}
    </span>
  );
}

/**
 * Is a modal already on screen?
 *
 * ⌘K must not open a search box on top of one. The overlays share
 * `fixed inset-0 z-50`, so whichever paints second hides the other while the
 * newer focus effect takes the keystrokes - the user types into a box they
 * cannot see, and on the passphrase prompt (SettingsClient's PassphraseDialog,
 * a masked input) the rest of a backup passphrase would go out as a
 * `/api/search?q=` query string.
 *
 * This asks the live DOM instead of a registry. A registry - a module Set, a
 * context provider, a `data-modal` attribute - is a promise every future dialog
 * has to remember to keep, and the two that already exist did not: the previous
 * version of this guard knew only about SearchDialog instances, so the template
 * picker and the passphrase prompt (separate components, in other files, with
 * no reason to import anything from here) both sailed past it. Nobody
 * remembers to register with a mechanism they never had to learn about.
 *
 * So the test is the property that MAKES a dialog modal, observed rather than
 * declared: at the middle of the viewport, is there a fixed-position layer
 * covering the screen between the user and the page? A new dialog is caught by
 * the shape of what it renders. The only way to escape the check is to build
 * something that does not cover the page - which is also the only case where a
 * search box opening beside it is harmless.
 */
function modalIsUp(): boolean {
  if (typeof document === "undefined") return false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // elementFromPoint returns the topmost element that takes pointer events at
  // that point, so a decorative `pointer-events-none` layer is skipped for us,
  // and a dialog panel that re-enables them is caught through its backdrop.
  let el = document.elementFromPoint(Math.floor(w / 2), Math.floor(h / 2));
  for (; el; el = el.parentElement) {
    if (window.getComputedStyle(el).position !== "fixed") continue;
    const r = el.getBoundingClientRect();
    // Covers the viewport, give or take a rounding pixel.
    if (r.top <= 0 && r.left <= 0 && r.right >= w - 1 && r.bottom >= h - 1) return true;
  }
  return false;
}

export default function SearchDialog({
  open,
  onClose,
  onSelect,
  placeholder,
  queryPrefix,
  commands = [],
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Repurposes the dialog as a page picker: choosing a result calls this
   * instead of navigating. Split view uses it to choose the second pane.
   */
  onSelect?: (r: { id: string; title: string; type: string }) => void;
  placeholder?: string;
  /** Search-syntax terms prepended invisibly, e.g. "type:document". */
  queryPrefix?: string;
  /** Navigating palettes can offer actions alongside page search results. */
  commands?: PaletteCommand[];
}) {
  const router = useRouter();
  // A dialog with `onSelect` is a picker: it hands the chosen page back to its
  // owner instead of navigating, and it is opened by that owner's own control
  // (the header's "Side by side" button). Only the navigating dialog - the one
  // the sidebar mounts - answers ⌘K. Without this, every picker on the page
  // also claimed the shortcut, so ⌘K opened two overlays at once and the
  // later-mounted picker took the focus and the keystrokes.
  const isPicker = onSelect !== undefined;
  const [query, setQuery] = useState("");
  const [fetchedResults, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog can be opened two ways - the `open` prop (sidebar button) and
  // the global ⌘K shortcut - so visibility is local state seeded from the prop.
  const [visible, setVisible] = useState(open);
  const [lastOpen, setLastOpen] = useState(open);

  // Global ⌘K / Ctrl+K shortcut - search only, never a picker.
  useEffect(() => {
    if (isPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Something is already up - this dialog, the split-view picker, the
        // template picker, the passphrase prompt. Opening a second overlay
        // would hide one behind the other and move the caret off screen.
        if (modalIsUp()) return;
        setVisible(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPicker]);

  // Follow the prop during render rather than in an effect - an effect here
  // renders the closed dialog first and only then opens it.
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setVisible(true);
  }

  // Reset the query each time the dialog appears. Focus is a DOM side effect,
  // so it belongs in an effect; clearing state does not.
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setQuery("");
      setResults([]);
      setSelected(0);
    }
  }

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible || !query.trim()) return;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const q = queryPrefix ? `${queryPrefix} ${query}` : query;
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setResults(data.results);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, visible, queryPrefix]);

  // Derived, not stored: an empty box shows nothing, without a state round-trip
  // that would briefly render the previous query's hits.
  const results = query.trim() ? fetchedResults : [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingCommands = isPicker
    ? []
    : commands.filter((command) => {
        if (!normalizedQuery) return true;
        return `${command.label} ${command.description} ${command.keywords ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      });
  const itemCount = matchingCommands.length + results.length;

  const close = () => {
    setVisible(false);
    onClose();
  };

  const openResult = (r: Result) => {
    close();
    if (onSelect) onSelect(r);
    else router.push(`/p/${r.id}`);
  };

  const runCommand = (command: PaletteCommand) => {
    close();
    void command.run();
  };

  const activateSelected = () => {
    const command = matchingCommands[selected];
    if (command) {
      runCommand(command);
      return;
    }
    const result = results[selected - matchingCommands.length];
    if (result) openResult(result);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isPicker ? "Choose a page" : "Search and commands"}
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[15vh]"
      onMouseDown={close}
    >
      <div
        className="w-full max-w-lg bg-[var(--elevated)] rounded-lg shadow-2xl border border-[var(--border)] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResults([]);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, Math.max(itemCount - 1, 0)));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
            if (e.key === "Enter") activateSelected();
          }}
          placeholder={
            placeholder ??
            (isPicker
              ? "Search pages…"
              : "Search pages or run a command… (try in:title, type:database)")
          }
          aria-label={isPicker ? "Search pages" : "Search pages or run a command"}
          className="w-full px-4 py-3 text-sm border-b border-[var(--border-soft)] focus:outline-none"
        />
        <div className="max-h-80 overflow-y-auto">
          {matchingCommands.length > 0 && (
            <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">
              Commands
            </div>
          )}
          {matchingCommands.map((command, i) => (
            <button
              key={`command:${command.id}`}
              onClick={() => runCommand(command)}
              onMouseEnter={() => setSelected(i)}
              className={`w-full flex items-start gap-3 px-4 py-2 text-sm text-left ${
                i === selected ? "bg-[var(--hover)]" : ""
              }`}
            >
              <span className="mt-0.5" aria-hidden="true">{command.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{command.label}</span>
                <span className="block truncate text-xs text-[var(--faint)]">
                  {command.description}
                </span>
              </span>
            </button>
          ))}
          {results.length > 0 && (
            <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">
              Pages
            </div>
          )}
          {results.map((r, resultIndex) => {
            const i = matchingCommands.length + resultIndex;
            return (
            <button
              key={r.id}
              onClick={() => openResult(r)}
              onMouseEnter={() => setSelected(i)}
              className={`w-full flex items-start gap-2 px-4 py-2 text-sm text-left ${
                i === selected ? "bg-[var(--hover)]" : ""
              }`}
            >
              <span className="mt-0.5">{r.icon ?? (r.type === "database" ? "🗂️" : "📄")}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate">{r.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-[var(--faint)] capitalize">
                    {r.type}
                  </span>
                </span>
                {r.snippet && <Excerpt snippet={r.snippet} />}
              </span>
            </button>
            );
          })}
          {query.trim() && itemCount === 0 && (
            <p className="px-4 py-6 text-sm text-[var(--faint)] text-center">
              No matching commands or pages
            </p>
          )}
        </div>
        {!isPicker && (
          <div className="flex gap-4 border-t border-[var(--border-soft)] px-4 py-2 text-[10px] text-[var(--faint)]">
            <span>↑↓ choose</span><span>↵ open</span><span>esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}
