import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { verifyRegistration } from "@/lib/webauthn";
import { publicOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const CHALLENGE_COOKIE = "keel_wa_chal";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const store = await cookies();
  const expectedChallenge = store.get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ error: "Registration expired  -  try again." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  try {
    const ok = await verifyRegistration(
      user.id,
      body.response,
      expectedChallenge,
      publicOrigin(req),
      String(body.name ?? "Security key")
    );
    store.delete(CHALLENGE_COOKIE);
    if (!ok) return NextResponse.json({ error: "Could not verify the key." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    store.delete(CHALLENGE_COOKIE);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Verification failed" },
      { status: 400 }
    );
  }
}
