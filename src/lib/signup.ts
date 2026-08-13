import { prisma } from "@/lib/prisma";
import { createDocumentPage } from "@/lib/pages";
import { toJson } from "@/lib/json";

const WELCOME_DOC = toJson({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Welcome to Keel 👋" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "This page is a block editor. Type " },
        { type: "text", marks: [{ type: "code" }], text: "/" },
        { type: "text", text: " to insert a block, or use Markdown shortcuts like " },
        { type: "text", marks: [{ type: "code" }], text: "#" },
        { type: "text", text: ", " },
        { type: "text", marks: [{ type: "code" }], text: "-" },
        { type: "text", text: " and " },
        { type: "text", marks: [{ type: "code" }], text: "[]" },
        { type: "text", text: "." },
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Create a page from the sidebar" }] }],
        },
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Add a database and try the table, list and board views" }] }],
        },
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Press Ctrl/⌘+K to search your workspace" }] }],
        },
      ],
    },
  ],
});

/**
 * A username derived from the email, unique among existing accounts.
 *
 * Best-effort only: username is unique in the database now, so the create
 * below is the real arbiter and retries on collision. This just picks a nice
 * candidate in one query instead of a query per attempt.
 */
async function generateUsername(email: string, attempt = 0) {
  const base =
    email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "user";
  const candidate = base.length >= 3 ? base : `${base}user`;
  if (attempt > 0) return `${candidate}${Math.floor(1000 + Math.random() * 9000)}`;
  const taken = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
  return taken ? `${candidate}${Math.floor(1000 + Math.random() * 9000)}` : candidate;
}

/**
 * Create a user with their own workspace and welcome page, and convert any
 * pending workspace invites for this email into memberships. Used by both
 * password registration and Google sign-in.
 */
export async function provisionUser(opts: {
  name: string;
  email: string;
  passwordHash?: string | null;
  googleId?: string | null;
}) {
  // Retry on a username collision: two people registering at the same instant
  // with the same email prefix is rare but possible, and the database now
  // rejects it rather than silently allowing a duplicate.
  let user: Awaited<ReturnType<typeof prisma.user.create>> | null = null;
  for (let attempt = 0; attempt < 5 && !user; attempt++) {
    try {
      user = await prisma.user.create({
        data: {
          name: opts.name,
          email: opts.email,
          username: await generateUsername(opts.email, attempt),
          passwordHash: opts.passwordHash ?? null,
          googleId: opts.googleId ?? null,
        },
      });
    } catch (err) {
      const target = (err as { code?: string; meta?: { target?: unknown } })?.meta?.target;
      const onUsername = Array.isArray(target)
        ? target.includes("username")
        : String(target ?? "").includes("username");
      // Only a username clash is retryable - a duplicate email means the caller
      // checked and lost a race, and must see that error.
      if ((err as { code?: string })?.code === "P2002" && onUsername) continue;
      throw err;
    }
  }
  if (!user) throw new Error("Could not allocate a unique username - please try again.");
  const workspace = await prisma.workspace.create({
    data: {
      name: `${opts.name}'s Workspace`,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  await createDocumentPage({
    workspaceId: workspace.id,
    userId: user.id,
    title: "Getting started",
    icon: "👋",
    content: WELCOME_DOC,
  });

  const invites = await prisma.workspaceInvite.findMany({ where: { email: opts.email } });
  for (const invite of invites) {
    await prisma.workspaceMember
      .create({
        data: { workspaceId: invite.workspaceId, userId: user.id, role: invite.role },
      })
      .catch(() => {});
  }
  if (invites.length > 0) {
    await prisma.workspaceInvite.deleteMany({ where: { email: opts.email } });
  }

  return user;
}
