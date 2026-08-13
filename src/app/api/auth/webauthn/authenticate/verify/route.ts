import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSession, createSessionToken } from "@/lib/auth";
import { consumePending, getPending, PENDING_COOKIE } from "@/lib/pending-2fa";
import { verifyAuthentication } from "@/lib/webauthn";
import { parkHandoff } from "@/lib/desktop-handoff";
import { limitByIp } from "@/lib/rate-limit";
import { publicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const CHALLENGE_COOKIE = "keel_wa_chal";

export async function POST(req: NextRequest) {
  const limit = await limitByIp("webauthn-verify", 20, 15 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `Too many attempts - try again in ${limit.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const store = await cookies();
  const pendingToken = store.get(PENDING_COOKIE)?.value;
  const pending = getPending(pendingToken);
  const expectedChallenge = store.get(CHALLENGE_COOKIE)?.value;
  if (!pending || !expectedChallenge) {
    return NextResponse.json({ error: "Sign-in expired  -  start over." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  let ok = false;
  try {
    ok = await verifyAuthentication(pending.userId, body.response, expectedChallenge, publicOrigin(req));
  } catch {
    ok = false;
  }
  store.delete(CHALLENGE_COOKIE);
  if (!ok) {
    // Burn the pending record on failure too. Otherwise a stolen password buys
    // a five-minute window of unlimited security-key attempts.
    consumePending(pendingToken);
    store.delete(PENDING_COOKIE);
    return NextResponse.json({ error: "Security key not recognized." }, { status: 400 });
  }

  // Second factor passed  -  redeem the pending state and complete sign-in.
  consumePending(pendingToken);
  store.delete(PENDING_COOKIE);

  if (pending.desktopId) {
    // Desktop flow: park the session for the app window to claim.
    const { token, expiresAt } = await createSessionToken(pending.userId);
    parkHandoff(pending.desktopId, token, expiresAt);
    return NextResponse.json({ ok: true, redirect: "/desktop-linked" });
  }

  await createSession(pending.userId);
  return NextResponse.json({ ok: true, redirect: "/" });
}
