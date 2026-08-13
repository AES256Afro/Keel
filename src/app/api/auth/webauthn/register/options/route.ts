import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { registrationOptions } from "@/lib/webauthn";
import { publicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const CHALLENGE_COOKIE = "keel_wa_chal";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const options = await registrationOptions(user, publicOrigin(req));
  const store = await cookies();
  store.set(CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 300,
    path: "/",
  });
  return NextResponse.json(options);
}
