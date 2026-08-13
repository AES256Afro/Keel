// Instance access control for a single-owner deployment.
//
// This is a PERSONAL Keel - not a multi-tenant host. Before exposing it to the
// internet (Cloudflare Tunnel), lock it down so only your own Google account(s)
// can sign in. Two layers, either of which enforces:
//   • Environment (hard lock, can't be changed from the web UI):
//       KEEL_ALLOWED_EMAILS="you@gmail.com, other@you.com"
//       KEEL_DISABLE_SIGNUP=1
//   • In-app settings (Settings -> Registration and sign-in), stored in AppSetting.
// The environment always wins, so a compromised session can never widen access
// beyond what the server operator configured.

import { prisma } from "@/lib/prisma";
import { configuredOwnerEmails } from "@/lib/instance";
import { keelEnv } from "@/lib/env";
import type { Prisma } from "@prisma/client";

const KEY_ALLOWED = "access.allowedEmails";
const KEY_SIGNUP_DISABLED = "access.signupDisabled";

function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@"\\]+@[^\s@"\\]+$/.test(email);
}

function normalizeEmailValues(values: string[], source: string): string[] {
  const normalized = values.map((email) => email.trim().toLowerCase());
  if (normalized.some((email) => email.length === 0 || !validEmail(email))) {
    throw new AccessPolicyError(`${source} contains an invalid email address.`);
  }
  return Array.from(new Set(normalized));
}

function envAllowed(): { configured: boolean; value: string[] } {
  const raw = keelEnv("ALLOWED_EMAILS");
  if (raw == null || raw.trim() === "") return { configured: false, value: [] };
  const tokens = raw
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  // An asserted host boundary must never disappear because of a typo. Keep
  // the field locked and use an empty, fail-closed sentinel that the policy
  // functions distinguish from a genuinely unconfigured open instance.
  if (tokens.length === 0 || tokens.some((email) => !validEmail(email))) {
    return { configured: true, value: [] };
  }
  return { configured: true, value: Array.from(new Set(tokens)) };
}

function envSignupDisabled(): { configured: boolean; value: boolean } {
  const raw = keelEnv("DISABLE_SIGNUP");
  if (raw == null || raw.trim() === "") return { configured: false, value: false };
  const normalized = raw.trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(normalized)) return { configured: true, value: true };
  if (/^(0|false|no|off)$/.test(normalized)) return { configured: true, value: false };
  // Invalid nonempty values fail closed and remain visibly environment-locked.
  return { configured: true, value: true };
}

type AccessSettingClient = Pick<Prisma.TransactionClient, "appSetting">;

type StoredSetting =
  | { present: false }
  | { present: true; value: string };

class AccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessPolicyError";
  }
}

async function getSetting(client: AccessSettingClient, key: string): Promise<StoredSetting> {
  // Absence is a valid fresh-install state. A query failure is not absence and
  // must propagate so callers can fail closed rather than reopening access.
  const row = await client.appSetting.findUnique({ where: { key } });
  return row ? { present: true, value: row.value } : { present: false };
}

async function setSetting(client: AccessSettingClient, key: string, value: string) {
  await client.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export interface AccessSettings {
  allowedEmails: string[];
  signupDisabled: boolean;
  /** True when the environment fixes the allowlist. */
  allowedEmailsLocked: boolean;
  /** True when the environment fixes whether registration is open. */
  signupLocked: boolean;
  /** Compatibility summary for callers that only need to know if either field is locked. */
  envLocked: boolean;
}

async function loadAccessSettings(client: AccessSettingClient): Promise<AccessSettings> {
  const eAllowed = envAllowed();
  const eSignup = envSignupDisabled();

  const rawAllowed = await getSetting(client, KEY_ALLOWED);
  const rawSignup = await getSetting(client, KEY_SIGNUP_DISABLED);

  let dbAllowed: string[] = [];
  if (rawAllowed.present) {
    try {
      const parsed: unknown = JSON.parse(rawAllowed.value);
      if (!Array.isArray(parsed) || !parsed.every((email) => typeof email === "string")) {
        throw new Error("not a string array");
      }
      dbAllowed = normalizeEmailValues(parsed, "The stored access allowlist");
    } catch {
      throw new AccessPolicyError(
        "The stored access allowlist is malformed. Repair it before changing access settings."
      );
    }
  }

  let dbSignup = false;
  if (rawSignup.present) {
    if (rawSignup.value === "true") dbSignup = true;
    else if (rawSignup.value === "false") dbSignup = false;
    else {
      throw new AccessPolicyError(
        "The stored registration switch is malformed. Repair it before changing access settings."
      );
    }
  }

  return {
    allowedEmails: eAllowed.configured ? eAllowed.value : dbAllowed,
    signupDisabled: eSignup.configured ? eSignup.value : dbSignup,
    allowedEmailsLocked: eAllowed.configured,
    signupLocked: eSignup.configured,
    envLocked: eAllowed.configured || eSignup.configured,
  };
}

export async function getAccessSettings(): Promise<AccessSettings> {
  return loadAccessSettings(prisma);
}

/** Persist UI-managed access settings. Each environment-managed field remains
 *  unchanged, while the other field can still be managed here. */
export async function updateAccessSettings(opts: {
  allowedEmails: string[];
  signupDisabled: boolean;
  ownerEmail: string;
}) {
  return prisma.$transaction(async (tx) => {
    // Validate the policy in the same transaction that changes it. Corrupt
    // rows can therefore never be mistaken for absent rows and overwritten by
    // a request that would silently reopen the instance.
    const current = await loadAccessSettings(tx);
    if (current.allowedEmailsLocked && current.signupLocked) {
      throw new Error("Access is locked by environment variables and can't be changed here.");
    }
    const allowed = current.allowedEmailsLocked
      ? current.allowedEmails
      : normalizeEmailValues(opts.allowedEmails, "The access allowlist");
    if (!current.allowedEmailsLocked && allowed.length > 0) {
      // The caller must keep themselves in - and, when KEEL_OWNER_EMAIL pins
      // instance ownership, every pinned owner too. Otherwise a narrowed
      // allowlist can evict the operator from their own server.
      const mustKeep = new Set([opts.ownerEmail.toLowerCase(), ...configuredOwnerEmails()]);
      const missing = [...mustKeep].filter((e) => !allowed.includes(e));
      if (missing.length > 0) {
        throw new Error(
          `The allowlist must keep the instance owner: add ${missing.join(", ")}, or you'll lock yourself out.`
        );
      }
    }
    if (!current.allowedEmailsLocked) {
      await setSetting(tx, KEY_ALLOWED, JSON.stringify(allowed));
    }
    if (!current.signupLocked) {
      await setSetting(tx, KEY_SIGNUP_DISABLED, opts.signupDisabled ? "true" : "false");
    }
    return loadAccessSettings(tx);
  });
}

/** Whether an existing account with this email may authenticate at all. */
export async function emailAllowed(email: string): Promise<boolean> {
  try {
    const { allowedEmails, allowedEmailsLocked } = await getAccessSettings();
    if (allowedEmailsLocked && allowedEmails.length === 0) return false;
    if (allowedEmails.length === 0) return true; // open instance
    return allowedEmails.includes(email.toLowerCase());
  } catch {
    return false;
  }
}

/** Whether a brand-new account may be created for this email. */
export async function signupAllowed(email: string): Promise<boolean> {
  try {
    const { allowedEmails, allowedEmailsLocked, signupDisabled } = await getAccessSettings();
    // This is an unconditional hard stop. In particular, do not infer a safe
    // first-user exception from OWNER_EMAIL + ALLOWED_EMAILS: a password form
    // does not prove that the visitor controls that mailbox. Installer recovery
    // for the broken 1.2.1 local configuration happens before the server starts.
    if (signupDisabled) return false;
    if (allowedEmailsLocked && allowedEmails.length === 0) return false;
    if (allowedEmails.length > 0 && !allowedEmails.includes(email.toLowerCase())) return false;
    return true;
  } catch {
    return false;
  }
}
