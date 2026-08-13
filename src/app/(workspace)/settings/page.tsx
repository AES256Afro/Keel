import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentContext } from "@/lib/auth";
import { backupDirFor, configuredBackupPassphrase, listBackups } from "@/lib/backup";
import { listMembersAndInvites } from "@/lib/members";
import { googleConfigured, microsoftConfigured } from "@/lib/oauth";
import { getAccessSettings } from "@/lib/access";
import { getInstanceClaimStatus } from "@/lib/instance";
import { schemaStatus } from "@/lib/schema-migrate";
import SettingsClient from "@/components/SettingsClient";

const GOOGLE_LINK_RESULTS = new Set([
  "linked",
  "already-linked",
  "cancelled",
  "email-mismatch",
  "conflict",
  "expired",
  "rate-limited",
  "failed",
]);

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ googleLink?: string | string[] }>;
}) {
  const ctx = await getCurrentContext();
  if (!ctx) redirect("/login");
  const rawGoogleLink = (await searchParams).googleLink;
  const googleLinkResult =
    typeof rawGoogleLink === "string" && GOOGLE_LINK_RESULTS.has(rawGoogleLink)
      ? rawGoogleLink
      : null;
  // Where backups live on the server, what they are called, and why the last
  // one failed are facts about the machine, not about the workspace - the
  // resolved directory is an absolute host path, and a failure message carries
  // whatever the filesystem or the cloud provider said. Members do not get
  // them: GET /api/workspace/backups is already requireOwner(), so an editor or
  // viewer who asks for this list over the API is refused, and the
  // server-rendered page handing them the same list unasked was the leak.
  //
  // Backup controls belong to the workspace owner, but the resolved default
  // directory is an absolute host path. A workspace owner can still see and
  // edit a custom directory they configured; only the instance owner needs the
  // machine's resolved default path as an input placeholder.
  const workspaceOwner = ctx.role === "owner";
  const backups = workspaceOwner ? await listBackups(ctx.workspace) : [];
  const { members, invites } = workspaceOwner
    ? await listMembersAndInvites(ctx.workspace.id, ctx.workspace.ownerId)
    : { members: [], invites: [] };
  // Instance-wide controls answer to the server operator, not to every account
  // that owns its own workspace (which is all of them).
  const claimStatus = await getInstanceClaimStatus(ctx.user);
  const instanceOwner = claimStatus.isOwner;
  const [access, googleReady, microsoftReady] = await Promise.all([
    instanceOwner ? getAccessSettings() : Promise.resolve(null),
    googleConfigured(),
    microsoftConfigured(),
  ]);
  const hasConfiguredPassphrase = workspaceOwner
    ? Boolean(await configuredBackupPassphrase())
    : true;
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
        // A configured custom directory belongs to the workspace. The resolved
        // default is machine information and stays instance-owner-only.
        backupDir: workspaceOwner ? ctx.workspace.backupDir : null,
        backupResolvedDir: workspaceOwner && instanceOwner ? backupDirFor(ctx.workspace) : "",
        backupKeep: ctx.workspace.backupKeep,
        backupEncrypt: ctx.workspace.backupEncrypt,
        // When and why the machine last wrote a file, and raw provider text.
        lastBackupAt: workspaceOwner ? ctx.workspace.lastBackupAt?.toISOString() ?? null : null,
        lastBackupError: workspaceOwner ? ctx.workspace.lastBackupError : null,
        // Only availability crosses this server/client boundary. The managed
        // value and any environment override remain write-only host secrets.
        hasScheduledPassphrase: hasConfiguredPassphrase,
      }}
      account={{
        username: ctx.user.username ?? ctx.user.email.split("@")[0],
        email: ctx.user.email,
        googleLinked: Boolean(ctx.user.googleId),
        googleLinkResult,
      }}
      isInstanceOwner={instanceOwner}
      claimRequired={claimStatus.required}
      theme={theme}
      hasPassword={Boolean(ctx.user.passwordHash)}
      backups={backups}
      members={members}
      invites={invites}
      cloud={{
        provider: ctx.workspace.cloudProvider,
        email: ctx.workspace.cloudEmail,
        googleReady,
        microsoftReady,
      }}
      oneNote={{
        connected: Boolean(ctx.workspace.oneNoteRefreshToken),
        email: ctx.workspace.oneNoteEmail,
        enabled: ctx.workspace.oneNoteEnabled,
        lastSyncAt: ctx.workspace.oneNoteLastSyncAt?.toISOString() ?? null,
        lastError: ctx.workspace.oneNoteLastError,
        microsoftReady,
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
              allowedEmailsLocked: access.allowedEmailsLocked,
              signupLocked: access.signupLocked,
              envLocked: access.envLocked,
              ownerEmail: ctx.user.email,
            }
          : null
      }
    />
  );
}
