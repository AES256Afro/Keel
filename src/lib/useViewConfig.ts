"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewConfig, ViewDTO } from "@/lib/views";

/**
 * Local view config that writes through to the server, debounced.
 *
 * View settings change constantly while someone is working - dragging a WIP
 * limit, collapsing a column, retyping a filter - and each change should feel
 * instant and still be there tomorrow. So the local copy updates immediately
 * and the PATCH is coalesced.
 *
 * Views whose id starts with "virtual-" are the fallback set a pre-views
 * database renders; there's no row to save to, so changes stay in memory.
 */
export function useViewConfig(view: ViewDTO, readOnly: boolean, onFailure?: () => void) {
  const [config, setConfig] = useState<ViewConfig>(view.config);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<ViewConfig | null>(null);
  const viewId = view.id;
  const persistable = !readOnly && !viewId.startsWith("virtual-");

  // Switching views (or reloading server data) replaces the config wholesale.
  const [lastViewId, setLastViewId] = useState(viewId);
  if (viewId !== lastViewId) {
    setLastViewId(viewId);
    setConfig(view.config);
  }

  const flush = useCallback(() => {
    const body = pending.current;
    pending.current = null;
    if (!body || !persistable) return;
    void fetch(`/api/views/${viewId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: body }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`View update failed (${res.status})`);
      })
      .catch(() => onFailure?.());
  }, [viewId, persistable, onFailure]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      flush(); // don't lose the last change on unmount / view switch
    };
  }, [flush]);

  const update = useCallback(
    (patch: Partial<ViewConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch };
        pending.current = next;
        return next;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 500);
    },
    [flush]
  );

  return { config, update, persistable };
}
