import { NextResponse } from "next/server";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { appVersion, BOOT_ID, isSupervised, uptimeSeconds } from "@/lib/server-info";

// Uptime and boot id are per-process facts - never prerender them.
export const dynamic = "force-dynamic";

/** The Settings "Server" panel's facts. Instance-owner only - uptime and
 *  supervision details describe the machine, not a workspace. */
export async function GET() {
  try {
    await requireInstanceOwner();
    return NextResponse.json({
      version: appVersion(),
      uptimeSeconds: uptimeSeconds(),
      supervised: isSupervised(),
      boot: BOOT_ID,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
