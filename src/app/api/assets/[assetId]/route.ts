import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ApiError, handleApiError, requireContext } from "@/lib/api";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function uploadRoot() {
  return (
    process.env.NOPIN_UPLOAD_DIR ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "uploads")
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  try {
    const { workspace } = await requireContext();
    const { assetId } = await params;
    if (path.basename(assetId) !== assetId || !/^[a-z0-9-]+\.(jpg|png|gif|webp)$/.test(assetId)) {
      throw new ApiError(404, "Image not found");
    }
    const filePath = path.join(
      /* turbopackIgnore: true */ uploadRoot(),
      workspace.id,
      assetId
    );
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(/* turbopackIgnore: true */ filePath);
    } catch {
      throw new ApiError(404, "Image not found");
    }
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPES[path.extname(assetId)] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
