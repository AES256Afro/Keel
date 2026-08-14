"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import ThemeSelect, { type Theme } from "@/components/ThemeSelect";
import SetupHint from "@/components/SetupHint";
import InstanceClaimInstructions from "@/components/InstanceClaimInstructions";
import OperatorSettingsPanel from "@/components/OperatorSettingsPanel";
import { isEncryptedBackupName } from "@/lib/backup-format";

interface WorkspaceSettings {
  name: string;
  role: string;
  backupEnabled: boolean;
  backupIntervalHours: number;
  backupDir: string | null;
  backupResolvedDir: string;
  backupKeep: number;
  backupEncrypt: boolean;
  trashRetentionDays: number;
  lastBackupAt: string | null;
  lastBackupError: string | null;
  hasScheduledPassphrase: boolean;
}

/** Modal passphrase prompt with a masked (password) input - window.prompt shows
 *  what you type, so it must never be used for secrets. */
function PassphraseDialog({
  title,
  onDone,
}: {
  title: string;
  onDone: (passphrase: string | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[20vh]"
      onMouseDown={() => onDone(null)}
    >
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onDone(value);
        }}
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-2xl p-4"
      >
        <h3 className="text-sm font-medium mb-2">{title}</h3>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone(null)}
          placeholder="Passphrase"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(null)}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value}
            className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-1.5 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
          >
            OK
          </button>
        </div>
      </form>
    </div>
  );
}

interface BackupFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface MemberDTO {
  id: string;
  username: string;
  email: string;
  role: string;
  isOwner: boolean;
}

export interface InviteDTO {
  id: string;
  email: string;
  role: string;
}

export interface CloudStatus {
  provider: string | null; // google | onedrive | null
  email: string | null;
  googleReady: boolean;
  microsoftReady: boolean;
}

export interface AccessSettingsDTO {
  allowedEmails: string[];
  signupDisabled: boolean;
  allowedEmailsLocked: boolean;
  signupLocked: boolean;
  envLocked: boolean;
  ownerEmail: string;
}

interface AuditEntry {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

interface SessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

interface CloudFile {
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      <div className="rounded-lg border border-[var(--border)] p-4 space-y-4">{children}</div>
    </section>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type OAuthProviderName = "google" | "microsoft";
type OAuthProviderState = {
  provider: OAuthProviderName;
  configured: boolean;
  status:
    | "verified"
    | "configured-not-verified"
    | "not-configured"
    | "incomplete"
    | "unavailable";
  source: "environment" | "managed" | "none";
  locked: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  verified: boolean;
  verifiedAt: string | null;
  callbacks: Record<string, string>;
  testPaths: Record<string, string>;
};

const OAUTH_COPY: Record<
  OAuthProviderName,
  {
    title: string;
    purpose: string;
    callbackLabels: Record<string, string>;
    testLabels: Record<string, string>;
    impact: string;
    verificationNote: string;
  }
> = {
  google: {
    title: "Google",
    purpose: "Google sign-in and Google Drive backups",
    callbackLabels: {
      signIn: "Sign-in callback",
      accountLink: "Account-link callback",
      cloud: "Drive callback",
    },
    testLabels: { cloud: "Connect Google Drive" },
    impact: "Google sign-in and Google Drive connections may need to be authorized again.",
    verificationNote:
      "Connect Google Drive here to verify the credential without changing your signed-in account. To test Google sign-in, first confirm password sign-in still works, then use a separate private or incognito window.",
  },
  microsoft: {
    title: "Microsoft",
    purpose: "OneDrive backups and the read-only OneNote mirror",
    callbackLabels: { cloud: "OneDrive callback", oneNote: "OneNote callback" },
    testLabels: { cloud: "Connect OneDrive", oneNote: "Connect OneNote" },
    impact: "OneDrive and OneNote connections may need to be authorized again.",
    verificationNote:
      "Connect OneDrive or OneNote to verify the credential within this signed-in workspace.",
  },
};

function OAuthIntegrations() {
  const router = useRouter();
  const [providers, setProviders] = useState<Record<OAuthProviderName, OAuthProviderState> | null>(
    null
  );
  const [drafts, setDrafts] = useState<
    Record<OAuthProviderName, { clientId: string; clientSecret: string }>
  >({
    google: { clientId: "", clientSecret: "" },
    microsoft: { clientId: "", clientSecret: "" },
  });
  const [working, setWorking] = useState<OAuthProviderName | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/instance/oauth-settings", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Could not load OAuth settings");
        if (active) {
          setProviders(data.providers);
          setLoadFailed(false);
        }
      })
      .catch((cause) => {
        if (!active) return;
        setLoadFailed(true);
        setNotice({
          kind: "error",
          text: cause instanceof Error ? cause.message : "Could not load OAuth settings",
        });
      });
    return () => {
      active = false;
    };
  }, []);

  const patchProvider = (provider: OAuthProviderName, next: OAuthProviderState) => {
    setProviders((current) => (current ? { ...current, [provider]: next } : current));
    setDrafts((current) => ({
      ...current,
      [provider]: { clientId: "", clientSecret: "" },
    }));
    router.refresh();
  };

  const save = async (provider: OAuthProviderName) => {
    const current = providers?.[provider];
    if (!current || current.locked) return;
    const clientId = drafts[provider].clientId.trim();
    const clientSecret = drafts[provider].clientSecret.trim();
    if (!clientId && !clientSecret) {
      setNotice({ kind: "error", text: "Enter a client ID or a replacement secret first." });
      return;
    }
    const replacesSavedValue =
      current.status === "unavailable" ||
      (Boolean(clientId) && current.clientIdConfigured) ||
      (Boolean(clientSecret) && current.clientSecretConfigured);
    if (
      replacesSavedValue &&
      !confirm(
        `Replace the saved ${OAUTH_COPY[provider].title} credential? ${OAUTH_COPY[provider].impact}`
      )
    ) {
      return;
    }
    setWorking(provider);
    setNotice(null);
    try {
      const response = await fetch("/api/instance/oauth-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          action: "save",
          ...(clientId ? { clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not save OAuth settings");
      patchProvider(provider, data.provider);
      setNotice({
        kind: "ok",
        text: `${OAUTH_COPY[provider].title} credentials saved. They are not verified until an OAuth flow completes successfully.`,
      });
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not save OAuth settings",
      });
    } finally {
      setWorking(null);
    }
  };

  const clear = async (provider: OAuthProviderName) => {
    const current = providers?.[provider];
    if (!current || current.locked) return;
    if (
      !confirm(
        `Clear the managed ${OAUTH_COPY[provider].title} credential? ${OAUTH_COPY[provider].impact}`
      )
    ) {
      return;
    }
    setWorking(provider);
    setNotice(null);
    try {
      const response = await fetch("/api/instance/oauth-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, action: "clear", confirm: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not clear OAuth settings");
      patchProvider(provider, data.provider);
      setNotice({ kind: "ok", text: `${OAUTH_COPY[provider].title} credentials cleared.` });
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not clear OAuth settings",
      });
    } finally {
      setWorking(null);
    }
  };

  const copyCallback = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setNotice({
        kind: "error",
        text: "Copy was blocked by the browser. Select the callback URL and copy it manually.",
      });
    }
  };

  const statusText = (provider: OAuthProviderState) => {
    if (provider.status === "verified") return "Verified";
    if (provider.status === "configured-not-verified") return "Saved, not verified";
    if (provider.status === "incomplete") return "Incomplete credential";
    if (provider.status === "unavailable") return "Managed secrets unavailable";
    return "Not configured";
  };

  return (
    <Section title="Integrations">
      <div>
        <p className="text-sm text-[var(--muted)]">
          Configure the OAuth apps used by this whole Keel server. A saved secret is
          write-only: Keel never sends it back to the browser or puts it in the activity
          log. Managed secrets are encrypted using a host key kept outside the database.
        </p>
        <p className="mt-1 text-xs text-[var(--faint)]">
          Saving applies to new sign-in and connection attempts immediately. It confirms
          only that both values are present. Complete one of the test flows below to prove
          the provider accepts them.
        </p>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
              : "border-[var(--border)] bg-[var(--panel)]"
          }`}
        >
          {notice.text}
        </p>
      )}

      {!providers ? (
        <p className="text-sm text-[var(--faint)]">
          {loadFailed
            ? "Integration settings are unavailable. Reload this page to try again."
            : "Loading integration settings..."}
        </p>
      ) : (
        (["google", "microsoft"] as const).map((name) => {
          const provider = providers[name];
          const meta = OAUTH_COPY[name];
          const draft = drafts[name];
          const busyProvider = working === name;
          const needsClientId =
            provider.status === "unavailable" || !provider.clientIdConfigured;
          const needsClientSecret =
            provider.status === "unavailable" || !provider.clientSecretConfigured;
          const clientIdEntered = Boolean(draft.clientId.trim());
          const clientSecretEntered = Boolean(draft.clientSecret.trim());
          const hasChanges = clientIdEntered || clientSecretEntered;
          const canSave =
            hasChanges &&
            (!needsClientId || clientIdEntered) &&
            (!needsClientSecret || clientSecretEntered);
          const replacesSavedValue =
            provider.status === "unavailable" ||
            (clientIdEntered && provider.clientIdConfigured) ||
            (clientSecretEntered && provider.clientSecretConfigured);
          return (
            <div key={name} className="rounded border border-[var(--border-soft)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-medium">{meta.title}</h3>
                  <p className="text-xs text-[var(--muted)]">{meta.purpose}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    provider.status === "verified"
                      ? "bg-[var(--success-bg,#e6f4ea)] text-[var(--success,#137333)]"
                      : provider.status === "incomplete" || provider.status === "unavailable"
                        ? "bg-[var(--danger-bg)] text-[var(--danger)]"
                        : "bg-[var(--hover)] text-[var(--muted)]"
                  }`}
                >
                  {statusText(provider)}
                </span>
              </div>

              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-[var(--muted)]">
                  Add these exact callback URLs to the provider&apos;s web application:
                </p>
                {Object.entries(provider.callbacks).map(([callbackName, callback]) => {
                  const copyKey = `${name}:${callbackName}`;
                  return (
                    <div key={callbackName}>
                      <p className="mb-1 text-xs text-[var(--faint)]">
                        {meta.callbackLabels[callbackName] ?? callbackName}
                      </p>
                      <div className="flex items-stretch gap-2">
                        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-[var(--border)] bg-[var(--hover)] px-3 py-2 text-xs">
                          {callback}
                        </code>
                        <button
                          type="button"
                          aria-label={`Copy ${meta.title} ${meta.callbackLabels[callbackName] ?? callbackName}`}
                          onClick={() => copyCallback(copyKey, callback)}
                          className="rounded border border-[var(--border)] px-3 text-xs hover:bg-[var(--hover)]"
                        >
                          {copied === copyKey ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {provider.locked ? (
                <p className="mt-3 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">
                  🔒 This provider is controlled by server environment variables. Its
                  credential cannot be viewed or changed in the browser.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs text-[var(--muted)]">
                      Client ID
                      <input
                        aria-label={`${meta.title} client ID`}
                        value={draft.clientId}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [name]: { ...current[name], clientId: event.target.value },
                          }))
                        }
                        autoComplete="off"
                        placeholder={
                          provider.clientIdConfigured
                            ? "Saved. Enter only to replace"
                            : "Paste the client ID"
                        }
                        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>
                    <label className="block text-xs text-[var(--muted)]">
                      Client secret
                      <input
                        aria-label={`${meta.title} client secret`}
                        type="password"
                        value={draft.clientSecret}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [name]: { ...current[name], clientSecret: event.target.value },
                          }))
                        }
                        autoComplete="new-password"
                        placeholder={
                          provider.clientSecretConfigured
                            ? "Saved. Enter only to replace"
                            : "Paste the client secret"
                        }
                        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>
                  </div>
                  <p className="text-xs text-[var(--faint)]">
                    Blank fields keep an existing managed value. Saved secrets are never
                    filled back into this form.
                  </p>
                  {(needsClientId || needsClientSecret) && (
                    <p className="text-xs text-[var(--muted)]">
                      {provider.status === "unavailable"
                        ? "The saved credential cannot be decrypted. Enter both values to replace and repair it."
                        : needsClientId && needsClientSecret
                          ? "Enter both values for the first save."
                          : `Enter the missing ${needsClientId ? "client ID" : "client secret"} to complete this credential.`}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => save(name)}
                      disabled={busyProvider || !canSave}
                      className="rounded bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)] hover:bg-[var(--btn-hover)] disabled:opacity-50"
                    >
                      {busyProvider
                        ? "Saving..."
                        : replacesSavedValue
                          ? "Save replacement"
                          : provider.clientIdConfigured || provider.clientSecretConfigured
                            ? "Complete credential"
                            : "Save credential"}
                    </button>
                    {provider.source === "managed" && (
                      <button
                        type="button"
                        onClick={() => clear(name)}
                        disabled={busyProvider}
                        className="rounded border border-[var(--danger-border)] px-3 py-2 text-sm text-[var(--danger)] hover:bg-[var(--danger-bg)] disabled:opacity-50"
                      >
                        Clear managed credential
                      </button>
                    )}
                  </div>
                </div>
              )}

              {provider.configured && (
                <div className="mt-4 border-t border-[var(--border-soft)] pt-3">
                  <p className="text-xs text-[var(--muted)]">
                    {provider.verified
                      ? `Verified by a successful provider authorization${provider.verifiedAt ? ` on ${new Date(provider.verifiedAt).toLocaleString()}` : ""}. Run a connection flow again whenever you want to recheck it.`
                      : meta.verificationNote}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(provider.testPaths).map(([testName, testPath]) => (
                      <a
                        key={testName}
                        href={testPath}
                        className="rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--hover)]"
                      >
                        {meta.testLabels[testName] ?? `Test ${testName}`}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}

      <p className="border-t border-[var(--border-soft)] pt-3 text-xs text-[var(--faint)]">
        Database location, host storage roots, network binding, reverse-proxy trust,
        cookie and WebAuthn identity, and service supervision remain terminal-only. A
        browser mistake in those settings could disconnect Keel or weaken a host security
        boundary.
      </p>
    </Section>
  );
}

export interface OneNoteStatus {
  connected: boolean;
  email: string | null;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  microsoftReady: boolean;
}

function formatUptime(total: number): string {
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

/** What a restore chose not to bring in - RestoreReport.skippedAttachments. */
interface SkippedAttachments {
  empty: number;
  tooLarge: number;
}

/**
 * A sentence for the attachments a restore left behind, or "" when it was clean.
 *
 * The restore path deliberately skips rows it can't or won't write (bytes that
 * won't decode, files over the per-file cap) and counts them for the caller to
 * report. Reporting them is the whole point: pages that come back while their
 * images quietly don't is the exact failure the restore is supposed to prevent,
 * and "Restored 12 top-level page(s)" on its own reads like a clean success.
 */
function skippedNote(skipped: unknown): string {
  const s = skipped as Partial<SkippedAttachments> | null | undefined;
  const empty = Number(s?.empty) || 0;
  const tooLarge = Number(s?.tooLarge) || 0;
  const total = empty + tooLarge;
  if (total <= 0) return "";
  const reasons: string[] = [];
  if (tooLarge > 0) {
    reasons.push(`${tooLarge} over this server's per-file limit (KEEL_MAX_ATTACHMENT_MB)`);
  }
  if (empty > 0) reasons.push(`${empty} whose stored bytes could not be read`);
  return ` ⚠ ${total} attachment(s) were NOT restored: ${reasons.join("; ")}.`;
}

export default function SettingsClient({
  workspace,
  account,
  backups: initialBackups,
  members: initialMembers,
  invites: initialInvites,
  cloud,
  oneNote,
  access,
  schema = null,
  isInstanceOwner = false,
  claimRequired = false,
  theme = "system",
  hasPassword = true,
}: {
  workspace: WorkspaceSettings;
  account: {
    username: string;
    email: string;
    googleLinked: boolean;
    googleLinkResult: string | null;
  };
  backups: BackupFile[];
  members: MemberDTO[];
  invites: InviteDTO[];
  cloud: CloudStatus;
  oneNote: OneNoteStatus;
  access: AccessSettingsDTO | null;
  /** The self-migrator's last decision. Owner-only; null otherwise. */
  schema?: { state: "current" | "deferred" | "unverified" | "failed"; detail: string; at: string } | null;
  /** Runs the server. Gates instance-wide controls (allowlist, tunnel) - which
   *  is NOT the same as owning a workspace, since every account owns one. */
  isInstanceOwner?: boolean;
  /** A global unclaimed state. Commands are generic and reveal no host path. */
  claimRequired?: boolean;
  /** Saved theme, read from the cookie on the server. */
  theme?: Theme;
  /** False for Google-only accounts, which have no password to change. */
  hasPassword?: boolean;
}) {
  const router = useRouter();
  const isOwner = workspace.role === "owner";

  const [name, setName] = useState(workspace.name);
  const [username, setUsername] = useState(account.username);
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [backupEnabled, setBackupEnabled] = useState(workspace.backupEnabled);
  const [intervalHours, setIntervalHours] = useState(workspace.backupIntervalHours);
  const [keep, setKeep] = useState(workspace.backupKeep);
  const [dir, setDir] = useState(workspace.backupDir ?? "");
  const [encrypt, setEncrypt] = useState(workspace.backupEncrypt);
  const [trashRetentionDays, setTrashRetentionDays] = useState(workspace.trashRetentionDays);
  const [backups, setBackups] = useState(initialBackups);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [downloadPassphrase, setDownloadPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [passRequest, setPassRequest] = useState<{
    title: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [cloudFiles, setCloudFiles] = useState<CloudFile[] | null>(null);
  const [allowedEmails, setAllowedEmails] = useState<string[]>(access?.allowedEmails ?? []);
  const [signupDisabled, setSignupDisabled] = useState(access?.signupDisabled ?? false);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEntry[] | null>(null);
  const [googleLinkWorking, setGoogleLinkWorking] = useState(false);

  const googleLinkMessage = (() => {
    switch (account.googleLinkResult) {
      case "linked":
        return {
          kind: "ok" as const,
          text: "Google sign-in is now linked. Your password and security keys are unchanged.",
        };
      case "already-linked":
        return { kind: "ok" as const, text: "Google sign-in was already linked." };
      case "cancelled":
        return { kind: "warn" as const, text: "Google account linking was cancelled." };
      case "email-mismatch":
        return {
          kind: "error" as const,
          text: `Google did not link because its verified email must exactly match ${account.email}. Choose the matching Google account and try again.`,
        };
      case "conflict":
        return {
          kind: "error" as const,
          text: "That Google identity is already linked to another Keel account, or this account already uses a different Google identity.",
        };
      case "expired":
        return {
          kind: "error" as const,
          text: "The secure Google link request expired. Start a new request below.",
        };
      case "rate-limited":
        return {
          kind: "error" as const,
          text: "Too many Google link attempts. Wait a few minutes and try again.",
        };
      case "failed":
        return {
          kind: "error" as const,
          text: "Google account linking could not be completed. Start again from Settings.",
        };
      default:
        return null;
    }
  })();

  const linkGoogleAccount = async () => {
    setGoogleLinkWorking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/google/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.authorizationUrl !== "string") {
        throw new Error(data.error ?? "Could not start Google account linking");
      }
      window.location.assign(data.authorizationUrl);
    } catch (cause) {
      setGoogleLinkWorking(false);
      say(
        "error",
        cause instanceof Error ? cause.message : "Could not start Google account linking"
      );
    }
  };

  const loadSessions = useCallback(() => {
    fetch("/api/account/sessions")
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!isInstanceOwner) return;
    fetch("/api/instance/audit?limit=50")
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d) => setAuditEvents(d.events ?? []))
      .catch(() => setAuditEvents([]));
  }, [isInstanceOwner]);

  const changePassword = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/account/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setCurrentPassword("");
      setNewPassword("");
      say(
        "ok",
        data.endedElsewhere > 0
          ? `Password changed, and ${data.endedElsewhere} other session(s) signed out.`
          : "Password changed."
      );
      loadSessions();
    } else {
      say("error", data.error ?? "Could not change the password");
    }
  };

  const revokeSession = async (id: string) => {
    const res = await fetch(`/api/account/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      setSessions((prev) => (prev ?? []).filter((s) => s.id !== id));
      say("ok", "That session was ended.");
    } else {
      const data = await res.json().catch(() => ({}));
      say("error", data.error ?? "Could not end that session");
    }
  };

  const revokeOtherSessions = async () => {
    if (!confirm("Sign out of every other browser and device?")) return;
    setBusy(true);
    const res = await fetch("/api/account/sessions", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      say("ok", `Signed out of ${data.revoked} other session(s).`);
      loadSessions();
    } else {
      say("error", data.error ?? "Could not sign out elsewhere");
    }
  };

  const addAllowedEmail = () => {
    const e = newEmail.trim().toLowerCase();
    if (!e.includes("@") || allowedEmails.includes(e)) return;
    setAllowedEmails([...allowedEmails, e]);
    setNewEmail("");
  };

  const saveAccess = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/instance/access", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedEmails, signupDisabled }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      const savedAllowed = data.access?.allowedEmails ?? allowedEmails;
      const savedDisabled = data.access?.signupDisabled ?? signupDisabled;
      setAllowedEmails(savedAllowed);
      setSignupDisabled(savedDisabled);
      say(
        "ok",
        savedDisabled
          ? "Registration is closed. Existing accounts can still sign in."
          : savedAllowed.length > 0
            ? "Registration is open only to the listed email addresses."
            : "Registration is open. Anyone who can reach this server may create an account."
      );
    } else {
      say("error", data.error ?? "Could not save access settings");
    }
  };

  useEffect(() => {
    if (!cloud.provider || !isOwner) return;
    fetch("/api/cloud/backups")
      .then((r) => (r.ok ? r.json() : { backups: [] }))
      .then((d) => setCloudFiles(d.backups ?? []))
      .catch(() => setCloudFiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.provider]);

  const say = (kind: "ok" | "warn" | "error", text: string) => setMessage({ kind, text });

  /**
   * Report a restore that succeeded. "warn" rather than "ok" when attachments
   * were dropped: the pages did land, so it isn't an error, but it must not be
   * shown in the same quiet tone as a restore that brought everything back.
   */
  const sayRestored = (text: string, skipped: unknown) => {
    const note = skippedNote(skipped);
    say(note ? "warn" : "ok", `${text}${note}`);
  };

  const [oneNoteStatus, setOneNoteStatus] = useState(oneNote);

  const syncOneNoteNow = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/onenote/sync", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setOneNoteStatus((current) => ({
        ...current,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      }));
      say(
        "ok",
        `OneNote sync complete: ${data.pagesChanged ?? 0} changed, ${data.pagesRemoved ?? 0} removed, ${data.imagesDownloaded ?? 0} new images.`
      );
      router.refresh();
    } else {
      say("error", data.error ?? "OneNote sync failed");
    }
  };

  const disconnectOneNote = async () => {
    if (!confirm("Disconnect OneNote? Existing imported pages remain until you remove them.")) return;
    const res = await fetch("/api/onenote/sync", { method: "DELETE" });
    if (res.ok) {
      setOneNoteStatus({
        ...oneNoteStatus,
        connected: false,
        enabled: false,
        email: null,
        lastError: null,
      });
      say("ok", "OneNote disconnected. Hourly sync is disabled.");
    } else {
      say("error", "Could not disconnect OneNote");
    }
  };

  const askPassphrase = (title: string) =>
    new Promise<string | null>((resolve) => setPassRequest({ title, resolve }));

  const patchWorkspace = async (body: unknown, okText: string) => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      say("ok", okText);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      say("error", data.error ?? "Something went wrong");
    }
  };

  const saveBackupSettings = () =>
    patchWorkspace(
      {
        backupEnabled,
        backupIntervalHours: intervalHours,
        backupKeep: keep,
        backupDir: dir || null,
        backupEncrypt: encrypt,
      },
      "Backup settings saved."
    );

  const backupNow = async () => {
    let passphrase: string | undefined;
    if (encrypt && !workspace.hasScheduledPassphrase) {
      passphrase = (await askPassphrase("Encryption passphrase for this backup")) ?? undefined;
      if (!passphrase) return;
    }
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/workspace/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase, encrypt }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setBackups(data.backups ?? []);
      say(
        "ok",
        `Backup ${data.file} written${data.cloud ? ` and uploaded to ${data.cloud}` : ""}`
      );
      if (data.cloud) router.refresh();
    } else {
      say("error", data.error ?? "Backup failed");
    }
  };

  const download = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/workspace/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: downloadPassphrase || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      say("error", "Export failed");
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "keel-backup.json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    say("ok", `Downloaded ${filename}`);
  };

  const restoreFromFile = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      say("error", "Choose a backup file first.");
      return;
    }
    if (!confirm("Restore this backup? Its content will be added alongside your existing pages."))
      return;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    if (restorePassphrase) form.set("passphrase", restorePassphrase);
    const res = await fetch("/api/workspace/import", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      sayRestored(
        `Restored ${data.restored} top-level page(s) from the backup.`,
        data.skippedAttachments
      );
      router.refresh();
    } else {
      say("error", data.error ?? "Restore failed");
    }
  };

  const applyMemberLists = (data: { members?: MemberDTO[]; invites?: InviteDTO[] }) => {
    if (data.members) setMembers(data.members);
    if (data.invites) setInvites(data.invites);
  };

  const invite = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      applyMemberLists(data);
      setInviteEmail("");
      say("ok", "Invitation sent - it activates as soon as they sign in or register.");
    } else {
      say("error", data.error ?? "Could not invite");
    }
  };

  const changeMemberRole = async (memberId: string, role: string) => {
    const res = await fetch(`/api/workspace/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) applyMemberLists(data);
    else say("error", data.error ?? "Could not change role");
  };

  const removeMember = async (memberId: string) => {
    if (!confirm("Remove this member from the workspace?")) return;
    const res = await fetch(`/api/workspace/members/${memberId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) applyMemberLists(data);
    else say("error", data.error ?? "Could not remove member");
  };

  const revokeInvite = async (inviteId: string) => {
    const res = await fetch(`/api/workspace/invites/${inviteId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) applyMemberLists(data);
    else say("error", data.error ?? "Could not revoke invite");
  };

  const [credentials, setCredentials] = useState<
    { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }[] | null
  >(null);

  useEffect(() => {
    fetch("/api/account/credentials")
      .then((r) => (r.ok ? r.json() : { credentials: [] }))
      .then((d) => setCredentials(d.credentials ?? []))
      .catch(() => setCredentials([]));
  }, []);

  const registerKey = async () => {
    const name = (window.prompt("Name this security key (e.g. YubiKey 5, Backup key)") ?? "").trim();
    if (name === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const optRes = await fetch("/api/auth/webauthn/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("Could not start registration");
      const optionsJSON = await optRes.json();
      const response = await startRegistration({ optionsJSON });
      const verRes = await fetch("/api/auth/webauthn/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, name: name || "Security key" }),
      });
      const data = await verRes.json().catch(() => ({}));
      if (!verRes.ok) throw new Error(data.error ?? "Registration failed");
      say("ok", "Security key registered. Your account now requires it to sign in.");
      const list = await fetch("/api/account/credentials").then((r) => r.json());
      setCredentials(list.credentials ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Registration failed";
      say("error", /abort|cancel|not allowed/i.test(msg) ? "Cancelled." : msg);
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (id: string) => {
    if (!confirm("Remove this security key? If it's your only key, 2FA turns off.")) return;
    const res = await fetch(`/api/account/credentials/${id}`, { method: "DELETE" });
    if (res.ok) setCredentials((credentials ?? []).filter((c) => c.id !== id));
  };

  const [tunnel, setTunnel] = useState<{
    running: boolean;
    mode: string | null;
    url: string | null;
    error: string | null;
  } | null>(null);
  const [tunnelAvailable, setTunnelAvailable] = useState(true);
  const [tunnelToken, setTunnelToken] = useState("");

  useEffect(() => {
    if (!isInstanceOwner) return;
    fetch("/api/instance/tunnel")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setTunnel(d.state);
          setTunnelAvailable(d.available);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTunnel = async () => {
    const res = await fetch("/api/instance/tunnel");
    if (res.ok) {
      const d = await res.json();
      setTunnel(d.state);
      setTunnelAvailable(d.available);
      return d.state;
    }
    return null;
  };

  const startTunnel = async (mode: "quick" | "named") => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/instance/tunnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, token: mode === "named" ? tunnelToken : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      say("error", data.error ?? "Could not start the tunnel");
      return;
    }
    setTunnel(data.state);
    // The public URL appears a few seconds later - poll for it.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const state = await refreshTunnel();
      if (!state?.running || state?.url) break;
    }
  };

  const stopTunnel = async () => {
    const res = await fetch("/api/instance/tunnel", { method: "DELETE" });
    if (res.ok) setTunnel((await res.json()).state);
  };

  const [r2, setR2] = useState({ accountId: "", bucket: "", accessKeyId: "", secretKey: "" });
  const [azureSasUrl, setAzureSasUrl] = useState("");

  const [server, setServer] = useState<{
    version: string;
    uptimeSeconds: number;
    supervised: boolean;
    boot: string;
  } | null>(null);
  const [restarting, setRestarting] = useState<null | "waiting" | "back" | "gone">(null);
  const [update, setUpdate] = useState<{
    current: string;
    latest: string | null;
    url: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isInstanceOwner) return;
    fetch("/api/admin/server")
      .then((r) => (r.ok ? r.json() : null))
      .then(setServer)
      .catch(() => {});
    fetch("/api/admin/update-check")
      .then((r) => (r.ok ? r.json() : null))
      .then(setUpdate)
      .catch(() => {});
    // Static facts plus an uptime snapshot - no need to poll.
  }, [isInstanceOwner]);

  const restartServer = async () => {
    if (
      !confirm(
        server?.supervised
          ? "Restart the server? Everyone using this instance loses connection for a few seconds. Unsaved edits are already autosaved."
          : "Nothing appears to be supervising this server - restarting will STOP it, and you'll have to start it again by hand on the machine. Continue?"
      )
    )
      return;
    setRestarting("waiting");
    const oldBoot = server?.boot;
    try {
      const res = await fetch("/api/admin/restart", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRestarting(null);
        say("error", data.error ?? "Restart refused");
        return;
      }
    } catch {
      // The process may die before the response makes it out - that's fine,
      // the poll below is the real signal.
    }
    // Poll for a NEW boot id: same id = old process still up; changed = the
    // supervisor delivered. ~90s covers a slow container rebuild pull.
    for (let attempt = 0; attempt < 45; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const h = await fetch("/api/health", { cache: "no-store" });
        if (h.ok) {
          const data = await h.json();
          if (data.boot && data.boot !== oldBoot) {
            setRestarting("back");
            say("ok", "Server restarted - everything is back.");
            router.refresh();
            fetch("/api/admin/server").then((r) => (r.ok ? r.json() : null)).then(setServer).catch(() => {});
            return;
          }
        }
      } catch {
        // Down while swapping processes - keep waiting.
      }
    }
    setRestarting("gone");
    say(
      "error",
      "The server hasn't come back after 90 seconds. If nothing supervises it, start it by hand on the machine; otherwise check `docker ps` / `systemctl status keel` there."
    );
  };

  const connectAzure = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/cloud/azure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sasUrl: azureSasUrl }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setAzureSasUrl("");
      say("ok", `${data.email} connected - backups will upload there.`);
      router.refresh();
    } else {
      say("error", data.error ?? "Couldn't connect Azure");
    }
  };

  const connectR2 = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/cloud/r2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r2),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setR2({ accountId: "", bucket: "", accessKeyId: "", secretKey: "" });
      say("ok", "Cloudflare R2 connected - backups will upload there.");
      router.refresh();
    } else {
      say("error", data.error ?? "Could not connect R2");
    }
  };

  const disconnectCloud = async () => {
    if (!confirm("Disconnect cloud backups? Files already uploaded stay in your drive.")) return;
    const res = await fetch("/api/cloud", { method: "DELETE" });
    if (res.ok) {
      say("ok", "Cloud storage disconnected.");
      router.refresh();
    }
  };

  const restoreCloudBackup = async (file: CloudFile) => {
    let passphrase: string | undefined;
    if (isEncryptedBackupName(file.name)) {
      passphrase = (await askPassphrase("Passphrase for this encrypted backup")) ?? undefined;
      if (!passphrase) return;
    }
    if (!confirm(`Restore ${file.name}? Its content will be added alongside your existing pages.`))
      return;
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/cloud/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: file.id, passphrase }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      sayRestored(
        `Restored ${data.restored} top-level page(s) from ${file.name}.`,
        data.skippedAttachments
      );
      router.refresh();
    } else {
      say("error", data.error ?? "Cloud restore failed");
    }
  };

  const restoreServerBackup = async (filename: string) => {
    let passphrase: string | undefined;
    if (isEncryptedBackupName(filename)) {
      passphrase = (await askPassphrase("Passphrase for this encrypted backup")) ?? undefined;
      if (!passphrase) return;
    }
    if (!confirm(`Restore ${filename}? Its content will be added alongside your existing pages.`))
      return;
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/workspace/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, passphrase }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      sayRestored(
        `Restored ${data.restored} top-level page(s) from ${filename}.`,
        data.skippedAttachments
      );
      router.refresh();
    } else {
      say("error", data.error ?? "Restore failed");
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <h1 className="text-2xl font-bold mb-6">⚙️ Settings</h1>

      {message && (
        <div
          // "warn" is the partial success - it worked, but something was left
          // behind. It must not read as quietly as "ok" nor as alarming as a
          // failure, so it gets the yellow option palette rather than either.
          role={message.kind === "ok" ? undefined : "alert"}
          className={`mb-4 rounded border px-4 py-2 text-sm ${
            message.kind === "ok"
              ? "border-[var(--border)] bg-[var(--panel)]"
              : message.kind === "warn"
                ? "border-[var(--opt-yellow-fg)] bg-[var(--opt-yellow-bg)] text-[var(--opt-yellow-fg)]"
                : "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
          }`}
        >
          {message.text}
        </div>
      )}

      {claimRequired && (
        <div className="mb-8">
          <InstanceClaimInstructions />
        </div>
      )}

      <Section title="Appearance">
        <div>
          <p className="text-sm text-[var(--muted)] mb-2">
            Theme for this device. “System” follows your OS light/dark preference.
          </p>
          <ThemeSelect current={theme} />
        </div>
      </Section>

      <Section title="Account">
        <label className="block">
          <span className="text-sm text-[var(--muted)]">Username</span>
          <p className="text-xs text-[var(--faint)] mb-1">
            Shown in the account menu instead of your real name - your first and last
            name never appear in the workspace, so screenshots stay anonymous.
          </p>
          <div className="mt-1 flex gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={async () => {
                setBusy(true);
                setMessage(null);
                const res = await fetch("/api/account", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ username }),
                });
                const data = await res.json().catch(() => ({}));
                setBusy(false);
                if (res.ok) {
                  setUsername(data.username);
                  say("ok", "Username updated.");
                  router.refresh();
                } else {
                  say("error", data.error ?? "Could not update username");
                }
              }}
              disabled={busy || !username.trim()}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </label>

        <div className="border-t border-[var(--border-soft)] pt-4">
          <h3 className="text-sm font-medium">Google sign-in</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Add Google as another sign-in method for <strong>{account.email}</strong>.
            Keel links only after this signed-in session completes a one-time Google
            authorization. It never chooses an account from an email lookup.
          </p>
          <p className="mt-1 text-xs text-[var(--faint)]">
            The verified Google email must match this account exactly. Linking changes
            neither your password nor your security-key requirement.
          </p>

          {googleLinkMessage && (
            <p
              role={googleLinkMessage.kind === "ok" ? "status" : "alert"}
              className={`mt-3 rounded border px-3 py-2 text-sm ${
                googleLinkMessage.kind === "ok"
                  ? "border-[var(--border)] bg-[var(--panel)]"
                  : googleLinkMessage.kind === "warn"
                    ? "border-[var(--opt-yellow-fg)] bg-[var(--opt-yellow-bg)] text-[var(--opt-yellow-fg)]"
                    : "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
              }`}
            >
              {googleLinkMessage.text}
            </p>
          )}

          {account.googleLinked ? (
            <p className="mt-3 text-sm text-[var(--muted)]">
              ✓ Google sign-in is linked to this account.
            </p>
          ) : cloud.googleReady ? (
            <button
              type="button"
              onClick={linkGoogleAccount}
              disabled={googleLinkWorking}
              className="mt-3 rounded bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)] hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              {googleLinkWorking ? "Opening Google..." : "Link Google sign-in"}
            </button>
          ) : (
            <p className="mt-3 text-sm text-[var(--faint)]">
              Google sign-in is not configured on this server.
              {isInstanceOwner
                ? " Add the client ID and secret under Integrations below first."
                : " Ask the instance owner to configure it."}
            </p>
          )}
        </div>
      </Section>

      <Section title="Password">
        {hasPassword ? (
          <>
            <p className="text-sm text-[var(--muted)]">
              Changing your password signs you out everywhere else - so if you are
              changing it <em>because</em> someone else got in, they lose access.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password (8+ characters)"
                className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={changePassword}
              disabled={busy || !currentPassword || newPassword.length < 8}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              Change password
            </button>
          </>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            This account signs in with Google, so it has no password to change.
          </p>
        )}
      </Section>

      <Section title="Where you're signed in">
        <p className="text-sm text-[var(--muted)]">
          Every browser and device holding a valid session. Sessions last 30 days;
          end one you don&apos;t recognise.
        </p>
        {sessions === null ? (
          <p className="text-sm text-[var(--faint)]">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-[var(--faint)]">No other sessions.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-soft)] text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <span className="flex-1">
                  Signed in {new Date(s.createdAt).toLocaleString()}
                  {s.current && (
                    <span className="ml-2 rounded bg-[var(--hover)] px-1.5 py-0.5 text-xs">
                      this device
                    </span>
                  )}
                </span>
                <span className="text-xs text-[var(--faint)]">
                  expires {new Date(s.expiresAt).toLocaleDateString()}
                </span>
                {!s.current && (
                  <button
                    onClick={() => revokeSession(s.id)}
                    className="text-xs text-[var(--danger)] hover:underline"
                  >
                    End
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(sessions?.length ?? 0) > 1 && (
          <button
            onClick={revokeOtherSessions}
            disabled={busy}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
          >
            Sign out everywhere else
          </button>
        )}
      </Section>

      <Section title="Security keys (two-factor)">
        <p className="text-sm text-[var(--muted)]">
          Add a hardware security key (YubiKey, passkey) as a second factor. Once you
          register one, signing in - by password <em>or</em> Google - also requires a tap
          of your key. <strong>Register two</strong> (a primary and a backup) so a lost key
          can&apos;t lock you out.
        </p>
        <p className="text-xs text-[var(--faint)]">
          Requires a secure connection (HTTPS or localhost). Over Tailscale, use{" "}
          <code>tailscale serve</code>.
        </p>

        {credentials === null ? (
          <p className="text-sm text-[var(--faint)]">Loading…</p>
        ) : credentials.length === 0 ? (
          <p className="text-sm text-[var(--faint)]">No security keys yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-soft)] rounded border border-[var(--border)]">
            {credentials.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="text-lg">🔑</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.name}</span>
                  <span className="block text-xs text-[var(--faint)]">
                    Added {new Date(c.createdAt).toLocaleDateString()}
                    {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : ""}
                  </span>
                </span>
                <button
                  onClick={() => removeKey(c.id)}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          onClick={registerKey}
          disabled={busy}
          className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
        >
          Register a security key
        </button>
      </Section>

      <Section title="Workspace">
        <label className="block">
          <span className="text-sm text-[var(--muted)]">Workspace name</span>
          <div className="mt-1 flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isOwner}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => patchWorkspace({ name }, "Workspace renamed.")}
              disabled={busy || !isOwner || !name.trim()}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              Rename
            </button>
          </div>
        </label>
        <div className="mt-5 border-t border-[var(--border-soft)] pt-4">
          <label className="block text-sm">
            <span className="text-[var(--muted)]">Automatically empty trash after</span>
            <div className="mt-1 flex flex-wrap gap-2">
              <select
                value={trashRetentionDays}
                onChange={(event) => setTrashRetentionDays(Number(event.target.value))}
                disabled={!isOwner}
                className="min-w-48 rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-2"
              >
                <option value={0}>Never</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
              <button
                onClick={() =>
                  patchWorkspace(
                    { trashRetentionDays },
                    trashRetentionDays === 0
                      ? "Trash will be kept until you delete it."
                      : `Trash will be emptied after ${trashRetentionDays} days.`
                  )
                }
                disabled={busy || !isOwner}
                className="rounded bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)] hover:bg-[var(--btn-hover)] disabled:opacity-50"
              >
                Save trash retention
              </button>
            </div>
          </label>
          <p className="mt-2 text-xs text-[var(--faint)]">
            Moving a page to trash is reversible. After this retention period, Keel
            permanently removes the page and its archived sub-pages during maintenance.
          </p>
        </div>
      </Section>

      {isOwner && (
        <Section title="Members & sharing">
          <p className="text-sm text-[var(--muted)]">
            Invite people to this workspace by email. <strong>Can edit</strong> members
            create and change pages; <strong>View only</strong> members can read and
            search but not modify anything. A verified Google signup can accept its
            matching invitation automatically. Password signup does not prove mailbox
            ownership, so invite that account again after it registers to confirm access.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && inviteEmail && invite()}
              placeholder="person@example.com"
              className="flex-1 min-w-48 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-2 text-sm"
            >
              <option value="editor">Can edit</option>
              <option value="viewer">View only</option>
            </select>
            <button
              onClick={invite}
              disabled={busy || !inviteEmail.trim()}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              Invite
            </button>
          </div>

          <ul className="divide-y divide-[var(--border-soft)] rounded border border-[var(--border)]">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-6 h-6 rounded-full bg-[var(--btn-bg)] text-[var(--btn-fg)] text-[10px] font-semibold flex items-center justify-center shrink-0">
                  {m.username[0]?.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">@{m.username}</span>
                  <span className="block truncate text-xs text-[var(--faint)]">{m.email}</span>
                </span>
                {m.isOwner ? (
                  <span className="text-xs text-[var(--faint)]">Owner</span>
                ) : (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => changeMemberRole(m.id, e.target.value)}
                      className="rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-1 text-xs"
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">View only</option>
                    </select>
                    <button
                      onClick={() => removeMember(m.id)}
                      className="text-xs text-[var(--danger)] hover:underline"
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-6 h-6 rounded-full border border-dashed border-[var(--border)] text-[10px] flex items-center justify-center shrink-0 text-[var(--faint)]">
                  ✉
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{i.email}</span>
                  <span className="block text-xs text-[var(--faint)]">
                    Pending invite · {i.role === "viewer" ? "View only" : "Can edit"}
                  </span>
                </span>
                <button
                  onClick={() => revokeInvite(i.id)}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Only worth a panel when something needs attention. "current" is the
          answer to a question nobody asked; the other three states are how an
          operator finds out their schema is behind before a query fails. */}
      {schema && schema.state !== "current" && (
        <Section title="Database schema">
          <div
            className={`rounded border px-4 py-3 text-sm ${
              schema.state === "failed"
                ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            <p className="font-medium">
              {schema.state === "failed"
                ? "The last migration attempt failed"
                : schema.state === "unverified"
                  ? "Keel cannot verify the schema is up to date"
                  : "Schema management is deferred to an external migrator"}
            </p>
            <p className="mt-1">{schema.detail}</p>
            <p className="mt-1 text-xs text-[var(--faint)]">
              Checked at {new Date(schema.at).toLocaleString()}. Full detail is in the server log.
            </p>
          </div>
        </Section>
      )}

      {access && (
        <Section title="Registration and sign-in">
          <p className="text-sm text-[var(--muted)]">
            Registration is open by default. Keep it open when you want other people to
            create accounts, or turn it off when this server has everyone it needs. Use an
            allowlist when only specific email addresses should be able to register or sign
            in. <strong>Set both controls before exposing Keel to the public internet.</strong>
          </p>

          <div className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm">
            <span className="font-medium">Current state: </span>
            {signupDisabled ? (
              <span>
                Closed. No new accounts can be created. Existing accounts
                {allowedEmails.length > 0 ? " must also be on the allowlist" : " may still sign in"}.
              </span>
            ) : allowedEmails.length > 0 ? (
              <span>
                Restricted. New and existing accounts must use one of the listed email
                addresses.
              </span>
            ) : (
              <span>
                Open. Anyone who can reach this server may create an account and sign in.
              </span>
            )}
          </div>

          {access.allowedEmailsLocked && (
            <p className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">
              🔒 The allowlist is enforced by <code>KEEL_ALLOWED_EMAILS</code>. Remove that
              variable and restart Keel to manage the list here.
            </p>
          )}

          {access.signupLocked && (
            <p className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)]">
              🔒 The registration switch is enforced by <code>KEEL_DISABLE_SIGNUP</code>.
              Remove that variable and restart Keel to manage registration here.
            </p>
          )}

          <div>
            <span className="text-sm text-[var(--muted)]">Allowed accounts</span>
            {allowedEmails.length === 0 ? (
              <p className="text-xs text-[var(--faint)] mt-1">
                No allowlist. Every existing account may sign in; the registration switch
                separately controls whether new accounts can be created.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {allowedEmails.map((e) => (
                  <li
                    key={e}
                    className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--elevated)] pl-3 pr-1.5 py-1 text-xs"
                  >
                    <span className="font-mono">{e}</span>
                    {!access.allowedEmailsLocked && (
                      <button
                        onClick={() => setAllowedEmails(allowedEmails.filter((x) => x !== e))}
                        className="rounded-full w-4 h-4 leading-none text-[var(--faint)] hover:text-[var(--danger)]"
                        title="Remove"
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!access.allowedEmailsLocked && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addAllowedEmail())}
                  placeholder={access.ownerEmail}
                  className="flex-1 min-w-48 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={addAllowedEmail}
                  className="rounded border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--hover)]"
                >
                  Add
                </button>
                {!allowedEmails.includes(access.ownerEmail.toLowerCase()) && (
                  <button
                    onClick={() =>
                      setAllowedEmails([...allowedEmails, access.ownerEmail.toLowerCase()])
                    }
                    className="rounded border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--hover)]"
                  >
                    + Add my email
                  </button>
                )}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!signupDisabled}
              onChange={(e) => setSignupDisabled(!e.target.checked)}
              disabled={access.signupLocked}
              className="h-4 w-4 accent-blue-600"
            />
            Allow new registrations
          </label>
          <p className="text-xs text-[var(--faint)]">
            This switch affects new accounts only. The allowlist also controls existing
            sign-in. A password registration does not prove ownership of an email mailbox.
          </p>

          {(!access.allowedEmailsLocked || !access.signupLocked) && (
            <button
              onClick={saveAccess}
              disabled={busy}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              Save access settings
            </button>
          )}
        </Section>
      )}

      {isInstanceOwner && <OAuthIntegrations />}

      {isInstanceOwner && <OperatorSettingsPanel />}

      <Section title="Backups & data safety">
        <p className="text-sm text-[var(--muted)]">
          Backups are full snapshots of your workspace (pages, databases, records). The
          database also runs in crash-safe WAL mode, so a sudden server shutdown cannot
          lose saved changes. For off-site copies, set the backup folder below to a folder
          synced by <strong>OneDrive</strong>, <strong>Google Drive</strong> or similar -
          every automatic backup then uploads on its own.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={backupEnabled}
              onChange={(e) => setBackupEnabled(e.target.checked)}
              disabled={!isOwner}
              className="h-4 w-4 accent-blue-600"
            />
            Automatic backups
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => setEncrypt(e.target.checked)}
              disabled={!isOwner}
              className="h-4 w-4 accent-blue-600"
            />
            Encrypt backups (AES-256)
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">Every</span>
            <select
              value={intervalHours}
              onChange={(e) => setIntervalHours(Number(e.target.value))}
              disabled={!isOwner}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-1.5"
            >
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
              <option value={168}>Week</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">Keep last</span>
            <select
              value={keep}
              onChange={(e) => setKeep(Number(e.target.value))}
              disabled={!isOwner}
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-2 py-1.5"
            >
              <option value={7}>7 backups</option>
              <option value={14}>14 backups</option>
              <option value={30}>30 backups</option>
              <option value={90}>90 backups</option>
            </select>
          </label>
        </div>

        <label className="block text-sm">
          <span className="text-[var(--muted)]">
            Backup folder (custom location - e.g. your OneDrive or Google Drive folder)
          </span>
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            disabled={!isOwner}
            placeholder={workspace.backupResolvedDir || "Leave blank to use the server default"}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        {encrypt && !workspace.hasScheduledPassphrase && (
          <p className="text-xs text-[var(--danger)]">
            Automatic encrypted backups need a server-side passphrase.{" "}
            {isInstanceOwner
              ? "Save one in Scheduled backup secret above, or have the host set KEEL_BACKUP_PASSPHRASE as a locked environment override."
              : "Ask the instance owner to configure it in Settings or on the host."}{" "}
            Keel never puts the passphrase in a backup or sends a saved value back to the
            browser. Manual “Back up now” asks for a passphrase instead.
          </p>
        )}
        {workspace.lastBackupError && (
          <p className="text-xs text-[var(--danger)]">
            Last automatic backup failed: {workspace.lastBackupError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={saveBackupSettings}
            disabled={busy || !isOwner}
            className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
          >
            Save backup settings
          </button>
          <button
            onClick={backupNow}
            disabled={busy || !isOwner}
            className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
          >
            Back up now
          </button>
          {workspace.lastBackupAt && (
            <span className="text-xs text-[var(--faint)]">
              Last backup: {new Date(workspace.lastBackupAt).toLocaleString()}
            </span>
          )}
        </div>

        <div className="border-t border-[var(--border-soft)] pt-4">
          <h3 className="text-sm font-medium mb-2">Backups in folder</h3>
          {backups.length === 0 ? (
            <p className="text-sm text-[var(--faint)]">No backups yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--border-soft)] rounded border border-[var(--border)]">
              {backups.map((b) => (
                <li key={b.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1 truncate font-mono text-xs">
                    {isEncryptedBackupName(b.name) ? "🔒 " : ""}
                    {b.name}
                  </span>
                  <span className="text-xs text-[var(--faint)] shrink-0">
                    {formatSize(b.size)} · {new Date(b.modifiedAt).toLocaleString()}
                  </span>
                  <button
                    onClick={() => restoreServerBackup(b.name)}
                    disabled={busy || !isOwner}
                    className="text-[var(--link)] hover:underline shrink-0"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      {isOwner && (
        <Section title="Cloud backups (Google Drive / OneDrive)">
          {cloud.provider ? (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span>
                  ☁️ Connected to{" "}
                  <strong>
                    {cloud.provider === "google"
                      ? "Google Drive"
                      : cloud.provider === "r2"
                        ? "Cloudflare R2"
                        : "OneDrive"}
                  </strong>
                  {cloud.email && <span className="text-[var(--muted)]"> as {cloud.email}</span>}
                </span>
                <button
                  onClick={disconnectCloud}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Disconnect
                </button>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Every backup (manual and scheduled) is now also uploaded to{" "}
                {cloud.provider === "google"
                  ? "the “Keel Backups” folder in your Google Drive"
                  : cloud.provider === "r2"
                    ? "the “keel-backups/” prefix in your R2 bucket"
                    : "Keel’s app folder in your OneDrive"}
                . Restore from any of them below.
              </p>
              {cloudFiles === null ? (
                <p className="text-sm text-[var(--faint)]">Loading cloud backups…</p>
              ) : cloudFiles.length === 0 ? (
                <p className="text-sm text-[var(--faint)]">
                  No cloud backups yet - run “Back up now” above to create the first one.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border-soft)] rounded border border-[var(--border)]">
                  {cloudFiles.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="flex-1 truncate font-mono text-xs">
                        {isEncryptedBackupName(f.name) ? "🔒 " : ""}
                        {f.name}
                      </span>
                      <span className="text-xs text-[var(--faint)] shrink-0">
                        {formatSize(f.size)} · {new Date(f.modifiedAt).toLocaleString()}
                      </span>
                      <button
                        onClick={() => restoreCloudBackup(f)}
                        disabled={busy}
                        className="text-[var(--link)] hover:underline shrink-0"
                      >
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--muted)]">
                Connect a cloud account and every backup is automatically uploaded off-site -
                and can be restored from here on any machine. Keel only ever sees files it
                created itself (Google Drive <code>drive.file</code> scope / OneDrive App
                Folder).
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={cloud.googleReady ? "/api/cloud/connect?provider=google" : undefined}
                  aria-disabled={!cloud.googleReady}
                  className={`rounded border border-[var(--border)] px-4 py-2 text-sm ${
                    cloud.googleReady
                      ? "hover:bg-[var(--hover)]"
                      : "opacity-50 cursor-not-allowed"
                  }`}
                >
                  Connect Google Drive
                </a>
                <a
                  href={cloud.microsoftReady ? "/api/cloud/connect?provider=onedrive" : undefined}
                  aria-disabled={!cloud.microsoftReady}
                  className={`rounded border border-[var(--border)] px-4 py-2 text-sm ${
                    cloud.microsoftReady
                      ? "hover:bg-[var(--hover)]"
                      : "opacity-50 cursor-not-allowed"
                  }`}
                >
                  Connect OneDrive
                </a>
              </div>
              {!cloud.googleReady && (
                <SetupHint capability="backup-gdrive">
                  Google Drive needs a free Google credential on the server first.
                </SetupHint>
              )}
              {!cloud.microsoftReady && (
                <SetupHint capability="backup-onedrive">
                  OneDrive needs a free Microsoft registration on the server first.
                </SetupHint>
              )}

              <div className="border-t border-[var(--border-soft)] pt-4">
                <h3 className="text-sm font-medium mb-1">Cloudflare R2</h3>
                <p className="text-xs text-[var(--muted)] mb-2">
                  S3-compatible object storage. Create a bucket and an R2 API token
                  (Object Read &amp; Write) in the Cloudflare dashboard → R2, then paste
                  the details below. The endpoint is{" "}
                  <code>https://&lt;account-id&gt;.r2.cloudflarestorage.com</code>.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    value={r2.accountId}
                    onChange={(e) => setR2({ ...r2, accountId: e.target.value })}
                    placeholder="Account ID"
                    className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    value={r2.bucket}
                    onChange={(e) => setR2({ ...r2, bucket: e.target.value })}
                    placeholder="Bucket name"
                    className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    value={r2.accessKeyId}
                    onChange={(e) => setR2({ ...r2, accessKeyId: e.target.value })}
                    placeholder="Access Key ID"
                    className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="password"
                    value={r2.secretKey}
                    onChange={(e) => setR2({ ...r2, secretKey: e.target.value })}
                    placeholder="Secret Access Key"
                    className="rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <button
                  onClick={connectR2}
                  disabled={
                    busy || !r2.accountId.trim() || !r2.bucket.trim() || !r2.accessKeyId.trim() || !r2.secretKey.trim()
                  }
                  className="mt-2 rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  Connect Cloudflare R2
                </button>
                <SetupHint capability="backup-r2">
                  The token page shows four values and two are traps - the guide points at
                  the right ones.
                </SetupHint>
              </div>

              <div className="border-t border-[var(--border-soft)] pt-4">
                <h3 className="text-sm font-medium mb-1">Azure Blob Storage</h3>
                <p className="text-xs text-[var(--muted)] mb-2">
                  The simplest cloud option: paste one container SAS URL - no app
                  registration, nothing else shared. Keel tests it before saving.
                </p>
                <input
                  type="password"
                  value={azureSasUrl}
                  onChange={(e) => setAzureSasUrl(e.target.value)}
                  placeholder="https://<account>.blob.core.windows.net/<container>?sv=…&sig=…"
                  className="w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={connectAzure}
                  disabled={busy || !azureSasUrl.trim()}
                  className="mt-2 rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  Connect Azure Blob
                </button>
                <SetupHint capability="backup-azure">
                  Never made a SAS URL? Five clicks in the Azure portal.
                </SetupHint>
              </div>
            </>
          )}
        </Section>
      )}

      {isOwner && (
        <Section title="OneNote hourly import">
          <p className="text-sm text-[var(--muted)]">
            Mirrors OneNote into <strong>Imported → Notebook → Section → Page</strong>.
            The mirror is read-only in Keel. Each hourly scan downloads only pages whose
            Microsoft modification timestamp changed, reuses identical images, and removes
            image files that are no longer referenced.
          </p>
          {!oneNoteStatus.microsoftReady ? (
            <SetupHint capability="onenote-import">
              The mirror needs a free Microsoft registration on the server (shared with
              OneDrive backups).
            </SetupHint>
          ) : oneNoteStatus.connected ? (
            <>
              <p className="text-sm">
                Connected as <strong>{oneNoteStatus.email ?? "Microsoft account"}</strong>
              </p>
              <p className="text-xs text-[var(--faint)]">
                {oneNoteStatus.lastSyncAt
                  ? `Last sync: ${new Date(oneNoteStatus.lastSyncAt).toLocaleString()}`
                  : "No completed sync yet."}
              </p>
              {oneNoteStatus.lastError && (
                <p className="text-sm text-[var(--danger)]">{oneNoteStatus.lastError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={syncOneNoteNow}
                  disabled={busy}
                  className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Sync now
                </button>
                <button
                  onClick={disconnectOneNote}
                  disabled={busy}
                  className="rounded border border-[var(--border)] px-4 py-2 text-sm"
                >
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <a
              href="/api/onenote/connect"
              className="inline-block rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium"
            >
              Connect OneNote
            </a>
          )}
        </Section>
      )}

      {isInstanceOwner && (
        <Section title="Server">
          <p className="text-sm text-[var(--muted)]">
            The machine running this Keel. Restarting is safe for your notes - every edit
            is autosaved before it matters, and the database survives restarts by design.
          </p>
          {server ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-[var(--muted)]">Version</dt>
                <dd>{server.version}</dd>
                <dt className="text-[var(--muted)]">Up for</dt>
                <dd>{formatUptime(server.uptimeSeconds)}</dd>
                <dt className="text-[var(--muted)]">Updates</dt>
                <dd>
                  {!update ? (
                    "checking…"
                  ) : update.updateAvailable ? (
                    <span>
                      <strong>{update.latest}</strong> is out (you run {update.current}) -{" "}
                      {update.url && (
                        <a href={update.url} target="_blank" rel="noopener noreferrer" className="text-[var(--link)] hover:underline">
                          release notes
                        </a>
                      )}
                      {" · "}update with the method you installed by:{" "}
                      <code className="rounded bg-[var(--hover)] px-1">keel update</code>,{" "}
                      <code className="rounded bg-[var(--hover)] px-1">brew upgrade keel</code>, or
                      rebuild the container. Your notes migrate themselves on the next start.
                    </span>
                  ) : update.checked ? (
                    `up to date (${update.current})`
                  ) : (
                    `${update.current} - couldn't check for updates (offline or private repository)`
                  )}
                </dd>
                <dt className="text-[var(--muted)]">Supervision</dt>
                <dd>
                  {server.supervised ? (
                    "✓ supervised - a restart comes back on its own"
                  ) : (
                    <span className="text-[var(--danger)]">
                      none detected - restarting from here will stop the server until you
                      start it again by hand (set KEEL_SUPERVISED=1 if this is wrong)
                    </span>
                  )}
                </dd>
              </dl>
              <div className="flex items-center gap-3">
                <button
                  onClick={restartServer}
                  disabled={restarting === "waiting"}
                  className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  {restarting === "waiting" ? "Restarting…" : "⟳ Restart server"}
                </button>
                {restarting === "waiting" && (
                  <span className="text-sm text-[var(--muted)]">
                    waiting for the server to come back - this page will confirm by itself
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--faint)]">Loading server details…</p>
          )}
        </Section>
      )}

      {isInstanceOwner && (
        <Section title="Activity log">
          <p className="text-sm text-[var(--muted)]">
            Every privileged action: access changes, tunnels, invites, backups,
            restores and exports. Read-only - it cannot be edited from here, which
            is the point of keeping it. Entries are kept for a year.
          </p>
          {auditEvents === null ? (
            <p className="text-sm text-[var(--faint)]">Loading…</p>
          ) : auditEvents.length === 0 ? (
            <p className="text-sm text-[var(--faint)]">Nothing recorded yet.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[var(--elevated)] text-[var(--faint)]">
                  <tr>
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="py-1 pr-3 font-medium">Who</th>
                    <th className="py-1 pr-3 font-medium">Action</th>
                    <th className="py-1 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-soft)]">
                  {auditEvents.map((e) => (
                    <tr key={e.id}>
                      <td className="py-1 pr-3 whitespace-nowrap text-[var(--faint)]">
                        {new Date(e.createdAt).toLocaleString()}
                      </td>
                      <td className="py-1 pr-3 whitespace-nowrap">@{e.actor}</td>
                      <td className="py-1 pr-3 whitespace-nowrap font-mono">{e.action}</td>
                      <td className="py-1 break-all text-[var(--muted)]">
                        {e.target && <span className="mr-2">{e.target}</span>}
                        {e.detail && (
                          <span className="text-[var(--faint)]">
                            {Object.entries(e.detail)
                              .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
                              .join(" ")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {isInstanceOwner && (
        <Section title="Remote access (Cloudflare Tunnel)">
          <p className="text-sm text-[var(--muted)]">
            Reach this <strong>local</strong> Keel from your phone or anywhere, without
            opening ports. A quick tunnel gives an instant public URL; a named tunnel
            serves your own domain.{" "}
            <strong>Lock the instance down first</strong> (Registration and sign-in above)
            so only the accounts you chose can sign in.
          </p>

          {!tunnelAvailable && (
            <p className="text-xs text-[var(--danger)]">
              <code>cloudflared</code> isn&apos;t installed.{" "}
              <a
                href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
                className="text-[var(--link)] hover:underline"
              >
                Install it
              </a>{" "}
              and reload this page.
            </p>
          )}

          {tunnel?.running ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-500" /> Tunnel running
                  {tunnel.mode ? ` (${tunnel.mode})` : ""}
                </span>
                <button onClick={stopTunnel} className="text-xs text-[var(--danger)] hover:underline">
                  Stop
                </button>
              </div>
              {tunnel.url ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a href={tunnel.url} className="text-[var(--link)] hover:underline font-mono text-sm">
                    {tunnel.url}
                  </a>
                  <button
                    onClick={() => navigator.clipboard?.writeText(tunnel.url ?? "")}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
                  >
                    Copy
                  </button>
                </div>
              ) : tunnel.mode === "named" ? (
                <p className="text-xs text-[var(--muted)]">
                  Serving your configured Cloudflare hostname.
                </p>
              ) : (
                <p className="text-xs text-[var(--faint)]">Getting your public URL…</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => startTunnel("quick")}
                  disabled={busy || !tunnelAvailable}
                  className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
                >
                  Start quick tunnel
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={tunnelToken}
                  onChange={(e) => setTunnelToken(e.target.value)}
                  placeholder="Named tunnel token (optional)"
                  className="flex-1 min-w-48 rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => startTunnel("named")}
                  disabled={busy || !tunnelAvailable || !tunnelToken.trim()}
                  className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  Start named tunnel
                </button>
              </div>
              <p className="text-xs text-[var(--faint)]">
                Create a named tunnel + token at{" "}
                <a
                  href="https://one.dash.cloudflare.com/"
                  className="text-[var(--link)] hover:underline"
                >
                  Cloudflare Zero Trust → Networks → Tunnels
                </a>
                .
              </p>
            </div>
          )}
          {tunnel?.error && <p className="text-xs text-[var(--danger)]">{tunnel.error}</p>}
        </Section>
      )}

      <Section title="Download & restore">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium mb-1">Download a backup</h3>
            <p className="text-xs text-[var(--muted)] mb-2">
              Saves a full snapshot to your device. Add a passphrase to encrypt it.
            </p>
            <input
              type="password"
              value={downloadPassphrase}
              onChange={(e) => setDownloadPassphrase(e.target.value)}
              placeholder="Passphrase (optional)"
              className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none"
            />
            <button
              onClick={download}
              disabled={busy}
              className="rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              ⬇ Download backup
            </button>
          </div>
          <div>
            <h3 className="text-sm font-medium mb-1">Restore from a file</h3>
            <p className="text-xs text-[var(--muted)] mb-2">
              Non-destructive: restored pages are added next to your current content.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.keelbak"
              className="mb-2 w-full text-sm"
            />
            <input
              type="password"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              placeholder="Passphrase (if encrypted)"
              className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none"
            />
            <button
              onClick={restoreFromFile}
              disabled={busy}
              className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--hover)] disabled:opacity-50"
            >
              ⬆ Restore backup
            </button>
          </div>
        </div>
      </Section>

      {passRequest && (
        <PassphraseDialog
          title={passRequest.title}
          onDone={(value) => {
            passRequest.resolve(value);
            setPassRequest(null);
          }}
        />
      )}
    </div>
  );
}
