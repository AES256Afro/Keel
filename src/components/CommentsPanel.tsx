"use client";

import { useEffect, useState } from "react";

interface CommentDTO {
  id: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  author: string;
  canManage: boolean;
}

/** Render @mentions highlighted inside a comment body. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9._-]{3,30})/gi);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        /^@[a-z0-9._-]{3,30}$/i.test(part) ? (
          <span key={i} className="text-[var(--link)] font-medium">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export default function CommentsPanel({
  pageId,
  readOnly = false,
}: {
  pageId: string;
  readOnly?: boolean;
}) {
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [truncatedUnresolved, setTruncatedUnresolved] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    fetch(`/api/pages/${pageId}/comments`)
      .then((r) => (r.ok ? r.json() : { comments: [] }))
      .then((d) => {
        setComments(d.comments ?? []);
        setTruncated(Boolean(d.truncated));
        setTruncatedUnresolved(Boolean(d.truncatedUnresolved));
      })
      .catch(() => {});
  }, [pageId]);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    const res = await fetch(`/api/pages/${pageId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (!res.ok) return;
    const data = await res.json();
    setComments((prev) => [...prev, data.comment]);
    setDraft("");
  };

  const setResolved = async (id: string, resolved: boolean) => {
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, resolved } : c)));
    await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved }),
    });
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this comment?")) return;
    setComments((prev) => prev.filter((c) => c.id !== id));
    await fetch(`/api/comments/${id}`, { method: "DELETE" });
  };

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);
  const visible = showResolved ? comments : open;

  return (
    <section className="mt-10 border-t border-[var(--border-soft)] pt-4">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-medium text-[var(--muted)]">
          💬 Comments{open.length > 0 && ` (${open.length})`}
        </h2>
        {resolved.length > 0 && (
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="text-xs text-[var(--faint)] hover:underline"
          >
            {showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {visible.map((c) => (
          <div key={c.id} className={`group flex gap-2 ${c.resolved ? "opacity-60" : ""}`}>
            <span className="w-6 h-6 rounded-full bg-[var(--btn-bg)] text-[var(--btn-fg)] text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
              {c.author[0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-[var(--faint)]">
                <span className="font-medium text-[var(--muted)]">@{c.author}</span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
                {c.resolved && <span>· resolved</span>}
                {c.canManage && (
                  <span className="opacity-0 group-hover:opacity-100 flex gap-2">
                    <button
                      onClick={() => setResolved(c.id, !c.resolved)}
                      className="hover:underline"
                      title={c.resolved ? "Reopen" : "Resolve"}
                    >
                      {c.resolved ? "↩ Reopen" : "✓ Resolve"}
                    </button>
                    <button
                      onClick={() => remove(c.id)}
                      className="text-[var(--danger)] hover:underline"
                    >
                      Delete
                    </button>
                  </span>
                )}
              </div>
              <div className="text-sm mt-0.5">
                <Body text={c.body} />
              </div>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-sm text-[var(--faint)]">No comments yet.</p>
        )}
        {truncated && (
          // Name what is actually hidden. Claiming only resolved comments are
          // missing, on a page whose UNRESOLVED comments overflowed, would be
          // the one case where the notice matters and is wrong.
          <p
            className={`text-xs ${
              truncatedUnresolved ? "text-[var(--danger)]" : "text-[var(--faint)]"
            }`}
          >
            {truncatedUnresolved
              ? "This page has more open comments than can be shown here - resolve some to see the rest."
              : "Older resolved comments aren't shown."}
          </p>
        )}
      </div>

      {!readOnly && (
        <div className="mt-4 flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="Add a comment… (@username to mention)"
            rows={2}
            className="flex-1 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          <button
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="self-end rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
          >
            Comment
          </button>
        </div>
      )}
    </section>
  );
}
