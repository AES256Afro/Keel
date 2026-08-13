// Convert a TipTap/ProseMirror document (as JSON) to Markdown for export.

type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PMNode[];
};

function renderText(node: PMNode): string {
  let text = node.text ?? "";
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        text = `**${text}**`;
        break;
      case "italic":
        text = `*${text}*`;
        break;
      case "strike":
        text = `~~${text}~~`;
        break;
      case "code":
        text = `\`${text}\``;
        break;
      case "link":
        text = `[${text}](${(mark.attrs?.href as string) ?? ""})`;
        break;
    }
  }
  return text;
}

function renderInline(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === "hardBreak" ? "  \n" : renderText(n)))
    .join("");
}

function renderNodes(nodes: PMNode[] | undefined, indent = ""): string {
  return (nodes ?? []).map((n) => renderNode(n, indent)).filter(Boolean).join("\n\n");
}

function renderListItems(
  items: PMNode[] | undefined,
  indent: string,
  marker: (i: number, item: PMNode) => string
): string {
  return (items ?? [])
    .map((item, i) => {
      const prefix = indent + marker(i, item);
      const inner = (item.content ?? [])
        .map((child, ci) => {
          if (child.type === "paragraph") {
            const text = renderInline(child.content);
            return ci === 0 ? prefix + text : indent + "  " + text;
          }
          return renderNode(child, indent + "  ");
        })
        .filter(Boolean)
        .join("\n");
      return inner || prefix;
    })
    .join("\n");
}

function renderNode(node: PMNode, indent = ""): string {
  switch (node.type) {
    case "paragraph":
      return indent + renderInline(node.content);
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return indent + "#".repeat(Math.min(6, Math.max(1, level))) + " " + renderInline(node.content);
    }
    case "bulletList":
      return renderListItems(node.content, indent, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return renderListItems(node.content, indent, (i) => `${start + i}. `);
    }
    case "taskList":
      return renderListItems(node.content, indent, (_, item) =>
        item.attrs?.checked ? "- [x] " : "- [ ] "
      );
    case "blockquote":
      return renderNodes(node.content, indent)
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      return `${indent}\`\`\`${lang}\n${code}\n${indent}\`\`\``;
    }
    case "horizontalRule":
      return indent + "---";
    case "image": {
      // The src is instance-relative (/api/attachments/…) - kept as-is, so the
      // reference survives round-trips and stays honest about where the bytes
      // live rather than pretending the file travelled with the export.
      const src = String(node.attrs?.src ?? "");
      const alt = String(node.attrs?.alt ?? "");
      return src ? `${indent}![${alt.replace(/[[\]]/g, "")}](${src})` : "";
    }
    default:
      // Unknown node: render its inline content if any.
      if (node.content) return renderNodes(node.content, indent);
      return "";
  }
}

export function tiptapToMarkdown(docJson: string | null, title: string): string {
  let body = "";
  if (docJson) {
    try {
      const doc = JSON.parse(docJson) as PMNode;
      body = renderNodes(doc.content);
    } catch {
      body = "";
    }
  }
  const heading = title ? `# ${title}\n\n` : "";
  return heading + body + "\n";
}
