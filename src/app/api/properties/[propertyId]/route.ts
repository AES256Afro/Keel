import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEditor, handleApiError, ApiError } from "@/lib/api";
import { toJson } from "@/lib/json";
import { MAX_NAME, MAX_VALUE } from "@/lib/limits";

/** More select options than anyone scrolls through - and a bound on re-parse cost. */
const MAX_OPTIONS = 200;

/**
 * The shape every settings.options consumer indexes into: a plain object with
 * a string id and name (color is only ever string-interpolated into a CSS
 * class, so it may be absent). Anything else stored here throws during render
 * for every member of the workspace.
 */
function isOptionShaped(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const { id, name, color } = entry as { id?: unknown; name?: unknown; color?: unknown };
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_NAME &&
    typeof name === "string" &&
    name.length <= MAX_NAME &&
    (color === undefined || typeof color === "string")
  );
}

async function requireProperty(propertyId: string, workspaceId: string) {
  const property = await prisma.databaseProperty.findUnique({
    where: { id: propertyId },
    include: { database: true },
  });
  if (!property || property.database.workspaceId !== workspaceId) {
    throw new ApiError(404, "Property not found");
  }
  return property;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ propertyId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { propertyId } = await params;
    const property = await requireProperty(propertyId, workspace.id);
    const body = await req.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      data.name = body.name.trim().slice(0, MAX_NAME);
    }
    if (body.settings !== undefined) {
      // Must be a plain object: a stored "null" (or "[]") parses back fine, so
      // the {} fallback on the read path never applies, and every
      // settings.options consumer crashes the database page for all members.
      if (
        typeof body.settings !== "object" ||
        body.settings === null ||
        Array.isArray(body.settings)
      ) {
        throw new ApiError(400, "Property settings must be an object.");
      }
      // The wrapper being an object is not enough: `{"options": 42}` (or
      // entries that aren't {id, name} chips) passes the check above and
      // crashes every view of the database just as surely as a non-object
      // settings did - `.find`/`.filter`/spread on a non-array throws during
      // render. Validate the level the consumers actually dereference.
      if (body.settings.options !== undefined) {
        const options: unknown = body.settings.options;
        if (!Array.isArray(options)) {
          throw new ApiError(400, "settings.options must be an array of options.");
        }
        if (options.length > MAX_OPTIONS) {
          throw new ApiError(400, `A property can hold at most ${MAX_OPTIONS} options.`);
        }
        if (!options.every(isOptionShaped)) {
          throw new ApiError(
            400,
            "Each option must be an object with a string id and name (and an optional string color)."
          );
        }
      }
      // Bound it the same way record values are: it is re-parsed on every
      // database open.
      const encoded = toJson(body.settings);
      if (encoded.length > MAX_VALUE) {
        throw new ApiError(413, "That property configuration is too large.");
      }
      data.settings = encoded;
    }
    await prisma.databaseProperty.update({ where: { id: property.id }, data });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ propertyId: string }> }
) {
  try {
    const { workspace } = await requireEditor();
    const { propertyId } = await params;
    const property = await requireProperty(propertyId, workspace.id);
    await prisma.databaseProperty.delete({ where: { id: property.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
