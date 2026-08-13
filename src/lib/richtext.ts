// Helpers for rendering stored editor JSON outside the editor.
//
// Document content arrives via PATCH from any signed-in client, so the JSON is
// request data wearing a document costume - nothing in it can be trusted just
// because "our editor wrote it". The renderer builds React nodes (never HTML
// strings), which closes tag injection; what remains is attribute values, and
// the dangerous one is a link's href.

export interface PMNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PMNode[];
}

/**
 * A link destination that is safe to put in an href.
 *
 * `javascript:` (and `vbscript:`, `data:` documents, and anything else with a
 * scheme we didn't approve) becomes null - the text still renders, just not as
 * a link. Scheme-relative and path-relative URLs are allowed: they can only
 * point at this instance.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (href.length === 0 || href.length > 2048) return null;
  // Path-relative and fragment links stay inside the app.
  if (href.startsWith("/") || href.startsWith("#")) return href;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (!scheme) return href; // bare "example.com" - the browser treats it as relative
  return ["http", "https", "mailto"].includes(scheme) ? href : null;
}

/** Images may only point at this instance's own image endpoints: uploaded
 *  attachments, or files the OneNote mirror captured. */
export function safeImageSrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\/api\/attachments\/[A-Za-z0-9_-]+$/.test(value)) return value;
  if (/^\/api\/assets\/onenote-[a-f0-9]+\.(?:jpg|png|gif|webp)$/.test(value)) return value;
  return null;
}

export function parseDoc(content: string | null): PMNode | null {
  if (!content) return null;
  try {
    const doc = JSON.parse(content) as PMNode;
    return doc && typeof doc === "object" && Array.isArray(doc.content) ? doc : null;
  } catch {
    return null;
  }
}
