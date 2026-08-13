import { NextRequest, NextResponse } from "next/server";
import { requireInstanceOwner, handleApiError, ApiError } from "@/lib/api";
import { getAccessSettings, updateAccessSettings } from "@/lib/access";
import { audit } from "@/lib/audit";

export async function GET() {
  try {
    const { user } = await requireInstanceOwner();
    const access = await getAccessSettings();
    return NextResponse.json({ access, ownerEmail: user.email });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireInstanceOwner();
    const body = await req.json().catch(() => ({}));
    const allowedEmails = Array.isArray(body.allowedEmails)
      ? body.allowedEmails.map((e: unknown) => String(e))
      : [];
    const signupDisabled = Boolean(body.signupDisabled);
    try {
      const access = await updateAccessSettings({
        allowedEmails,
        signupDisabled,
        ownerEmail: user.email,
      });
      // Who can sign in is the single most consequential setting here.
      await audit("access.update", user, {
        detail: {
          allowedEmails: access.allowedEmails,
          signupDisabled: access.signupDisabled,
        },
      });
      return NextResponse.json({ access });
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : "Could not save access settings");
    }
  } catch (err) {
    return handleApiError(err);
  }
}
