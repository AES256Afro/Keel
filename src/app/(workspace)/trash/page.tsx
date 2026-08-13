import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TrashList from "@/components/TrashList";

export default async function TrashPage() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const archived = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      archivedAt: { not: null },
      type: { in: ["document", "database"] },
    },
    orderBy: { archivedAt: "desc" },
    select: { id: true, title: true, icon: true, type: true, archivedAt: true, parentPageId: true },
  });
  // Only show the top of each archived subtree; children restore with their parent.
  const archivedIds = new Set(archived.map((p) => p.id));
  const roots = archived.filter((p) => !p.parentPageId || !archivedIds.has(p.parentPageId));
  return (
    <TrashList
      readOnly={ctx.role === "viewer"}
      items={roots.map((p) => ({
        id: p.id,
        title: p.title || "Untitled",
        icon: p.icon,
        type: p.type,
        archivedAt: p.archivedAt!.toISOString(),
      }))}
    />
  );
}
