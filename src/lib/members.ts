import { prisma } from "@/lib/prisma";

export async function listMembersAndInvites(workspaceId: string, ownerId: string) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  const invites = await prisma.workspaceInvite.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
  return {
    members: members.map((m) => ({
      id: m.id,
      username: m.user.username ?? m.user.email.split("@")[0],
      email: m.user.email,
      role: m.role,
      isOwner: m.userId === ownerId,
    })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role })),
  };
}
