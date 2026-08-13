"use client";

import { useEffect } from "react";

/** Records a visit for the "Recent" sidebar section. Renders nothing. */
export default function TrackVisit({ pageId }: { pageId: string }) {
  useEffect(() => {
    fetch(`/api/pages/${pageId}/visit`, { method: "POST" }).catch(() => {});
  }, [pageId]);
  return null;
}
