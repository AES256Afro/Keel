import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession, createSessionToken } from "@/lib/auth";
import { exchangeCode, googleUserInfo } from "@/lib/oauth";
import { provisionUser } from "@/lib/signup";
import { parkHandoff } from "@/lib/desktop-handoff";
import { emailAllowed, signupAllowed } from "@/lib/access";
import { userHasCredentials } from "@/lib/webauthn";
import { createPending, PENDING_COOKIE } from "@/lib/pending-2fa";
import { publicOrigin, relativeRedirect } from "@/lib/request-origin";

/** Google sign-in callback: find or create the account, start a session. */
export async function GET(req: NextRequest) {
  const fail = (reason: string, detail?: string) => {
    let url = `/login?error=${encodeURIComponent(reason)}`;
    // Raw exception text in a query string ends up in browser history, proxy
    // logs and referrers. Useful while developing; never in production.
    if (detail && process.env.NODE_ENV !== "production") {
      url += `&detail=${encodeURIComponent(detail.slice(0, 200))}`;
    }
    if (detail) console.error(`[keel] google sign-in: ${reason}: ${detail}`);
    return relativeRedirect(url);
  };

  // Google can bounce back with its own error (e.g. access_denied) instead of a
  // code  -  surface it rather than a generic failure.
  const googleError = req.nextUrl.searchParams.get("error");
  if (googleError) {
    console.error("[keel] google returned error:", googleError);
    return fail("google-auth-failed", googleError);
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("keel-oauth-state")?.value;
  if (!code || !state) return fail("google-auth-failed", "missing code/state from Google");
  if (!expected) return fail("google-auth-failed", "sign-in state cookie missing (start over)");
  if (state !== expected) return fail("google-auth-failed", "state mismatch (start over)");

  try {
    const token = await exchangeCode(
      "google",
      code,
      `${publicOrigin(req)}/api/auth/google/callback`
    );
    const info = await googleUserInfo(token.access_token);
    const email = info.email.toLowerCase();

    let user =
      (await prisma.user.findFirst({ where: { googleId: info.id } })) ??
      (await prisma.user.findUnique({ where: { email } }));
    if (user) {
      // Existing account signing in  -  enforce the instance allowlist.
      if (!(await emailAllowed(email))) return fail("access-denied", "not allowed on this instance");
      // Link the Google identity to an existing password account on first use.
      if (!user.googleId) {
        user = await prisma.user.update({ where: { id: user.id }, data: { googleId: info.id } });
      }
    } else {
      // Brand-new account  -  only if sign-ups are open (and allowlisted).
      if (!(await signupAllowed(email))) return fail("access-denied", "new sign-ups are disabled");
      user = await provisionUser({
        name: info.name || email.split("@")[0],
        email,
        googleId: info.id,
      });
    }

    const desktopId = req.cookies.get("keel-oauth-desktop")?.value;

    // Second factor: if this account enrolled a security key, require it before
    // completing sign-in  -  even via Google. Park a pending record (carrying the
    // desktop handoff id, if any) and send the browser to /2fa.
    if (await userHasCredentials(user.id)) {
      const pendingToken = createPending(user.id, desktopId);
      const res = relativeRedirect("/2fa");
      res.cookies.set(PENDING_COOKIE, pendingToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 300,
        path: "/",
      });
      res.cookies.delete("keel-oauth-state");
      res.cookies.delete("keel-oauth-desktop");
      return res;
    }

    // Desktop flow: the browser did the (Google-trusted) sign-in, but the app
    // window needs the session. Park it under the app's handoff id and send the
    // browser to a "return to the app" page instead of signing the browser in.
    if (desktopId) {
      const { token, expiresAt } = await createSessionToken(user.id);
      parkHandoff(desktopId, token, expiresAt);
      const res = relativeRedirect("/desktop-linked");
      res.cookies.delete("keel-oauth-state");
      res.cookies.delete("keel-oauth-desktop");
      return res;
    }

    await createSession(user.id);
    const res = relativeRedirect("/");
    res.cookies.delete("keel-oauth-state");
    return res;
  } catch (err) {
    console.error("[keel] google sign-in failed", err);
    return fail("google-auth-failed", err instanceof Error ? err.message : String(err));
  }
}
