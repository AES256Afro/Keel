import { NextRequest, NextResponse } from "next/server";
import { requireInstanceOwner, handleApiError, ApiError } from "@/lib/api";
import { listAuditEvents } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * The audit trail, newest first. Read-only by design - there is deliberately no
 * write or delete endpoint, so the record cannot be edited from the thing it is
 * recording. Retention is enforced by the maintenance sweep, not by a caller.
 */
export async function GET(req: NextRequest) {
  try {
    await requireInstanceOwner();
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
    // An unparseable cursor produced `Invalid Date`, which Prisma rejected as a
    // 500. It is bad input, so say so.
    const raw = req.nextUrl.searchParams.get("before");
    if (raw && Number.isNaN(Date.parse(raw))) {
      throw new ApiError(400, "`before` must be an ISO timestamp.");
    }
    return NextResponse.json({
      events: await listAuditEvents(Number.isFinite(limit) ? limit : 100, raw ?? undefined),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
