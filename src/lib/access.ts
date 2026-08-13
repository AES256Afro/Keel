// Instance access control for a single-owner deployment.
//
// This is a PERSONAL Keel - not a multi-tenant host. Before exposing it to the
// internet (Cloudflare Tunnel), lock it down so only your own Google account(s)
// can sign in. Two layers, either of which enforces:
//   • Environment (hard lock, can't be changed from the web UI):
//       KEEL_ALLOWED_EMAILS="you@gmail.com, other@you.com"
//       KEEL_DISABLE_SIGNUP=1
//   • In-app settings (Settings → Access), stored in AppSetting.
// The environment always wins, so a compromised session can never widen access
// beyond what the server operator configured.

import { prisma } from "@/lib/prisma";
import { configuredOwnerEmails } from "@/lib/instance";
import { keelEnv } from "@/lib/env";

const KEY_ALLOWED = "access.allowedEmails";
const KEY_SIGNUP_DISABLED = "access.signupDisabled";

function parseEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@"))
    )
  );
}

function envAllowed(): string[] | null {
  const raw = keelEnv("ALLOWED_EMAILS");
  return raw ? parseEmails(raw) : null;
}

function envSignupDisabled(): boolean | null {
  const raw = keelEnv("DISABLE_SIGNUP");
  if (raw == null || raw === "") return null;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch {
    return null; // table may not exist yet on a very old DB
  }
}

async function setSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export interface AccessSettings {
  allowedEmails: string[];
  signupDisabled: boolean;
  /** True when the environment is enforcing - the UI shows these read-only. */
  envLocked: boolean;
}

export async function getAccessSettings(): Promise<AccessSettings> {
  const eAllowed = envAllowed();
  const eSignup = envSignupDisabled();

  let dbAllowed: string[] = [];
  const rawAllowed = await getSetting(KEY_ALLOWED);
  if (rawAllowed) {
    try {
      const parsed = JSON.parse(rawAllowed);
      if (Array.isArray(parsed)) dbAllowed = parseEmails(parsed.join(","));
    } catch {
      dbAllowed = [];
    }
  }
  const dbSignup = (await getSetting(KEY_SIGNUP_DISABLED)) === "true";

  return {
    allowedEmails: eAllowed ?? dbAllowed,
    signupDisabled: eSignup ?? dbSignup,
    envLocked: eAllowed != null || eSignup != null,
  };
}

/** Persist UI-managed access settings. Rejected when the environment is
 *  enforcing, and refuses to lock the owner out of their own instance. */
export async function updateAccessSettings(opts: {
  allowedEmails: string[];
  signupDisabled: boolean;
  ownerEmail: string;
}) {
  const current = await getAccessSettings();
  if (current.envLocked) {
    throw new Error("Access is locked by environment variables and can't be changed here.");
  }
  const allowed = parseEmails(opts.allowedEmails.join(","));
  if (allowed.length > 0) {
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
  await setSetting(KEY_ALLOWED, JSON.stringify(allowed));
  await setSetting(KEY_SIGNUP_DISABLED, opts.signupDisabled ? "true" : "false");
  return getAccessSettings();
}

/** Whether an existing account with this email may authenticate at all. */
export async function emailAllowed(email: string): Promise<boolean> {
  const { allowedEmails } = await getAccessSettings();
  if (allowedEmails.length === 0) return true; // open instance
  return allowedEmails.includes(email.toLowerCase());
}

/** Whether a brand-new account may be created for this email. */
export async function signupAllowed(email: string): Promise<boolean> {
  const { allowedEmails, signupDisabled } = await getAccessSettings();
  if (signupDisabled) return false;
  if (allowedEmails.length > 0 && !allowedEmails.includes(email.toLowerCase())) return false;
  return true;
}
