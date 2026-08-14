import type { ReactNode } from "react";
import { parseDoc, safeHref, safeImageSrc, type PMNode } from "@/lib/richtext";

/**
 * Stored editor JSON rendered as static React - no editor instance, no client
 * JS, no HTML strings. Used wherever a document is read rather than written:
 * sequence reading and public page sharing.
 *
 * The node set is closed (only Keel's editor writes these documents), so an
 * unknown type rendering as its children is a safety net, not a feature.
 */

function Inline({ nodes }: { nodes?: PMNode[] }) {
  if (!nodes) return null;
  return (
    <>
      {nodes.map((node, i) => {
        if (node.type === "hardBreak") return <br key={i} />;
        let el: ReactNode = node.text ?? "";
        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case "bold":
              el = <strong>{el}</strong>;
              break;
            case "italic":
              el = <em>{el}</em>;
              break;
            case "strike":
              el = <s>{el}</s>;
              break;
            case "code":
              el = <code className="rounded bg-[var(--hover)] px-1 text-[0.9em]">{el}</code>;
              break;
            case "link": {
              const href = safeHref(mark.attrs?.href);
              // A hostile href renders as plain text - the words survive, the
              // scheme does not.
              if (href) {
                el = (
                  <a href={href} rel="noopener noreferrer" className="text-[var(--link)] hover:underline">
                    {el}
                  </a>
                );
              }
              break;
            }
          }
        }
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}

export type RichDocImageSource = (src: string) => string | null;

function Block({ node, imageSrc }: { node: PMNode; imageSrc?: RichDocImageSource }) {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="mb-3 leading-relaxed">
          <Inline nodes={node.content} />
        </p>
      );
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)));
      const Tag = (["h2", "h3", "h4"] as const)[level - 1];
      const size = ["text-2xl", "text-xl", "text-lg"][level - 1];
      return (
        <Tag className={`${size} mb-2 mt-6 font-bold`}>
          <Inline nodes={node.content} />
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul className="mb-3 list-disc pl-6">
          <Blocks nodes={node.content} imageSrc={imageSrc} />
        </ul>
      );
    case "orderedList":
      return (
        <ol className="mb-3 list-decimal pl-6">
          <Blocks nodes={node.content} imageSrc={imageSrc} />
        </ol>
      );
    case "listItem":
      return (
        <li>
          <Blocks nodes={node.content} tight imageSrc={imageSrc} />
        </li>
      );
    case "taskList":
      return (
        <ul className="mb-3 list-none pl-1">
          <Blocks nodes={node.content} imageSrc={imageSrc} />
        </ul>
      );
    case "taskItem":
      return (
        <li className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5 select-none">
            {node.attrs?.checked ? "☑" : "☐"}
          </span>
          <div className={node.attrs?.checked ? "text-[var(--muted)] line-through" : ""}>
            <Blocks nodes={node.content} tight imageSrc={imageSrc} />
          </div>
        </li>
      );
    case "blockquote":
      return (
        <blockquote className="mb-3 border-l-2 border-[var(--border)] pl-4 text-[var(--muted)]">
          <Blocks nodes={node.content} imageSrc={imageSrc} />
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre className="mb-3 overflow-x-auto rounded bg-[var(--hover)] p-3 text-sm">
          <code>{(node.content ?? []).map((n) => n.text ?? "").join("")}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr className="my-6 border-[var(--border-soft)]" />;
    case "image": {
      const storedSrc = safeImageSrc(node.attrs?.src);
      const src = storedSrc && imageSrc ? imageSrc(storedSrc) : storedSrc;
      if (!src) return null;
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      // eslint-disable-next-line @next/next/no-img-element -- same-origin, size unknown
      return <img src={src} alt={alt} loading="lazy" className="mb-3 max-w-full rounded" />;
    }
    default:
      return node.content ? <Blocks nodes={node.content} imageSrc={imageSrc} /> : null;
  }
}

function Blocks({
  nodes,
  tight = false,
  imageSrc,
}: {
  nodes?: PMNode[];
  tight?: boolean;
  imageSrc?: RichDocImageSource;
}) {
  if (!nodes) return null;
  return (
    <>
      {nodes.map((node, i) =>
        // Inside list items a paragraph should not add its block margin.
        tight && node.type === "paragraph" ? (
          <span key={i} className="leading-relaxed">
            <Inline nodes={node.content} />
          </span>
        ) : (
          <Block key={i} node={node} imageSrc={imageSrc} />
        )
      )}
    </>
  );
}

export default function RichDoc({
  content,
  imageSrc,
}: {
  content: string | null;
  imageSrc?: RichDocImageSource;
}) {
  const doc = parseDoc(content);
  if (!doc) return <p className="text-sm text-[var(--faint)]">Empty page.</p>;
  return <Blocks nodes={doc.content} imageSrc={imageSrc} />;
}
