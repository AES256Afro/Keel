import { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { enforceLimit, requireContext } from "@/lib/api";
import { readSessionToken } from "@/lib/auth";
import {
  consumeGoogleAccountLinkState,
  linkGoogleIdentityToUser,
} from "@/lib/google-account-link";
import { exchangeCode, googleUserInfo, verifiedGoogleIdentity } from "@/lib/oauth";
import { prisma } from "@/lib/prisma";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";

export const runtime = "nodejs";

type LinkUxResult =
  | "linked"
  | "already-linked"
  | "cancelled"
  | "email-mismatch"
  | "conflict"
  | "expired"
  | "rate-limited"
  | "failed";

function back(result: LinkUxResult) {
  const response = relativeRedirect(`/settings?googleLink=${encodeURIComponent(result)}`);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function loginAgain() {
  const response = relativeRedirect("/login?error=google-link-session");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function boundSession(req: NextRequest, userId: string) {
  const token = readSessionToken(req.cookies);
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!session || session.userId !== userId || session.expiresAt <= new Date()) return null;
  return { id: session.id, userId: session.userId };
}

/** Finish an account-self link without creating, replacing, or parking any
 * session. Password and WebAuthn credentials are untouched; only googleId may
 * change after the existing session and Google's verified identity agree. */
export async function GET(req: NextRequest) {
  let context: Awaited<ReturnType<typeof requireContext>>;
  try {
    context = await requireContext();
  } catch {
    return loginAgain();
  }

  const { user } = context;
  const session = await boundSession(req, user.id);
  if (!session) return loginAgain();

  try {
    await enforceLimit("google-account-link-callback", {
      limit: 10,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
  } catch {
    return back("rate-limited");
  }

  const state = req.nextUrl.searchParams.get("state") ?? "";
  const consumed = await consumeGoogleAccountLinkState(session, state);
  if (!consumed.ok) {
    return back(consumed.reason === "expired" ? "expired" : "failed");
  }

  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) {
    await audit("account.google.link", user, {
      target: "google",
      detail: { result: providerError === "access_denied" ? "cancelled" : "provider-error" },
    });
    return back(providerError === "access_denied" ? "cancelled" : "failed");
  }

  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    await audit("account.google.link", user, {
      target: "google",
      detail: { result: "missing-code" },
    });
    return back("failed");
  }

  try {
    const token = await exchangeCode(
      "google",
      code,
      `${publicOrigin(req)}/api/account/google/callback`
    );
    const identity = verifiedGoogleIdentity(await googleUserInfo(token.access_token));
    if (!identity) {
      await audit("account.google.link", user, {
        target: "google",
        detail: { result: "unverified-identity" },
      });
      return back("failed");
    }

    // Exact equality is deliberate. An explicit link proves control of both
    // sessions, but using different mailboxes would make allowlist behavior and
    // future conflict recovery surprising. No email lookup selects the target.
    if (identity.email !== consumed.expectedEmail) {
      await audit("account.google.link", user, {
        target: "google",
        detail: { result: "email-mismatch" },
      });
      return back("email-mismatch");
    }

    const linked = await linkGoogleIdentityToUser(user.id, identity);
    if (!linked.ok) {
      await audit("account.google.link", user, {
        target: "google",
        detail: { result: linked.reason },
      });
      return back(linked.reason === "email-mismatch" ? "email-mismatch" : "conflict");
    }

    const result = linked.alreadyLinked ? "already-linked" : "linked";
    await audit("account.google.link", user, {
      target: "google",
      detail: { result },
    });
    return back(result);
  } catch (error) {
    // Do not put provider text, authorization codes, or token responses into a
    // URL or audit detail. The error class is enough for an operator's log.
    console.error(
      "[keel] Google account link failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    await audit("account.google.link", user, {
      target: "google",
      detail: { result: "failed" },
    });
    return back("failed");
  }
}
