"use client";

import { useEffect, useRef } from "react";
import { EditorContent, ReactRenderer, useEditor, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import LinkExtension from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension, Node } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import SlashMenu, { filterSlashItems, type SlashItem, type SlashMenuRef } from "./SlashMenu";
import WikiLinkMenu, {
  type PageOption,
  type WikiLinkItem,
  type WikiLinkMenuRef,
} from "./WikiLinkMenu";

// Every Suggestion plugin needs its own key. TipTap defaults them all to
// `suggestion$`, so a second one - the [[ picker below - throws
// "Adding different instances of a keyed plugin" at mount and takes the whole
// editor down with it.
const SLASH_KEY = new PluginKey("keelSlashCommand");
const WIKILINK_KEY = new PluginKey("keelWikiLink");

const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: SLASH_KEY,
        char: "/",
        allowSpaces: false,
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => {
          props.command(editor, range);
        },
        render: () => {
          let component: ReactRenderer<SlashMenuRef> | null = null;

          const position = (clientRect?: (() => DOMRect | null) | null) => {
            const rect = clientRect?.();
            if (!rect || !component) return;
            const el = component.element as HTMLElement;
            el.style.position = "fixed";
            el.style.left = `${rect.left}px`;
            el.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 340)}px`;
            el.style.zIndex = "50";
          };

          const destroy = () => {
            component?.element.remove();
            component?.destroy();
            component = null;
          };

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenu, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              document.body.appendChild(component.element);
              position(props.clientRect);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: props.command });
              position(props.clientRect);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                destroy();
                return true;
              }
              return component?.ref?.onKeyDown({ event: props.event }) ?? false;
            },
            onExit: destroy,
          };
        },
      }),
    ];
  },
});

/**
 * `[[` page linking.
 *
 * The link is written as plain text - `[[Target]]` - rather than a custom node.
 * That keeps the document portable (Markdown export, backups, and anything
 * reading plainText all see it), and it means the server-side link extractor
 * has exactly one thing to parse. Rendering it as a clickable chip is a
 * presentation concern for a later pass; the data is what matters first.
 */
const WikiLink = Extension.create({
  name: "wikiLink",

  addProseMirrorPlugins() {
    return [
      Suggestion<WikiLinkItem>({
        editor: this.editor,
        pluginKey: WIKILINK_KEY,
        char: "[[",
        startOfLine: false,
        allowSpaces: true,
        // Stop suggesting once the link is closed, or the menu reappears while
        // the cursor sits after a finished link.
        allow: ({ state, range }) => {
          const text = state.doc.textBetween(range.from, range.to, "\n", "\n");
          return !text.includes("]]");
        },
        items: async ({ query }) => {
          const title = query.trim();
          let pages: PageOption[] = [];
          let exactMatch = false;
          try {
            const res = await fetch(`/api/pages/lookup?q=${encodeURIComponent(title)}`);
            if (res.ok) {
              const data = await res.json();
              pages = data.pages ?? [];
              exactMatch = Boolean(data.exactMatch);
            }
          } catch {
            // Offline or rate limited - offering "create" alone is still useful.
          }
          const items: WikiLinkItem[] = pages
            .slice(0, 8)
            .map((page) => ({ page, title: page.title }));
          if (title && !exactMatch) items.push({ page: null, title });
          return items;
        },
        command: ({ editor, range, props }) => {
          // Replace the whole `[[query` span with a finished link.
          editor
            .chain()
            .focus()
            .insertContentAt(range, `[[${props.title}]] `)
            .run();
          if (!props.page) {
            // Fire and forget: the link resolves itself once the page exists
            // (see resolveLinksTo), so the editor does not wait on it.
            void fetch("/api/pages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: props.title }),
            }).catch(() => {});
          }
        },
        render: () => {
          let component: ReactRenderer<WikiLinkMenuRef> | null = null;

          const position = (clientRect?: (() => DOMRect | null) | null) => {
            const rect = clientRect?.();
            if (!rect || !component) return;
            const el = component.element as HTMLElement;
            el.style.position = "fixed";
            el.style.left = `${rect.left}px`;
            el.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 300)}px`;
            el.style.zIndex = "50";
          };

          const destroy = () => {
            component?.element.remove();
            component?.destroy();
            component = null;
          };

          return {
            onStart: (props) => {
              component = new ReactRenderer(WikiLinkMenu, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              document.body.appendChild(component.element);
              position(props.clientRect);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: props.command });
              position(props.clientRect);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                destroy();
                return true;
              }
              return component?.ref?.onKeyDown({ event: props.event }) ?? false;
            },
            onExit: destroy,
          };
        },
      }),
    ];
  },
});

/**
 * Highlight the block containing the caret.
 *
 * As a ProseMirror decoration, not a classList call on the node. ProseMirror
 * owns the editor DOM and reconciles it against the document on every
 * transaction - a class added directly is silently wiped on the next redraw,
 * which looks exactly like the code never running. Decorations are applied as
 * part of that same render, so they survive.
 */
const ActiveBlock = Extension.create({
  name: "activeBlock",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("keelActiveBlock"),
        props: {
          decorations(state) {
            const { $from } = state.selection;
            if ($from.depth === 0) return DecorationSet.empty;

            const index = $from.index(0);
            if (index >= state.doc.childCount) return DecorationSet.empty;

            // Offset of the top-level block, walking the ones before it.
            let pos = 0;
            for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;

            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + state.doc.child(index).nodeSize, {
                class: "keel-active-block",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

/**
 * Keep the caret vertically centred (typewriter scrolling).
 *
 * Pure scrolling, so it can stay outside ProseMirror's render.
 */
function scrollCaretToCentre(editor: TipTapEditor | null) {
  if (!editor) return;
  const dom = editor.view.dom as HTMLElement;
  const { $from } = editor.state.selection;
  const index = $from.depth > 0 ? $from.index(0) : 0;
  const el = dom.children[index] as HTMLElement | undefined;
  if (!el) return;

  const delta = el.getBoundingClientRect().top - window.innerHeight / 2;
  // Only scroll once the caret has genuinely drifted, or every keystroke nudges
  // the page and reading becomes seasick.
  if (Math.abs(delta) > 80) {
    window.scrollBy({
      top: delta,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }
}


/**
 * Images, written rather than pulled in: @tiptap/extension-image is another
 * dependency for what is one node with one attribute we care about. The src
 * always points at /api/attachments/<id>, same-origin and session-gated.
 */
const ImageNode = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", { ...HTMLAttributes, loading: "lazy" }];
  },
});

const IMAGE_UPLOAD_KEY = new PluginKey("keelImageUpload");

/**
 * Paste or drop an image file and it uploads, then inserts.
 *
 * The upload targets the page the editor belongs to, so the file's lifetime
 * is tied to the right page. Upload failures surface as a plain alert rather
 * than silently eating the image - a lost paste the user watched succeed is
 * worse than a visible error.
 */
function imageUploadPlugin(getPageId: () => string | null) {
  const upload = async (view: { dispatch: (tr: unknown) => void; state: { tr: { insert: (pos: number, node: unknown) => unknown } } }, files: File[], pos: number | null) => {
    const pageId = getPageId();
    if (!pageId) return false;
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    for (const file of images) {
      const body = new FormData();
      body.append("file", file);
      body.append("pageId", pageId);
      try {
        const res = await fetch("/api/attachments", { method: "POST", body });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          alert(data?.error ?? `Upload failed (${res.status})`);
          continue;
        }
        const { attachment } = await res.json();
        // Re-read state per insert - earlier inserts moved positions.
        const v = view as unknown as {
          state: { schema: { nodes: Record<string, { create: (attrs: object) => unknown } > }; tr: unknown; selection: { from: number } };
          dispatch: (tr: unknown) => void;
        };
        const node = v.state.schema.nodes.image.create({ src: attachment.url, alt: attachment.name });
        const tr = (v.state.tr as { insert: (pos: number, node: unknown) => unknown }).insert(
          pos ?? v.state.selection.from,
          node
        );
        v.dispatch(tr);
      } catch {
        alert("Upload failed - check your connection and try again.");
      }
    }
    return true;
  };

  return new Plugin({
    key: IMAGE_UPLOAD_KEY,
    props: {
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        void upload(view as never, files, null);
        return true;
      },
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        const drop = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void upload(view as never, files, drop?.pos ?? null);
        return true;
      },
    },
  });
}

const ImageUpload = Extension.create<{ getPageId: () => string | null }>({
  name: "imageUpload",
  addOptions() {
    return { getPageId: () => null };
  },
  addProseMirrorPlugins() {
    return [imageUploadPlugin(this.options.getPageId)];
  },
});

export default function Editor({
  content,
  onChange,
  editable = true,
  typewriter = false,
  onStatsChange,
  pageId = null,
}: {
  content: string | null;
  onChange?: (json: string) => void;
  editable?: boolean;
  /** Keep the caret vertically centred (focus mode). */
  typewriter?: boolean;
  /** Live word count, for the focus bar and writing goals. */
  onStatsChange?: (text: string) => void;
  /** Enables image paste/drop - uploads need a page to belong to. */
  pageId?: string | null;
}) {
  // The plugin closes over its first render; the current id is read via a ref
  // so a late-arriving prop still routes uploads correctly.
  const pageIdRef = useRef(pageId);
  useEffect(() => {
    pageIdRef.current = pageId;
  }, [pageId]);
  // The lifecycle callbacks close over their first value, so the current
  // setting is read through a ref.
  const typewriterRef = useRef(typewriter);
  useEffect(() => {
    typewriterRef.current = typewriter;
  }, [typewriter]);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      LinkExtension.configure({ openOnClick: true, autolink: true }),
      Placeholder.configure({
        placeholder: "Type '/' for blocks, '[[' to link a page, '#' to tag…",
      }),
      SlashCommand,
      WikiLink,
      ActiveBlock,
      ImageNode,
      // The getter is stored by the extension and only ever called from paste
      // and drop handlers - real events, never render - so reading the ref
      // inside it is the legal use the lint rule cannot see.
      // eslint-disable-next-line react-hooks/refs
      ImageUpload.configure({ getPageId: () => pageIdRef.current }),
    ],
    content: safeParse(content),
    onCreate: ({ editor }) => {
      onStatsChange?.(editor.getText());
      if (typewriterRef.current) scrollCaretToCentre(editor);
    },
    onUpdate: ({ editor }) => {
      onChange?.(JSON.stringify(editor.getJSON()));
      onStatsChange?.(editor.getText());
      if (typewriterRef.current) scrollCaretToCentre(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      if (typewriterRef.current) scrollCaretToCentre(editor);
    },
  });

  // useEditor re-applies its options on every render as
  // `setOptions({ ...options, editable: this.editor.isEditable })` - it pins
  // `editable` to the value the instance already has, so the prop alone can
  // never change it, and only setEditable() touches the ProseMirror view.
  // Without this, restoring a page from the trash (which re-renders with
  // editable=true and drops the banner) left the document contentEditable=false
  // and silently swallowing every keystroke until a full reload.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (Boolean(editor.isEditable) === editable) return;
    // emitUpdate: false - this is a permission change, not an edit. Emitting
    // would run onUpdate and schedule a save of content nobody touched.
    editor.setEditable(editable, false);
  }, [editor, editable]);

  // Re-centre immediately when typewriter mode is switched on, rather than
  // waiting for the next keystroke.
  useEffect(() => {
    if (typewriter) scrollCaretToCentre(editor);
  }, [editor, typewriter]);

  return (
    <div className="keel-editor text-[15px] leading-relaxed">
      <EditorContent editor={editor} />
    </div>
  );
}

function safeParse(content: string | null) {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
