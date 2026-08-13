import { NextResponse } from "next/server";
import { requireOwner, handleApiError } from "@/lib/api";
import { cloudConnected, listCloudBackups } from "@/lib/cloud";

export const runtime = "nodejs";

/** Backups this workspace has uploaded to Google Drive / OneDrive / R2.
 *  Returns an empty list rather than an error when nothing is connected, so
 *  Settings can render the section unconditionally. */
export async function GET() {
  try {
    const { workspace } = await requireOwner();
    if (!cloudConnected(workspace)) return NextResponse.json({ backups: [] });
    try {
      return NextResponse.json({ backups: await listCloudBackups(workspace) });
    } catch (err) {
      // An expired refresh token shouldn't break the whole Settings page.
      return NextResponse.json({
        backups: [],
        error: err instanceof Error ? err.message : "Could not list cloud backups",
      });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
