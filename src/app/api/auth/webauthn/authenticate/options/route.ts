import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPending, PENDING_COOKIE } from "@/lib/pending-2fa";
import { authenticationOptions } from "@/lib/webauthn";
import { publicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const CHALLENGE_COOKIE = "keel_wa_chal";

export async function POST(req: NextRequest) {
  const store = await cookies();
  const pending = getPending(store.get(PENDING_COOKIE)?.value);
  if (!pending) {
    return NextResponse.json({ error: "Sign-in expired  -  start over." }, { status: 400 });
  }

  const options = await authenticationOptions(pending.userId, publicOrigin(req));
  store.set(CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 300,
    path: "/",
  });
  return NextResponse.json(options);
}
