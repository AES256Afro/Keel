import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import GraphView from "@/components/GraphView";

export const dynamic = "force-dynamic";

/**
 * The workspace seen from above - every page and every link between them.
 *
 * The data comes from /api/graph rather than being rendered on the server: the
 * layout is a physics simulation that runs in the browser, so there is nothing
 * useful to send pre-arranged.
 */
export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");

  const { tag } = await searchParams;

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <h1 className="mb-1 text-2xl font-bold">◍ Graph</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Every page, and every <code className="rounded bg-[var(--hover)] px-1">[[link]]</code>{" "}
        between them. Bigger circles are linked to more often.
      </p>
      <GraphView initialTag={tag?.trim().toLowerCase().slice(0, 60) ?? null} />
    </div>
  );
}
