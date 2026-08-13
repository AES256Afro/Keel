import Link from "next/link";

/**
 * The breadcrumb dropped wherever a feature is blocked on something external:
 * one friendly line, then a link into the setup guide's matching section,
 * which holds the full trail. Never repeat instructions inline - one source
 * of truth, or the copies drift.
 */
export default function SetupHint({
  capability,
  children,
}: {
  /** Anchor key in /setup - a Capability.key from setup-guide.ts. */
  capability: string;
  /** The one-line "this needs X" sentence. */
  children: React.ReactNode;
}) {
  return (
    <p className="rounded border border-[var(--border-soft)] bg-[var(--hover)]/40 px-3 py-2 text-sm text-[var(--muted)]">
      {children}{" "}
      <Link href={`/setup#${capability}`} className="whitespace-nowrap text-[var(--link)] hover:underline">
        Step-by-step guide →
      </Link>
    </p>
  );
}
