import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth";
import { getPageTree } from "@/lib/pages";
import { prisma } from "@/lib/prisma";
import Sidebar from "@/components/Sidebar";
import { logout } from "@/app/(auth)/actions";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const [tree, favorites, recents, unreadNotifications] = await Promise.all([
    getPageTree(ctx.workspace.id),
    prisma.favorite.findMany({
      where: { userId: ctx.user.id, page: { workspaceId: ctx.workspace.id, archivedAt: null } },
      include: { page: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.recentVisit.findMany({
      where: { userId: ctx.user.id, page: { workspaceId: ctx.workspace.id, archivedAt: null } },
      include: { page: true },
      orderBy: { visitedAt: "desc" },
      take: 5,
    }),
    prisma.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
  ]);
  // Only the username is ever sent to the workspace UI  -  not the real name.
  const username = ctx.user.username ?? ctx.user.email.split("@")[0];
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        needsBackupSetup={!ctx.workspace.cloudProvider}
        workspaceId={ctx.workspace.id}
        workspaceName={ctx.workspace.name}
        role={ctx.role}
        memberships={ctx.memberships}
        username={username}
        tree={tree}
        favorites={favorites.map((f) => ({
          id: f.page.id,
          title: f.page.title,
          icon: f.page.icon,
          type: f.page.type,
        }))}
        recents={recents.map((r) => ({
          id: r.page.id,
          title: r.page.title,
          icon: r.page.icon,
          type: r.page.type,
        }))}
        unreadNotifications={unreadNotifications}
        logoutAction={logout}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
