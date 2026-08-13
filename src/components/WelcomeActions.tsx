"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The welcome page's exit. Both buttons mark onboarding done - "skip" and
 * "finish" are the same fact with different feelings, and neither is ever
 * shown again. If the mark fails to save, continue anyway: trapping someone
 * on the welcome screen would be the exact hair-pulling this flow exists to
 * prevent.
 */
export default function WelcomeActions() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const done = async () => {
    setLeaving(true);
    try {
      await fetch("/api/account/onboarded", { method: "POST" });
    } catch {
      // Non-fatal by design - worst case the welcome shows once more.
    }
    router.push("/");
    router.refresh();
  };

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={done}
        disabled={leaving}
        className="rounded bg-[var(--btn-bg)] px-5 py-2.5 text-sm font-medium text-[var(--btn-fg)] disabled:opacity-50"
      >
        Take me to my notes →
      </button>
      <button
        onClick={done}
        disabled={leaving}
        className="text-sm text-[var(--muted)] hover:underline disabled:opacity-50"
      >
        Skip all of this
      </button>
    </div>
  );
}
