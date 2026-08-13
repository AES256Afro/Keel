import { prisma } from "@/lib/prisma";
import { toJson } from "@/lib/json";
import { documentToPlainText } from "@/lib/plaintext";

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
const WELCOME_PLAIN_TEXT = documentToPlainText(WELCOME_DOC);

function prismaErrorTargets(err: unknown, field: string) {
  if (typeof err !== "object" || err === null || (err as { code?: string }).code !== "P2002") {
    return false;
  }
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target)
    ? target.some((part) => String(part).includes(field))
    : String(target ?? "").includes(field);
}

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
 * Create a user with their own workspace and welcome page. Pending invites are
 * converted only when the caller has verified control of the email address.
 * A password registration has no mailbox proof and must pass false; Google may
 * pass true only after its userinfo response says verified_email is true.
 */
export async function provisionUser(opts: {
  name: string;
  email: string;
  emailVerified: boolean;
  passwordHash?: string | null;
  googleId?: string | null;
}) {
  // Every write belongs to one transaction. If page creation or invite
  // conversion fails, no half-created account remains to block a retry.
  //
  // Retry the WHOLE transaction, not just user.create(): after a unique
  // violation PostgreSQL marks the current transaction as aborted. The same
  // outer retry also handles serialisation/deadlock conflicts (P2034).
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = await generateUsername(opts.email, attempt);
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: opts.name,
            email: opts.email,
            username,
            passwordHash: opts.passwordHash ?? null,
            googleId: opts.googleId ?? null,
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            name: `${opts.name}'s Workspace`,
            ownerId: user.id,
            members: { create: { userId: user.id, role: "owner" } },
          },
        });
        // This is the first page in a brand-new workspace, so its sort order is
        // known. Creating it through tx keeps the complete account atomic.
        await tx.page.create({
          data: {
            workspaceId: workspace.id,
            parentPageId: null,
            type: "document",
            title: "Getting started",
            icon: "👋",
            content: WELCOME_DOC,
            plainText: WELCOME_PLAIN_TEXT,
            sortOrder: 1,
            createdById: user.id,
            editedById: user.id,
          },
        });

        if (opts.emailVerified) {
          const invites = await tx.workspaceInvite.findMany({ where: { email: opts.email } });
          for (const invite of invites) {
            // A stale invite can coexist with a membership after an older race.
            // Upsert is a no-op for that membership without poisoning a
            // PostgreSQL transaction with a caught unique-constraint error.
            await tx.workspaceMember.upsert({
              where: {
                workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id },
              },
              create: { workspaceId: invite.workspaceId, userId: user.id, role: invite.role },
              update: {},
            });
          }
          if (invites.length > 0) {
            await tx.workspaceInvite.deleteMany({ where: { email: opts.email } });
          }
        }

        return user;
      });
    } catch (err) {
      const retryableConflict =
        prismaErrorTargets(err, "username") ||
        (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2034");
      if (retryableConflict && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a unique username - please try again.");
}
