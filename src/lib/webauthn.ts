// WebAuthn / FIDO2 second-factor (e.g. YubiKey). Thin wrappers over
// @simplewebauthn/server. Credentials require a SECURE CONTEXT in the browser:
// HTTPS, or localhost. Over Tailscale, use `tailscale serve` (HTTPS).
//
// The relying-party identity must be stable and match the browser's origin.
// Behind a proxy (Caddy / Tailscale Serve) set these explicitly:
//   KEEL_WEBAUTHN_RP_ID   = noteserver.your-tailnet.ts.net
//   KEEL_WEBAUTHN_ORIGIN  = https://noteserver.your-tailnet.ts.net
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { keelEnv } from "@/lib/env";

const RP_NAME = "Keel";

export function rpConfig(requestOrigin: string) {
  const origin = keelEnv("WEBAUTHN_ORIGIN") || requestOrigin;
  let rpID = keelEnv("WEBAUTHN_RP_ID");
  if (!rpID) {
    try {
      rpID = new URL(origin).hostname;
    } catch {
      rpID = "localhost";
    }
  }
  return { rpID, origin, rpName: RP_NAME };
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function userHasCredentials(userId: string): Promise<boolean> {
  return (await prisma.credential.count({ where: { userId } })) > 0;
}

export async function listCredentials(userId: string) {
  return prisma.credential.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true, backedUp: true },
  });
}

/* ---------- Registration (enroll a key) ---------- */

export async function registrationOptions(
  user: { id: string; email: string; username: string | null },
  requestOrigin: string
) {
  const { rpID, rpName } = rpConfig(requestOrigin);
  const creds = await prisma.credential.findMany({ where: { userId: user.id } });
  return generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.username ?? user.email,
    attestationType: "none",
    excludeCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: { residentKey: "discouraged", userVerification: "preferred" },
  });
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  requestOrigin: string,
  name: string
): Promise<boolean> {
  const { rpID, origin } = rpConfig(requestOrigin);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const exists = await prisma.credential.findFirst({ where: { credentialId: credential.id } });
  if (exists) return true; // already enrolled - idempotent

  await prisma.credential.create({
    data: {
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name.trim() || "Security key",
    },
  });
  return true;
}

/* ---------- Authentication (second factor at login) ---------- */

export async function authenticationOptions(userId: string, requestOrigin: string) {
  const { rpID } = rpConfig(requestOrigin);
  const creds = await prisma.credential.findMany({ where: { userId } });
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    userVerification: "preferred",
  });
}

export async function verifyAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  requestOrigin: string
): Promise<boolean> {
  const { rpID, origin } = rpConfig(requestOrigin);
  const cred = await prisma.credential.findFirst({
    where: { userId, credentialId: response.id },
  });
  if (!cred) return false;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
      counter: cred.counter,
      transports: parseTransports(cred.transports),
    },
  });
  if (!verification.verified) return false;

  await prisma.credential.update({
    where: { id: cred.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });
  return true;
}
