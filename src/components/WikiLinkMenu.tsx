"use client";

import { forwardRef, useImperativeHandle, useState } from "react";

export interface PageOption {
  id: string;
  title: string;
  icon: string | null;
  type: string;
}

export interface WikiLinkItem {
  /** null means "create a page with this title". */
  page: PageOption | null;
  title: string;
}

export interface WikiLinkMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * The `[[` picker.
 *
 * Mirrors the slash menu's interaction model - arrow keys, Enter, Escape -
 * because two different pickers in one editor is one too many to learn. The
 * last entry is always "create", so writing a link to a page that doesn't exist
 * yet takes the same keystrokes as linking to one that does.
 */
const WikiLinkMenu = forwardRef<
  WikiLinkMenuRef,
  { items: WikiLinkItem[]; command: (item: WikiLinkItem) => void }
>(function WikiLinkMenu({ items, command }, ref) {
  const [selected, setSelected] = useState(0);

  // Keep the highlight in range when the list shrinks under it.
  const [lastLength, setLastLength] = useState(items.length);
  if (items.length !== lastLength) {
    setLastLength(items.length);
    if (selected >= items.length) setSelected(Math.max(0, items.length - 1));
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((s) => (s - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div className="w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl">
      {items.map((item, i) => (
        <button
          key={item.page?.id ?? `__create__${item.title}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the editor selection
            command(item);
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
            i === selected ? "bg-[var(--hover)]" : ""
          }`}
        >
          {item.page ? (
            <>
              <span>{item.page.icon ?? (item.page.type === "database" ? "🗂️" : "📄")}</span>
              <span className="truncate">{item.page.title}</span>
              <span className="ml-auto shrink-0 text-xs capitalize text-[var(--faint)]">
                {item.page.type}
              </span>
            </>
          ) : (
            <>
              <span>✚</span>
              <span className="truncate">
                Create <strong>{item.title}</strong>
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
});

export default WikiLinkMenu;
