"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SaveIndicator from "@/components/SaveIndicator";

interface TemplateInfo {
  key: string;
  name: string;
  icon: string;
  description: string;
  kind: string;
}

/**
 * Send, and come back with either the JSON or a sentence to show.
 *
 * The same contract the Sidebar's tree actions use (its own `send` is
 * module-private there): the server's own words whenever it sent any - a
 * demotion answers "You have view-only access to this workspace", an expired
 * session "Not signed in" - and the caller's plain fallback for a transport
 * failure, which carries no message worth showing anyone.
 */
async function send<T>(
  url: string,
  init: RequestInit,
  fallback: string
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, message: fallback };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    const stated = typeof body?.error === "string" ? body.error.trim() : "";
    return { ok: false, message: stated || fallback };
  }
  // A 2xx whose body did not parse is still a failure from here: the caller
  // needs the id it promised. Reporting it beats navigating to /p/undefined.
  if (!body) return { ok: false, message: fallback };
  return { ok: true, data: body as T };
}

export default function TemplatePicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [busy, setBusy] = useState(false);
  /** The list request failed - shown in place of "Loading…", which otherwise
   *  sat there forever and read as a slow server. */
  const [listError, setListError] = useState<string | null>(null);
  /**
   * A creation that was refused.
   *
   * This picker used to end at `if (!res.ok) return`: the modal stayed open,
   * the buttons re-enabled, and nothing said anything - so a view-only member
   * whose role changed under them, or a transient 500 the route's own comment
   * calls "logged, retryable", just clicked again. The Sidebar's tree actions
   * stopped doing that; the picker the same Sidebar mounts had not, so the
   * contract stopped at this component's edge. Same reporting surface as the
   * Sidebar now: an error pill in the server's own words, with the whole action
   * offered again.
   */
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<() => void>(() => {});

  // The state updates live in the promise callback, not in the synchronous
  // body: this runs from an effect, and an effect that sets state on the way
  // in is a cascading render (and a lint error).
  const load = useCallback(() => {
    void send<{ templates?: TemplateInfo[] }>(
      "/api/pages/from-template",
      {},
      "Couldn't load the templates."
    ).then((res) => {
      if (!res.ok) {
        setListError(res.message);
        return;
      }
      setListError(null);
      setTemplates(res.data.templates ?? []);
    });
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // A pill from a previous attempt is stale the moment the picker is back: its
  // Try again would repeat a choice the user is in the middle of changing, and
  // at z-40 it would sit behind this modal's own backdrop. Cleared during
  // render rather than in an effect - clearing state is not a side effect, and
  // an effect would render the stale pill once before removing it.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setError(null);
  }

  const pick = useCallback(
    async (key: string) => {
      const run = async (): Promise<void> => {
        setBusy(true);
        const res = await send<{ pageId?: unknown }>(
          "/api/pages/from-template",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key }),
          },
          "Couldn't create a page from that template."
        );
        setBusy(false);
        const pageId = res.ok && typeof res.data.pageId === "string" ? res.data.pageId : null;
        if (!pageId) {
          retry.current = () => void run();
          setError(res.ok ? "Couldn't create a page from that template." : res.message);
          // Report from outside the modal. The pill is `fixed z-40` and this
          // overlay is `z-50`, so left open it would dim the pill and put its
          // Try again under a backdrop whose mousedown closes the dialog.
          onClose();
          return;
        }
        setError(null);
        onClose();
        router.push(`/p/${pageId}`);
        router.refresh();
      };
      await run();
    },
    [onClose, router]
  );

  // Slot 5: above the Sidebar's own action-error (3) and skipped-attachment
  // warning (4) pills, which belong to the component that mounts this one and
  // can be on screen at the same time.
  const pill = error ? (
    <SaveIndicator
      state="error"
      error={error}
      onRetry={() => {
        setError(null);
        retry.current();
      }}
      slot={5}
      label="Template not created"
    />
  ) : null;

  if (!open) return pill;

  return (
    <>
      {pill}
      <div
        className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[12vh]"
        onMouseDown={onClose}
      >
        <div
          className="w-full max-w-lg bg-[var(--elevated)] rounded-lg shadow-2xl border border-[var(--border)] overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 border-b border-[var(--border-soft)]">
            <h2 className="font-semibold text-sm">New from template</h2>
            <p className="text-xs text-[var(--muted)]">
              Creates a ready-made page or database in your workspace.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto py-1">
            {templates.map((t) => (
              <button
                key={t.key}
                disabled={busy}
                onClick={() => pick(t.key)}
                className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-[var(--hover)] disabled:opacity-50"
              >
                <span className="text-xl">{t.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{t.name}</span>
                  <span className="block text-xs text-[var(--faint)] truncate">
                    {t.description}
                  </span>
                </span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--faint)] border border-[var(--border)] rounded px-1.5 py-0.5">
                  {t.kind}
                </span>
              </button>
            ))}
            {templates.length === 0 &&
              (listError ? (
                <div role="alert" className="px-4 py-6 text-center">
                  <p className="text-sm text-[var(--danger)]">{listError}</p>
                  <button
                    onClick={() => load()}
                    className="mt-2 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <p className="px-4 py-6 text-sm text-[var(--faint)] text-center">Loading…</p>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}
