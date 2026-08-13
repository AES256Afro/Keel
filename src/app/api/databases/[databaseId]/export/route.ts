import { NextRequest, NextResponse } from "next/server";
import { requireContext, requireDatabase, enforceLimit, handleApiError } from "@/lib/api";
import { getDatabaseDTO } from "@/lib/pages";
import { valueToText } from "@/lib/values";
import { toCsv } from "@/lib/csv";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ databaseId: string }> }
) {
  try {
    const { user, workspace } = await requireContext();
    const { databaseId } = await params;
    // Loads every record, page and value, then builds the whole CSV in memory -
    // the same weight class as a workspace export, so it gets the same budget.
    await enforceLimit("database-export", { limit: 10, windowMs: 60_000, userId: user.id });
    await requireDatabase(databaseId, workspace.id);
    const db = await getDatabaseDTO(databaseId);
    if (!db) throw new Error("Database vanished");
    const header = ["Name", ...db.properties.map((p) => p.name)];
    const rows = db.records.map((r) => [
      r.title,
      ...db.properties.map((p) => valueToText(r.values[p.id], p)),
    ]);
    const csv = toCsv([header, ...rows]);
    const filename = (db.title || "database").replace(/[^\w\- ]+/g, "").trim() || "database";
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
