import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listCredentials } from "@/lib/webauthn";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const credentials = await listCredentials(user.id);
  return NextResponse.json({ credentials });
}
