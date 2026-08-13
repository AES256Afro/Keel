"use client";

import { useEffect, useState } from "react";

interface ClaimToken {
  token: string;
  expiresAt: string;
}

export default function InstanceClaimInstructions({
  heading = "Claim this Keel server",
}: {
  heading?: string;
}) {
  const [claim, setClaim] = useState<ClaimToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"cli" | "source" | "docker" | null>(null);
  const [bootstrapToken, setBootstrapToken] = useState("");

  useEffect(() => {
    if (!claim) return;
    const delay = Math.max(0, new Date(claim.expiresAt).getTime() - Date.now());
    const timeout = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timeout);
  }, [claim]);

  const generate = async () => {
    setBusy(true);
    setError("");
    setCopied(null);
    setExpired(false);
    try {
      const response = await fetch("/api/instance/claim-token", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not create a claim token");
      setClaim({ token: data.token, expiresAt: data.expiresAt });
    } catch (cause) {
      setClaim(null);
      setError(cause instanceof Error ? cause.message : "Could not create a claim token");
    } finally {
      setBusy(false);
    }
  };

  const cliCommand = claim ? `keel claim '${claim.token}'` : "";
  const sourceCommand = claim ? `npm run claim -- '${claim.token}'` : "";
  const dockerCommand = claim
    ? `docker compose exec --user root -e KEEL_CONTAINER_CLAIM=1 keel npm run claim -- '${claim.token}'`
    : "";

  const copy = async (kind: "cli" | "source" | "docker", command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Copy was blocked by the browser. Select the command and copy it manually.");
    }
  };

  const claimHosted = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/instance/claim-bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Hosted server claim was refused");
      setBootstrapToken("");
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hosted server claim was refused");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="claim-server"
      className="rounded-lg border border-amber-400/60 bg-amber-50/60 p-5 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
    >
      <h2 className="text-lg font-semibold">{heading}</h2>
      <p className="mt-2 text-sm">
        This server does not have an instance owner yet. Your account works, but
        server-wide controls stay unavailable until someone with administrator access to
        this machine claims it.
      </p>

      <details className="mt-4 rounded border border-current/20 bg-white/40 p-3 dark:bg-black/10">
        <summary className="cursor-pointer text-sm font-medium">
          Hosted or managed PostgreSQL server
        </summary>
        <div className="mt-2">
          <p className="mt-1 text-xs opacity-80">
            Paste the one-time bootstrap value from the host&apos;s protected environment.
            It is sent only to this server, compared in memory, and never stored or shown
            again. Remove the environment value after claiming.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={bootstrapToken}
              onChange={(event) => setBootstrapToken(event.target.value)}
              autoComplete="new-password"
              aria-label="Hosted owner bootstrap token"
              placeholder="Paste the hosted bootstrap token"
              className="min-w-0 flex-1 rounded border border-current/30 bg-white/70 px-3 py-2 text-sm text-black dark:bg-black/30 dark:text-white"
            />
            <button
              type="button"
              onClick={claimHosted}
              disabled={busy || bootstrapToken.trim().length < 43}
              className="rounded bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950"
            >
              {busy ? "Confirming..." : "Claim hosted server"}
            </button>
          </div>
        </div>
      </details>

      {!claim || expired ? (
        <div className="mt-4">
          {expired && (
            <p role="status" className="mb-2 text-sm font-medium">
              That claim token expired. Generate a new one before returning to the server
              terminal.
            </p>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="rounded bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
          >
            {busy ? "Generating secure command..." : expired ? "Generate a new claim command" : "Generate claim command"}
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm font-medium">
            This one-use command is bound to your signed-in account and expires at{" "}
            {new Date(claim.expiresAt).toLocaleTimeString()}. Do not share it. Generating a
            replacement invalidates this one.
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open Terminal on the macOS or Linux machine that runs Keel. On Windows,
              reopen PowerShell with <strong>Run as administrator</strong>.
            </li>
            <li>
              Use the packaged command from any folder. For a guided or source install,
              first change into the install folder printed by the installer, then use the
              source command. For Docker Compose, change into the folder containing the
              Compose file and use the Docker command.
            </li>
          </ol>
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-75">
                Packaged CLI
              </p>
              <div className="flex items-stretch gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-current/20 bg-black/5 px-3 py-2 text-xs dark:bg-black/20">
                  <code>{cliCommand}</code>
                </pre>
                <button
                  type="button"
                  aria-label="Copy packaged CLI claim command"
                  onClick={() => copy("cli", cliCommand)}
                  className="rounded border border-current/30 px-3 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {copied === "cli" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-75">
                Guided installer or source checkout
              </p>
              <div className="flex items-stretch gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-current/20 bg-black/5 px-3 py-2 text-xs dark:bg-black/20">
                  <code>{sourceCommand}</code>
                </pre>
                <button
                  type="button"
                  aria-label="Copy source-install claim command"
                  onClick={() => copy("source", sourceCommand)}
                  className="rounded border border-current/30 px-3 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {copied === "source" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-75">
                Docker Compose
              </p>
              <div className="flex items-stretch gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-current/20 bg-black/5 px-3 py-2 text-xs dark:bg-black/20">
                  <code>{dockerCommand}</code>
                </pre>
                <button
                  type="button"
                  aria-label="Copy Docker Compose claim command"
                  onClick={() => copy("docker", dockerCommand)}
                  className="rounded border border-current/30 px-3 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {copied === "docker" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
          <p className="mt-3 text-sm font-medium">
            On macOS or Linux, the command requests fresh sudo authorization in Terminal.
            Type the operating-system password only into that prompt. For Docker on Linux,
            run <code>sudo -k</code>, then prefix the Docker command with <code>sudo</code>.
            With Docker Desktop, run it without sudo from a terminal that can control the
            Docker daemon. On Windows, use an Administrator PowerShell. The browser never
            asks for an operating-system password, and Keel never receives or stores it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded border border-current/30 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
            >
              I ran the command, refresh
            </button>
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className="rounded px-3 py-1.5 text-xs underline disabled:opacity-50"
            >
              Replace this token
            </button>
          </div>
        </>
      )}

      {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
      <p className="mt-3 text-xs opacity-80">
        Claiming does not close registration. The owner chooses that separately in
        Settings.
      </p>
    </section>
  );
}
