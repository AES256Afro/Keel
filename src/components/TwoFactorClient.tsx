"use client";

import { useCallback, useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

export default function TwoFactorClient() {
  const [error, setError] = useState<string | null>(null);
  // Starts true: the page prompts for the key immediately on load, so "busy"
  // is the initial state rather than something an effect switches on (which
  // would render the idle UI for one frame and cascade a second render).
  const [busy, setBusy] = useState(true);

  /**
   * The WebAuthn ceremony. Deliberately does no synchronous state updates -
   * every path to a setState is behind an `await` - so the mount effect below
   * can call it without cascading a second render. Callers that need the
   * spinner reset first (the retry button) do that themselves.
   */
  const authenticate = useCallback(async () => {
    try {
      const optRes = await fetch("/api/auth/webauthn/authenticate/options", { method: "POST" });
      if (!optRes.ok) throw new Error((await optRes.json().catch(() => ({}))).error ?? "Sign-in expired");
      const optionsJSON = await optRes.json();

      const response = await startAuthentication({ optionsJSON });

      const verRes = await fetch("/api/auth/webauthn/authenticate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const data = await verRes.json().catch(() => ({}));
      if (!verRes.ok) throw new Error(data.error ?? "Security key not recognized");
      window.location.href = data.redirect ?? "/";
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not verify your security key";
      // The user cancelling the browser prompt shouldn't read as a scary error.
      setError(/abort|cancel|not allowed/i.test(msg) ? "Cancelled  -  tap your key to try again." : msg);
      setBusy(false);
    }
  }, []);

  // Prompt for the key automatically on load. `authenticate` is stable
  // (useCallback with no deps), so this runs exactly once.
  useEffect(() => {
    // The rule flags this because `authenticate` contains setState calls, but
    // it can't see that all of them sit behind an `await` - nothing runs
    // synchronously in this effect, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void authenticate();
  }, [authenticate]);

  const retry = () => {
    setBusy(true);
    setError(null);
    void authenticate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--panel)] px-4">
      <div className="w-full max-w-sm text-center">
        <div className="text-4xl mb-3">🔑</div>
        <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Insert your security key and tap it to finish signing in.
        </p>
        {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        <button
          onClick={retry}
          disabled={busy}
          className="mt-5 w-full rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
        >
          {busy ? "Waiting for your key…" : "Use security key"}
        </button>
        <a href="/login" className="mt-4 inline-block text-sm text-[var(--muted)] hover:text-[var(--fg)]">
          Cancel
        </a>
      </div>
    </div>
  );
}
