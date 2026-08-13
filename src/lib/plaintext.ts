// Flatten a ProseMirror document to searchable text.
//
// Page.content is the serialized editor document, so searching it directly
// greps JSON: every page matches "paragraph", "doc", "type" and "text", and a
// word split across two marks ("**bold**ed") never matches at all. Storing the
// flattened text alongside gives search something real to look at - and
// something an index can actually serve.

interface PMMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface PMNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
}

/** Nodes whose text is structural rather than prose. */
const SKIP = new Set(["horizontalRule", "image"]);

/**
 * Extract the visible text of a serialized ProseMirror document.
 *
 * Block boundaries become newlines so that a phrase cannot accidentally span
 * two paragraphs, and a code block's contents are kept - people search for
 * snippets they pasted.
 */
export function documentToPlainText(json: string | null, limit = 100_000): string {
  if (!json) return "";
  let doc: PMNode;
  try {
    doc = JSON.parse(json) as PMNode;
  } catch {
    return "";
  }

  const parts: string[] = [];
  let length = 0;

  // Iterative walk: a deeply nested document should not risk the stack, and the
  // budget stops one enormous page from dominating the index.
  const stack: PMNode[] = [doc];
  while (stack.length && length < limit) {
    const node = stack.pop()!;
    if (!node || SKIP.has(node.type ?? "")) continue;

    if (typeof node.text === "string" && node.text) {
      parts.push(node.text);
      length += node.text.length;
    }
    // Link targets are worth finding by. A link is a MARK on a text node, not
    // a node attribute - reading node.attrs alone silently indexes nothing.
    for (const source of [node.attrs, ...(node.marks ?? []).map((m) => m.attrs)]) {
      const href = source?.href ?? source?.src;
      if (typeof href === "string" && href) {
        parts.push(href);
        length += href.length;
      }
    }

    const children = node.content;
    if (children) {
      // Pushed in reverse so the stack yields them in document order.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      // A block boundary keeps adjacent blocks from merging into one phrase.
      if (node.type && node.type !== "text") parts.push("\n");
    }
  }

  return parts
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, limit);
}

/**
 * A short excerpt around the first match, for search results.
 *
 * Returns the plain text with the match roughly centred, and marks where it
 * begins so the caller can highlight without re-searching.
 */
export function snippet(
  text: string,
  query: string,
  radius = 70
): { text: string; matchStart: number; matchLength: number } | null {
  if (!text || !query) return null;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return null;

  let at = haystack.indexOf(needle);
  let matchLength = needle.length;

  if (at < 0) {
    // No exact phrase - fall back to the longest term that does appear, so a
    // multi-word query still shows useful context.
    const terms = needle.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of terms) {
      const i = haystack.indexOf(term);
      if (i >= 0) {
        at = i;
        matchLength = term.length;
        break;
      }
    }
  }
  if (at < 0) return null;

  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + matchLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    text: prefix + text.slice(start, end).replace(/\n/g, " ") + suffix,
    matchStart: prefix.length + (at - start),
    matchLength,
  };
}
