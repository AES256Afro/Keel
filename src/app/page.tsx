import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createDocumentPage } from "@/lib/pages";

export default async function Home() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  // First sign-in: land on the welcome tour once. Only this route redirects -
  // deep links (a shared /p/... URL, /settings) always work untouched, because
  // signing in is the only real gate this app has.
  if (!ctx.user.onboardedAt) redirect("/welcome");
  const firstPage = await prisma.page.findFirst({
    where: {
      workspaceId: ctx.workspace.id,
      archivedAt: null,
      parentPageId: null,
      type: { in: ["document", "database"] },
    },
    orderBy: { sortOrder: "asc" },
  });
  if (firstPage) redirect(`/p/${firstPage.id}`);
  // Empty workspace (e.g. everything was trashed): give the user a page to land on.
  const page = await createDocumentPage({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
  });
  redirect(`/p/${page.id}`);
}
