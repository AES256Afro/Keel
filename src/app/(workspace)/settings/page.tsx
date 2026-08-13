import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentContext } from "@/lib/auth";
import { backupDirFor, envBackupPassphrase, listBackups } from "@/lib/backup";
import { listMembersAndInvites } from "@/lib/members";
import { googleConfigured, microsoftConfigured } from "@/lib/oauth";
import { getAccessSettings } from "@/lib/access";
import { isInstanceOwner } from "@/lib/instance";
import { schemaStatus } from "@/lib/schema-migrate";
import SettingsClient from "@/components/SettingsClient";

export default async function SettingsPage() {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  // Where backups live on the server, what they are called, and why the last
  // one failed are facts about the machine, not about the workspace - the
  // resolved directory is an absolute host path, and a failure message carries
  // whatever the filesystem or the cloud provider said. Members do not get
  // them: GET /api/workspace/backups is already requireOwner(), so an editor or
  // viewer who asks for this list over the API is refused, and the
  // server-rendered page handing them the same list unasked was the leak.
  //
  // The line is the workspace owner rather than the instance owner (as it is
  // for the access and schema panels) because backups are a workspace-owner
  // capability all the way down: they configure the folder, "Back up now"
  // answers them with the absolute file path it wrote, and Restore is theirs.
  // Gating the path any tighter would leave a non-instance-owner owner with a
  // blank folder field whose Save silently clears their configured folder.
  const workspaceOwner = ctx.role === "owner";
  const backups = workspaceOwner ? await listBackups(ctx.workspace) : [];
  const { members, invites } = workspaceOwner
    ? await listMembersAndInvites(ctx.workspace.id, ctx.workspace.ownerId)
    : { members: [], invites: [] };
  // Instance-wide controls answer to the server operator, not to every account
  // that owns its own workspace (which is all of them).
  const instanceOwner = await isInstanceOwner(ctx.user);
  const access = instanceOwner ? await getAccessSettings() : null;
  // Same cookie the root layout renders onto <html>; passing it down means the
  // theme picker highlights the right button in the first paint.
  const themeCookie = (await cookies()).get("keel-theme")?.value;
  const theme = themeCookie === "dark" || themeCookie === "light" ? themeCookie : "system";
  return (
    <SettingsClient
      workspace={{
        name: ctx.workspace.name,
        role: ctx.role,
        backupEnabled: ctx.workspace.backupEnabled,
        backupIntervalHours: ctx.workspace.backupIntervalHours,
        // Host filesystem layout, both of them - see the note above.
        backupDir: workspaceOwner ? ctx.workspace.backupDir : null,
        backupResolvedDir: workspaceOwner ? backupDirFor(ctx.workspace) : "",
        backupKeep: ctx.workspace.backupKeep,
        backupEncrypt: ctx.workspace.backupEncrypt,
        // When and why the machine last wrote a file, and raw provider text.
        lastBackupAt: workspaceOwner ? ctx.workspace.lastBackupAt?.toISOString() ?? null : null,
        lastBackupError: workspaceOwner ? ctx.workspace.lastBackupError : null,
        // Whether the server has a backup passphrase in its env. False renders an
        // instruction to edit the server's .env, which is the operator's
        // business and no one else's; true is the branch that renders nothing,
        // and the prop's only other use ("Back up now" prompting for a
        // passphrase) belongs to an action members cannot take anyway.
        hasEnvPassphrase: workspaceOwner ? Boolean(envBackupPassphrase()) : true,
      }}
      account={{ username: ctx.user.username ?? ctx.user.email.split("@")[0] }}
      isInstanceOwner={instanceOwner}
      theme={theme}
      hasPassword={Boolean(ctx.user.passwordHash)}
      backups={backups}
      members={members}
      invites={invites}
      cloud={{
        provider: ctx.workspace.cloudProvider,
        email: ctx.workspace.cloudEmail,
        googleReady: googleConfigured(),
        microsoftReady: microsoftConfigured(),
      }}
      oneNote={{
        connected: Boolean(ctx.workspace.oneNoteRefreshToken),
        email: ctx.workspace.oneNoteEmail,
        enabled: ctx.workspace.oneNoteEnabled,
        lastSyncAt: ctx.workspace.oneNoteLastSyncAt?.toISOString() ?? null,
        lastError: ctx.workspace.oneNoteLastError,
        microsoftReady: microsoftConfigured(),
      }}
      // Operator information, not workspace information: a stale or unverified
      // schema is a property of the install. Owner-only for the same reason
      // the access controls are - and never on /api/health, which answers
      // anonymous callers.
      schema={instanceOwner ? schemaStatus() : null}
      access={
        access
          ? {
              allowedEmails: access.allowedEmails,
              signupDisabled: access.signupDisabled,
              envLocked: access.envLocked,
              ownerEmail: ctx.user.email,
            }
          : null
      }
    />
  );
}
