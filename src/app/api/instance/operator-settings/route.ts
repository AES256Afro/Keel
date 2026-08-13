import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { ApiError, enforceLimit, handleApiError, requireInstanceOwner } from "@/lib/api";
import { effectiveConfiguration } from "@/lib/effective-config";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";
import {
  clearBackupPassphrase,
  getBackupPassphraseStatus,
  getSiteSettingsStatus,
  InstanceSettingsError,
  saveBackupPassphrase,
  saveSiteSettings,
} from "@/lib/instance-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requireExactKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, "Request contains an unknown operator-settings field");
  }
}

async function responseBody() {
  const [site, backupPassphrase] = await Promise.all([
    getSiteSettingsStatus(),
    getBackupPassphraseStatus(),
  ]);
  return { site, backupPassphrase, effective: effectiveConfiguration() };
}

export async function GET() {
  try {
    await requireInstanceOwner();
    return NextResponse.json(await responseBody(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user } = await requireInstanceOwner();
    requireSameOriginMutation(req, "Change server settings from Keel Settings");
    requireJsonRequest(req, "Operator settings requests must use application/json");
    await enforceLimit("operator-settings", {
      limit: 12,
      windowMs: 10 * 60 * 1000,
      blockMs: 10 * 60 * 1000,
      userId: user.id,
    });
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      throw new ApiError(413, "Operator settings requests are limited to 16 KB");
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      throw new ApiError(413, "Operator settings requests are limited to 16 KB");
    }
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {}
    if (!body) throw new ApiError(400, "Request body must be a JSON object");

    if (body.section === "site" && body.action === "save") {
      requireExactKeys(body, ["section", "action", "fields"]);
      const fields =
        body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
          ? (body.fields as Record<string, unknown>)
          : {};
      await saveSiteSettings(fields);
      await audit("operator.settings", user, {
        target: "site",
        detail: { operation: "save", fields: Object.keys(fields) },
      });
    } else if (body.section === "backup-passphrase" && body.action === "save") {
      requireExactKeys(body, ["section", "action", "passphrase"]);
      await saveBackupPassphrase(body.passphrase);
      await audit("operator.settings", user, {
        target: "backup-passphrase",
        detail: { operation: "save", configured: true },
      });
    } else if (body.section === "backup-passphrase" && body.action === "clear") {
      requireExactKeys(body, ["section", "action", "confirm"]);
      if (body.confirm !== true) {
        throw new ApiError(400, "Set confirm to true to clear the managed backup passphrase");
      }
      await clearBackupPassphrase();
      await audit("operator.settings", user, {
        target: "backup-passphrase",
        detail: { operation: "clear", configured: false },
      });
    } else {
      throw new ApiError(400, "Unknown operator settings action");
    }
    return NextResponse.json(await responseBody(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InstanceSettingsError) {
      return handleApiError(new ApiError(error.status, error.message));
    }
    return handleApiError(error);
  }
}
