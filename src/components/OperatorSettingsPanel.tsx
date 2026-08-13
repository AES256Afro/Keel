"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SiteFieldState = {
  value: string;
  source: "environment" | "managed" | "default";
  locked: boolean;
  warning: string | null;
};

type OperatorSettings = {
  site: {
    name: SiteFieldState;
    tagline: SiteFieldState;
    notesUrl: SiteFieldState;
  };
  backupPassphrase: {
    configured: boolean;
    source: "environment" | "managed" | "none";
    locked: boolean;
    available: boolean;
  };
  effective: {
    database: { dialect: "SQLite" | "PostgreSQL" | "Unknown" };
    publicOrigin: { configured: boolean; value: string };
    network: { bind: "loopback" | "all interfaces" | "custom"; port: number };
    proxy: { trusted: boolean; trustedHops: number | null };
    webauthn: { rpId: string; origin: string };
    access: {
      ownerPinnedByEnvironment: boolean;
      allowlistLocked: boolean;
      registrationLocked: boolean;
    };
    storage: {
      backupRoot: "default" | "custom";
      arbitraryBackupPaths: boolean;
      maxAttachmentMb: number;
      attachmentQuotaMb: number;
    };
    service: { supervised: boolean };
  };
};

function OperatorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="space-y-4 rounded-lg border border-[var(--border)] p-4">{children}</div>
    </section>
  );
}

function displayBoolean(value: boolean) {
  return value ? "Yes" : "No";
}

export default function OperatorSettingsPanel() {
  const router = useRouter();
  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [siteDraft, setSiteDraft] = useState({ name: "", tagline: "", notesUrl: "" });
  const [passphrase, setPassphrase] = useState("");
  const [working, setWorking] = useState<"site" | "passphrase" | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const acceptSettings = useCallback((next: OperatorSettings) => {
    setSettings(next);
    setSiteDraft({
      name: next.site.name.value,
      tagline: next.site.tagline.value,
      notesUrl: next.site.notesUrl.value,
    });
    setPassphrase("");
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/instance/operator-settings", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Could not load server settings");
        if (active) {
          acceptSettings(data);
          setLoadFailed(false);
        }
      })
      .catch((cause) => {
        if (!active) return;
        setLoadFailed(true);
        setNotice({
          kind: "error",
          text: cause instanceof Error ? cause.message : "Could not load server settings",
        });
      });
    return () => {
      active = false;
    };
  }, [acceptSettings]);

  const patch = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/instance/operator-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? "Could not save server settings");
    acceptSettings(data);
    router.refresh();
  };

  const saveSite = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const fields = Object.fromEntries(
      (["name", "tagline", "notesUrl"] as const)
        .filter((field) => !settings.site[field].locked)
        .map((field) => [field, siteDraft[field]])
    );
    if (Object.keys(fields).length === 0) return;
    setWorking("site");
    setNotice(null);
    try {
      await patch({ section: "site", action: "save", fields });
      setNotice({ kind: "ok", text: "Public-site branding saved and active." });
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not save public-site branding",
      });
    } finally {
      setWorking(null);
    }
  };

  const savePassphrase = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || settings.backupPassphrase.locked || passphrase.length < 12) return;
    const replacing = settings.backupPassphrase.source === "managed";
    if (
      replacing &&
      !confirm(
        "Replace the managed scheduled-backup passphrase? Future backups will use the new passphrase. Existing encrypted backups still need the passphrase that created them."
      )
    ) {
      return;
    }
    setWorking("passphrase");
    setNotice(null);
    try {
      await patch({ section: "backup-passphrase", action: "save", passphrase });
      setNotice({
        kind: "ok",
        text: replacing
          ? "Scheduled-backup passphrase replaced. Existing backups were not re-encrypted."
          : "Scheduled-backup passphrase saved.",
      });
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not save the backup passphrase",
      });
    } finally {
      setWorking(null);
    }
  };

  const clearPassphrase = async () => {
    if (!settings || settings.backupPassphrase.source !== "managed") return;
    if (
      !confirm(
        "Clear the managed scheduled-backup passphrase? Automatic encrypted backups will stop until another passphrase is configured. Existing backups still need their original passphrase."
      )
    ) {
      return;
    }
    setWorking("passphrase");
    setNotice(null);
    try {
      await patch({ section: "backup-passphrase", action: "clear", confirm: true });
      setNotice({ kind: "ok", text: "Managed scheduled-backup passphrase cleared." });
    } catch (cause) {
      setNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not clear the backup passphrase",
      });
    } finally {
      setWorking(null);
    }
  };

  if (!settings) {
    return (
      <OperatorSection title="Server configuration">
        {notice && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {notice.text}
          </p>
        )}
        <p className="text-sm text-[var(--faint)]">
          {loadFailed
            ? "Server settings are unavailable. Reload this page to try again."
            : "Loading server settings..."}
        </p>
      </OperatorSection>
    );
  }

  const unlockedSiteFields = (Object.keys(settings.site) as (keyof typeof settings.site)[]).filter(
    (field) => !settings.site[field].locked
  );
  const secret = settings.backupPassphrase;
  const effective = settings.effective;

  return (
    <>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`mb-6 rounded border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
              : "border-[var(--border)] bg-[var(--panel)]"
          }`}
        >
          {notice.text}
        </p>
      )}

      <OperatorSection title="Public site">
        <div>
          <p className="text-sm text-[var(--muted)]">
            Set the name, tagline, and Notes link shown by Keel&apos;s optional public
            projects site. These values are public by design and apply immediately.
          </p>
          <p className="mt-1 text-xs text-[var(--faint)]">
            A locked field is controlled by its server environment variable. Public
            routing, host trust, and database settings remain server-only controls.
          </p>
        </div>
        <form onSubmit={saveSite} className="space-y-3">
          <label className="block text-sm">
            <span className="flex flex-wrap items-center justify-between gap-2 text-[var(--muted)]">
              Site name
              {settings.site.name.locked && <span className="text-xs">Locked by KEEL_SITE_NAME</span>}
            </span>
            <input
              value={siteDraft.name}
              onChange={(event) => setSiteDraft((current) => ({ ...current, name: event.target.value }))}
              disabled={settings.site.name.locked}
              maxLength={100}
              required
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
            />
            {settings.site.name.warning && (
              <span className="mt-1 block text-xs text-[var(--danger)]">
                {settings.site.name.warning} Fix KEEL_SITE_NAME on the host.
              </span>
            )}
          </label>
          <label className="block text-sm">
            <span className="flex flex-wrap items-center justify-between gap-2 text-[var(--muted)]">
              Tagline
              {settings.site.tagline.locked && (
                <span className="text-xs">Locked by KEEL_SITE_TAGLINE</span>
              )}
            </span>
            <textarea
              value={siteDraft.tagline}
              onChange={(event) =>
                setSiteDraft((current) => ({ ...current, tagline: event.target.value }))
              }
              disabled={settings.site.tagline.locked}
              maxLength={300}
              required
              rows={3}
              className="mt-1 w-full resize-y rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
            />
            {settings.site.tagline.warning && (
              <span className="mt-1 block text-xs text-[var(--danger)]">
                {settings.site.tagline.warning} Fix KEEL_SITE_TAGLINE on the host.
              </span>
            )}
          </label>
          <label className="block text-sm">
            <span className="flex flex-wrap items-center justify-between gap-2 text-[var(--muted)]">
              Notes URL or path
              {settings.site.notesUrl.locked && (
                <span className="text-xs">Locked by KEEL_NOTES_URL</span>
              )}
            </span>
            <input
              value={siteDraft.notesUrl}
              onChange={(event) =>
                setSiteDraft((current) => ({ ...current, notesUrl: event.target.value }))
              }
              disabled={settings.site.notesUrl.locked}
              maxLength={2048}
              required
              inputMode="url"
              placeholder="/ or https://notes.example.com"
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
            />
            {settings.site.notesUrl.warning && (
              <span className="mt-1 block text-xs text-[var(--danger)]">
                {settings.site.notesUrl.warning} Fix KEEL_NOTES_URL on the host.
              </span>
            )}
          </label>
          {unlockedSiteFields.length > 0 && (
            <button
              type="submit"
              disabled={working === "site"}
              className="rounded bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)] hover:bg-[var(--btn-hover)] disabled:opacity-50"
            >
              {working === "site" ? "Saving..." : "Save public site"}
            </button>
          )}
        </form>
      </OperatorSection>

      <OperatorSection title="Scheduled backup secret">
        <div>
          <p className="text-sm text-[var(--muted)]">
            Automatic encrypted backups need one server-side passphrase. Keel stores a
            managed value encrypted at rest and never sends it back to this browser.
          </p>
          <p className="mt-1 text-xs text-[var(--faint)]">
            Keep your own copy in a password manager. Replacing or clearing this value
            does not change existing backup files, which still need their original
            passphrase.
          </p>
        </div>
        {secret.locked ? (
          <p className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--muted)]">
            Configured and locked by KEEL_BACKUP_PASSPHRASE. Its value is never shown in
            Settings.
          </p>
        ) : (
          <form onSubmit={savePassphrase} className="space-y-3">
            <p className={`text-sm ${secret.available ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
              {secret.source === "managed" && secret.available
                ? "A managed passphrase is saved. Enter a new one only to replace it."
                : secret.source === "managed"
                  ? "The managed passphrase cannot be decrypted. Replace it to repair future encrypted backups, or clear it."
                  : "No scheduled-backup passphrase is configured."}
            </p>
            <label className="block text-sm text-[var(--muted)]">
              {secret.source === "managed" ? "Replacement passphrase" : "Backup passphrase"}
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
                placeholder={secret.source === "managed" ? "Saved. Enter only to replace" : "At least 12 characters"}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <p className="text-xs text-[var(--faint)]">
              Saved values are write-only. Blank input never replaces the existing value.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={working === "passphrase" || passphrase.length < 12}
                className="rounded bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)] hover:bg-[var(--btn-hover)] disabled:opacity-50"
              >
                {working === "passphrase"
                  ? "Saving..."
                  : secret.source === "managed"
                    ? "Save replacement"
                    : "Save passphrase"}
              </button>
              {secret.source === "managed" && (
                <button
                  type="button"
                  onClick={clearPassphrase}
                  disabled={working === "passphrase"}
                  className="rounded border border-[var(--danger-border)] px-3 py-2 text-sm text-[var(--danger)] hover:bg-[var(--danger-bg)] disabled:opacity-50"
                >
                  Clear managed passphrase
                </button>
              )}
            </div>
          </form>
        )}
      </OperatorSection>

      <OperatorSection title="Effective server configuration">
        <div>
          <p className="text-sm text-[var(--muted)]">
            Read-only summary of the effective server posture. Secret values, database
            URLs, tokens, and absolute host paths are intentionally omitted.
          </p>
          <p className="mt-1 text-xs text-[var(--faint)]">
            Change routing, trust, process, database, and storage-root controls in the
            host environment or deployment configuration.
          </p>
        </div>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-[var(--faint)]">Database</dt><dd className="break-words">{effective.database.dialect}</dd></div>
          <div><dt className="text-[var(--faint)]">Public origin</dt><dd className="break-words">{effective.publicOrigin.value}</dd></div>
          <div><dt className="text-[var(--faint)]">Network listener</dt><dd>{effective.network.bind}, port {effective.network.port}</dd></div>
          <div><dt className="text-[var(--faint)]">Trusted proxy</dt><dd>{effective.proxy.trusted ? `Yes, ${effective.proxy.trustedHops} hop(s)` : "No"}</dd></div>
          <div><dt className="text-[var(--faint)]">WebAuthn RP ID</dt><dd className="break-words">{effective.webauthn.rpId}</dd></div>
          <div><dt className="text-[var(--faint)]">WebAuthn origin</dt><dd className="break-words">{effective.webauthn.origin}</dd></div>
          <div><dt className="text-[var(--faint)]">Registration env lock</dt><dd>{displayBoolean(effective.access.registrationLocked)}</dd></div>
          <div><dt className="text-[var(--faint)]">Allowlist env lock</dt><dd>{displayBoolean(effective.access.allowlistLocked)}</dd></div>
          <div><dt className="text-[var(--faint)]">Owner pinned by env</dt><dd>{displayBoolean(effective.access.ownerPinnedByEnvironment)}</dd></div>
          <div><dt className="text-[var(--faint)]">Backup root</dt><dd>{effective.storage.backupRoot}</dd></div>
          <div><dt className="text-[var(--faint)]">Arbitrary backup paths</dt><dd>{displayBoolean(effective.storage.arbitraryBackupPaths)}</dd></div>
          <div><dt className="text-[var(--faint)]">Attachment limits</dt><dd>{effective.storage.maxAttachmentMb} MB per file, {effective.storage.attachmentQuotaMb} MB total</dd></div>
          <div><dt className="text-[var(--faint)]">Managed service</dt><dd>{displayBoolean(effective.service.supervised)}</dd></div>
        </dl>
      </OperatorSection>
    </>
  );
}
