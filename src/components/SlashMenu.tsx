"use client";

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { Editor, Range } from "@tiptap/core";

export interface SlashItem {
  title: string;
  description: string;
  icon: string;
  keywords: string;
  command: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    description: "Plain paragraph",
    icon: "¶",
    keywords: "text paragraph plain",
    command: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: "Heading 1",
    description: "Large section heading",
    icon: "H1",
    keywords: "heading h1 title",
    command: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    icon: "H2",
    keywords: "heading h2 subtitle",
    command: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    icon: "H3",
    keywords: "heading h3",
    command: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    description: "Simple bulleted list",
    icon: "•",
    keywords: "bullet list unordered ul",
    command: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    description: "Ordered list with numbers",
    icon: "1.",
    keywords: "number list ordered ol",
    command: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    description: "Checklist with checkboxes",
    icon: "☑",
    keywords: "todo task check checkbox",
    command: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Capture a quote",
    icon: "❝",
    keywords: "quote blockquote citation",
    command: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    description: "Monospaced code snippet",
    icon: "</>",
    keywords: "code snippet pre",
    command: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    description: "Horizontal line",
    icon: " - ",
    keywords: "divider rule hr separator line",
    command: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) => item.title.toLowerCase().includes(q) || item.keywords.includes(q)
  );
}

export interface SlashMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(function SlashMenu(props, ref) {
  const [index, setIndex] = useState(0);

  useEffect(() => setIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setIndex((i) => (i + props.items.length - 1) % Math.max(1, props.items.length));
        return true;
      }
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % Math.max(1, props.items.length));
        return true;
      }
      if (event.key === "Enter") {
        const item = props.items[index];
        if (item) props.command(item);
        return true;
      }
      return false;
    },
  }));

  if (props.items.length === 0) {
    return (
      <div className="w-72 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl p-3 text-sm text-[var(--faint)]">
        No matching blocks
      </div>
    );
  }

  return (
    <div className="w-72 max-h-80 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl py-1">
      {props.items.map((item, i) => (
        <button
          key={item.title}
          onClick={() => props.command(item)}
          onMouseEnter={() => setIndex(i)}
          className={`w-full flex items-center gap-3 px-3 py-1.5 text-left ${
            i === index ? "bg-[var(--hover)]" : ""
          }`}
        >
          <span className="w-8 h-8 flex items-center justify-center rounded border border-[var(--border)] text-xs text-[var(--muted)] shrink-0">
            {item.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-sm">{item.title}</span>
            <span className="block text-xs text-[var(--faint)] truncate">{item.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

export default SlashMenu;
