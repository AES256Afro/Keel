import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentContext } from "@/lib/auth";
import { keelEnv, keelFlag } from "@/lib/env";
import { backupRoot } from "@/lib/backup";
import { attachmentQuotaBytes, maxAttachmentBytes } from "@/lib/attachments";
import { buildCapabilities, detectStatus, type CapabilityState } from "@/lib/setup-guide";
import { publicOriginFromHeaders } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

/**
 * The setup guide - every optional capability, its live status, and an exact
 * trail of breadcrumbs to whatever it needs.
 *
 * The design rule: nobody should have to leave this page to find out WHERE a
 * credential comes from, and nobody should have to guess where it goes once
 * they have it. External links open the precise console page; each step is
 * written for someone doing it the first time.
 */

const PILL: Record<CapabilityState, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-[var(--success-bg,#e6f4ea)] text-[var(--success,#137333)]" },
  "action-needed": { label: "Worth doing", cls: "bg-[var(--danger-bg)] text-[var(--danger)]" },
  optional: { label: "Optional", cls: "bg-[var(--hover)] text-[var(--muted)]" },
};

export default async function SetupPage() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");

  const h = await headers();
  const baseUrl = publicOriginFromHeaders(h);

  const capabilities = buildCapabilities(baseUrl);
  const status = detectStatus(ctx.workspace);
  const groups = [...new Set(capabilities.map((c) => c.group))];

  const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const dbLocation = dbUrl.startsWith("file:")
    ? dbUrl.slice(5)
    : "a PostgreSQL server (managed by your database provider)";
  const lockedDown = Boolean(keelEnv("ALLOWED_EMAILS")) && keelFlag("DISABLE_SIGNUP");
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="mb-1 text-2xl font-bold">✳ Setup guide</h1>
      <p className="mb-8 text-sm text-[var(--muted)]">
        Keel works the moment you sign in - everything below is optional and adds one thing
        each. Every item tells you exactly what it needs, where that comes from, and where
        it goes. Nothing here expires your patience on purpose.
      </p>

      {/* Where things live - the honest map of your data. */}
      <section className="mb-10 rounded-lg border border-[var(--border)] p-5" id="your-data">
        <h2 className="mb-3 text-lg font-semibold">Where your data lives</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-[var(--muted)]">Notes &amp; databases</dt>
            <dd>
              <code className="rounded bg-[var(--hover)] px-1">{dbLocation}</code>
              {dbUrl.startsWith("file:") && (
                <span className="text-[var(--muted)]"> - one SQLite file is the whole workspace</span>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-[var(--muted)]">Pasted images &amp; files</dt>
            <dd>
              inside that same database (up to {mb(maxAttachmentBytes())} per file,{" "}
              {mb(attachmentQuotaBytes())} per workspace) - so backing up one file backs up
              everything
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-[var(--muted)]">Snapshot backups</dt>
            <dd>
              <code className="rounded bg-[var(--hover)] px-1">{backupRoot()}</code>
              <span className="text-[var(--muted)]"> - plus any cloud destination you connect below</span>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-[var(--muted)]">Who can sign in</dt>
            <dd>
              {lockedDown ? (
                <span>
                  locked down - sign-ups are off and only allowlisted accounts get in
                </span>
              ) : (
                <span className="text-[var(--danger)]">
                  open - fine on a private network; set KEEL_ALLOWED_EMAILS and
                  KEEL_DISABLE_SIGNUP=1 before exposing this to the internet
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {groups.map((group) => (
        <section key={group} className="mb-10">
          <h2 className="mb-4 text-lg font-semibold">{group}</h2>
          <div className="space-y-4">
            {capabilities
              .filter((c) => c.group === group)
              .map((cap) => {
                const st = status[cap.key] ?? { state: "optional" as const, detail: "" };
                const pill = PILL[st.state];
                return (
                  <details
                    key={cap.key}
                    id={cap.key}
                    className="group rounded-lg border border-[var(--border)] p-4 open:pb-5"
                    open={st.state === "action-needed"}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-3">
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${pill.cls}`}>
                        {pill.label}
                      </span>
                      <span className="font-medium">{cap.title}</span>
                      <span className="ml-auto text-xs text-[var(--faint)] group-open:hidden">
                        show steps
                      </span>
                    </summary>
                    <p className="mt-2 text-sm text-[var(--muted)]">{cap.payoff}</p>
                    <p className="mt-1 text-sm">
                      {st.state === "ready" ? cap.readyLine : st.detail}
                    </p>
                    {st.state !== "ready" &&
                      cap.needs.map((need) => (
                        <div key={need.name} className="mt-4 rounded border border-[var(--border-soft)] bg-[var(--hover)]/40 p-4">
                          <p className="text-sm font-medium">You&apos;ll need: {need.name}</p>
                          <p className="mt-1 text-sm text-[var(--muted)]">{need.what}</p>
                          <p className="mt-2 text-sm">
                            Get it here:{" "}
                            {need.where.url.startsWith("/") ? (
                              <Link href={need.where.url} className="text-[var(--link)] hover:underline">
                                {need.where.label}
                              </Link>
                            ) : (
                              <a
                                href={need.where.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--link)] hover:underline"
                              >
                                {need.where.label} ↗
                              </a>
                            )}
                          </p>
                          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                            {need.steps.map((step, i) => (
                              <li key={i}>{step}</li>
                            ))}
                          </ol>
                          <p className="mt-3 text-sm">
                            <span className="font-medium">Where it goes:</span>{" "}
                            <span className="text-[var(--muted)]">{need.destination}</span>
                          </p>
                        </div>
                      ))}
                  </details>
                );
              })}
          </div>
        </section>
      ))}

      <p className="text-sm text-[var(--muted)]">
        Stuck anywhere? The{" "}
        <Link href="/settings" className="text-[var(--link)] hover:underline">
          Settings page
        </Link>{" "}
        links back to the matching section here whenever something isn&apos;t configured yet.
      </p>
    </div>
  );
}
