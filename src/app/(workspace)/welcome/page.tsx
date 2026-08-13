import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentContext } from "@/lib/auth";
import { backupRoot } from "@/lib/backup";
import { getBackupPassphraseStatus } from "@/lib/instance-settings";
import { attachmentQuotaBytes, maxAttachmentBytes } from "@/lib/attachments";
import { googleConfigured, microsoftConfigured } from "@/lib/oauth";
import { getInstanceClaimStatus } from "@/lib/instance";
import WelcomeActions from "@/components/WelcomeActions";
import InstanceClaimInstructions from "@/components/InstanceClaimInstructions";

export const dynamic = "force-dynamic";

/**
 * First run. Signing in was the whole price of admission - this page exists to
 * answer the three questions a new person actually has (where is my stuff,
 * how do I not lose it, what can this thing do), then get out of the way.
 * Every button here is skippable and nothing on it is a gate.
 */
export default async function WelcomePage() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const claimStatus = await getInstanceClaimStatus(ctx.user);
  const [googleReady, microsoftReady, backupPassphrase] = await Promise.all([
    googleConfigured(),
    microsoftConfigured(),
    getBackupPassphraseStatus(),
  ]);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";

  const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const dbLocation = dbUrl.startsWith("file:") ? dbUrl.slice(5) : "your PostgreSQL server";
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

  const backupChoices = [
    {
      key: "backup-local",
      title: "Local snapshots",
      line: backupPassphrase.configured
        ? "Works right now with a server-side encryption passphrase."
        : "Works right now. Set a server-side passphrase before storing real backups.",
      ready: true,
    },
    {
      key: "backup-gdrive",
      title: "Google Drive",
      line: googleReady
        ? "One click to connect - the server is already configured for Google."
        : "Needs the free Google credential first (about five minutes).",
      ready: ctx.workspace.cloudProvider === "google",
    },
    {
      key: "backup-onedrive",
      title: "OneDrive",
      line: microsoftReady
        ? "One click to connect - the server is already configured for Microsoft."
        : "Needs the free Microsoft registration first (about five minutes).",
      ready: ctx.workspace.cloudProvider === "onedrive",
    },
    {
      key: "backup-azure",
      title: "Azure Blob Storage",
      line: "Paste one link from the Azure portal - no app registration at all.",
      ready: ctx.workspace.cloudProvider === "azure",
    },
    {
      key: "backup-r2",
      title: "Cloudflare R2",
      line: "S3-style bucket with a generous free tier.",
      ready: ctx.workspace.cloudProvider === "r2",
    },
  ];

  return (
    <div className="mx-auto max-w-2xl px-8 py-12">
      <h1 className="mb-2 text-3xl font-bold">Welcome to Keel 👋</h1>
      <p className="mb-10 text-[var(--muted)]">
        You&apos;re in and can start writing now. Two minutes here answers the questions worth
        asking on day one, and all of it lives in{" "}
        <Link href="/setup" className="text-[var(--link)] hover:underline">
          ✳ Setup
        </Link>{" "}
        whenever you want it later.
      </p>

      {claimStatus.required && (
        <div className="mb-8">
          <InstanceClaimInstructions
            heading="Next: claim this server"
          />
        </div>
      )}

      <section className="mb-8 rounded-lg border border-[var(--border)] p-5">
        <h2 className="mb-2 text-lg font-semibold">1 · Where your notes actually live</h2>
        <p className="mb-3 text-sm text-[var(--muted)]">
          No mystery cloud: everything you write on <code>{host}</code> is stored in one
          database
          {dbUrl.startsWith("file:") ? (
            claimStatus.isOwner ? (
              <>
                {" "}
                file at <code className="rounded bg-[var(--hover)] px-1">{dbLocation}</code>
              </>
            ) : (
              <> in this server&apos;s local Keel storage</>
            )
          ) : (
            <> on {dbLocation}</>
          )}
          . Images you paste (screenshots welcome - up to {mb(maxAttachmentBytes())} each,{" "}
          {mb(attachmentQuotaBytes())} in total) go into that same database, so one file is
          truly everything. Local snapshots land in{" "}
          {claimStatus.isOwner ? (
            <code className="rounded bg-[var(--hover)] px-1">{backupRoot()}</code>
          ) : (
            "the backup folder configured on this server"
          )}
          .
        </p>
        {!backupPassphrase.configured && (
          <p className="text-sm text-[var(--danger)]">
            {backupPassphrase.source === "managed"
              ? "The saved snapshot passphrase cannot be decrypted. "
              : "Snapshots are currently unencrypted. "}
            The{" "}
            <Link href="/setup#backup-local" className="underline">
              setup guide
            </Link>{" "}
            shows how the instance owner can save a write-only passphrase in Settings or
            use a locked host environment override.
          </p>
        )}
      </section>

      <section className="mb-8 rounded-lg border border-[var(--border)] p-5">
        <h2 className="mb-2 text-lg font-semibold">2 · Pick a safety net</h2>
        <p className="mb-4 text-sm text-[var(--muted)]">
          Local snapshots alone die with the machine. Pick one off-machine home for your
          backups - each card links to a hold-your-hand walkthrough of exactly what to
          click and where every value goes.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {backupChoices.map((c) => (
            <Link
              key={c.key}
              href={`/setup#${c.key}`}
              className="rounded border border-[var(--border-soft)] p-3 hover:bg-[var(--hover)]"
            >
              <p className="text-sm font-medium">
                {c.ready ? "✓ " : ""}
                {c.title}
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">{c.line}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mb-10 rounded-lg border border-[var(--border)] p-5">
        <h2 className="mb-2 text-lg font-semibold">3 · The five things worth knowing</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-[var(--muted)]">
          <li>
            Type <code className="rounded bg-[var(--hover)] px-1">[[</code> in any page to
            link to another - the ◍ Graph in the sidebar draws the map that emerges.
          </li>
          <li>
            Type <code className="rounded bg-[var(--hover)] px-1">/</code> for blocks:
            headings, task lists, code, quotes.
          </li>
          <li>Paste a screenshot straight into a page - it uploads and stays with that page.</li>
          <li>
            📅 Today opens a daily note; 📖 Read turns any page and its children into one
            continuous scroll.
          </li>
          <li>
            ◫ Side by side edits two documents at once - drag the divider to taste.
          </li>
        </ul>
      </section>

      <WelcomeActions />
    </div>
  );
}
