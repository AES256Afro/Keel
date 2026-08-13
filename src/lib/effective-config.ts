import { keelEnv, keelFlag } from "@/lib/env";
import { maxAttachmentBytes, attachmentQuotaBytes } from "@/lib/attachments";
import { instanceOwnerIsPinned } from "@/lib/instance";
import { isSupervised } from "@/lib/server-info";

export interface EffectiveConfiguration {
  database: { dialect: "SQLite" | "PostgreSQL" | "Unknown" };
  publicOrigin: { configured: boolean; value: string };
  network: { bind: "loopback" | "all interfaces" | "custom"; port: number };
  proxy: { trusted: boolean; trustedHops: number | null };
  webauthn: { rpId: string; origin: string };
  access: { ownerPinnedByEnvironment: boolean; allowlistLocked: boolean; registrationLocked: boolean };
  storage: {
    backupRoot: "default" | "custom";
    arbitraryBackupPaths: boolean;
    maxAttachmentMb: number;
    attachmentQuotaMb: number;
  };
  service: { supervised: boolean };
}

function databaseDialect(): EffectiveConfiguration["database"]["dialect"] {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (url.startsWith("file:")) return "SQLite";
  if (/^postgres(?:ql)?:/i.test(url)) return "PostgreSQL";
  return "Unknown";
}

function bindSummary(): EffectiveConfiguration["network"]["bind"] {
  const value = (process.env.HOST ?? process.env.HOSTNAME ?? "127.0.0.1")
    .trim()
    .toLowerCase();
  if (value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]") {
    return "loopback";
  }
  if (value === "0.0.0.0" || value === "::" || value === "[::]") return "all interfaces";
  return "custom";
}

function publicUrlStatus(): EffectiveConfiguration["publicOrigin"] {
  const configured = keelEnv("PUBLIC_URL")?.trim();
  if (!configured) return { configured: false, value: "Derived from each request" };
  try {
    return { configured: true, value: new URL(configured).origin };
  } catch {
    return { configured: true, value: "Configured value is invalid" };
  }
}

export function effectiveConfiguration(): EffectiveConfiguration {
  const publicOrigin = publicUrlStatus();
  const webauthnOrigin = keelEnv("WEBAUTHN_ORIGIN")?.trim();
  const webauthnRpId = keelEnv("WEBAUTHN_RP_ID")?.trim();
  let derivedRpId = "Derived from the public origin";
  if (!webauthnRpId && publicOrigin.configured && /^https?:\/\//.test(publicOrigin.value)) {
    try {
      derivedRpId = new URL(publicOrigin.value).hostname;
    } catch {}
  }
  const portValue = Number(process.env.PORT ?? 3000);
  const trustedHops = keelFlag("TRUST_PROXY")
    ? Math.max(1, Number(keelEnv("TRUSTED_PROXY_HOPS") ?? "1") || 1)
    : null;
  return {
    database: { dialect: databaseDialect() },
    publicOrigin,
    network: {
      bind: bindSummary(),
      port: Number.isFinite(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 3000,
    },
    proxy: { trusted: keelFlag("TRUST_PROXY"), trustedHops },
    webauthn: {
      rpId: webauthnRpId || derivedRpId,
      origin: webauthnOrigin
        ? (() => {
            try {
              return new URL(webauthnOrigin).origin;
            } catch {
              return "Configured value is invalid";
            }
          })()
        : "Derived from the browser origin",
    },
    access: {
      ownerPinnedByEnvironment: instanceOwnerIsPinned(),
      allowlistLocked: keelEnv("ALLOWED_EMAILS") != null,
      registrationLocked: keelEnv("DISABLE_SIGNUP") != null,
    },
    storage: {
      backupRoot: keelEnv("BACKUP_DIR") ? "custom" : "default",
      arbitraryBackupPaths: keelFlag("ALLOW_ANY_BACKUP_DIR"),
      maxAttachmentMb: Math.round(maxAttachmentBytes() / 1024 / 1024),
      attachmentQuotaMb: Math.round(attachmentQuotaBytes() / 1024 / 1024),
    },
    service: { supervised: isSupervised() },
  };
}
