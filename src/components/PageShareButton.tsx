"use client";

import { useEffect, useRef, useState } from "react";

type ShareStatus = {
  active: boolean;
  createdAt?: string;
  expiresAt?: string | null;
};

type IssuedShare = {
  path: string;
  createdAt: string;
  expiresAt: string | null;
};

const EXPIRIES = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "No expiry" },
];

export default function PageShareButton({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [issued, setIssued] = useState<IssuedShare | null>(null);
  const [expiry, setExpiry] = useState("7");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const loadStatus = async () => {
    setOpen(true);
    setIssued(null);
    setCopied(false);
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/pages/${pageId}/share`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not read sharing status");
      setStatus(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read sharing status");
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch(`/api/pages/${pageId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: expiry === "never" ? null : Number(expiry) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not create the public link");
      const next: IssuedShare = data;
      setIssued(next);
      setStatus({ active: true, createdAt: next.createdAt, expiresAt: next.expiresAt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the public link");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pages/${pageId}/share`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not revoke the public link");
      setIssued(null);
      setStatus({ active: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the public link");
    } finally {
      setBusy(false);
    }
  };

  const publicUrl = issued ? new URL(issued.path, window.location.origin).toString() : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy was blocked. Select the link and copy it manually.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void loadStatus()}
        className="rounded px-2 py-1 hover:bg-[var(--hover)]"
        title="Create or manage a read-only public link"
      >
        ↗ Share
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-share-title"
            className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-5 text-left text-[var(--fg)] shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="page-share-title" className="text-lg font-semibold">Public read-only link</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Anyone with the link can read this document and its attached images. The link is not indexed and can be revoked at any time.
                </p>
              </div>
              <button
                ref={closeButton}
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 text-xl text-[var(--muted)] hover:bg-[var(--hover)]"
                aria-label="Close public sharing"
              >
                ×
              </button>
            </div>

            {busy && !status && <p className="mt-5 text-sm text-[var(--muted)]">Checking sharing status...</p>}

            {issued && (
              <div className="mt-5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
                <p className="text-sm font-medium">Copy this link now</p>
                <p className="mt-1 text-xs text-[var(--muted)]">For safety, Keel will not show this exact link again.</p>
                <div className="mt-3 flex gap-2">
                  <input
                    readOnly
                    value={publicUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="New public page link"
                    className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
                  />
                  <button type="button" onClick={() => void copy()} className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white">
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            {status && !issued && (
              <div className="mt-5">
                {status.active ? (
                  <div className="rounded-lg border border-[var(--border)] p-4">
                    <p className="text-sm font-medium">A public link is active.</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {status.expiresAt ? `Expires ${new Date(status.expiresAt).toLocaleString()}.` : "It does not expire."} The secret link is shown only when generated.
                    </p>
                    <button
                      type="button"
                      onClick={() => void revoke()}
                      disabled={busy}
                      className="mt-3 rounded border border-[var(--danger-border)] px-3 py-2 text-sm text-[var(--danger)] disabled:opacity-50"
                    >
                      {busy ? "Revoking..." : "Revoke link"}
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--muted)]">This document is private.</p>
                )}
              </div>
            )}

            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <label htmlFor="share-expiry" className="text-sm font-medium">Link expiry</label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <select
                  id="share-expiry"
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                >
                  {EXPIRIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => void generate()}
                  disabled={busy}
                  className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "Generating..." : status?.active ? "Replace with new link" : "Generate public link"}
                </button>
              </div>
              {status?.active && <p className="mt-2 text-xs text-[var(--muted)]">Replacing invalidates the previous link immediately.</p>}
            </div>

            {error && <p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
