import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/api";
import { requestFacingOrigin } from "@/lib/request-origin";

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Require an explicit same-origin browser mutation.
 *
 * SameSite cookies are still sent by a sibling subdomain, so authentication
 * alone does not prevent that sibling from submitting a blind state change.
 * Requiring the browser's Origin to match the origin Keel presents externally
 * closes that gap. Non-browser callers can set the same Origin deliberately.
 */
export function requireSameOriginMutation(req: NextRequest, message: string): void {
  const supplied = req.headers.get("origin");
  const expected = normalizedOrigin(requestFacingOrigin(req));
  if (
    !supplied ||
    !expected ||
    normalizedOrigin(supplied) !== expected ||
    req.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new ApiError(403, message);
  }
}

/** Reject CORS-safelisted text/plain bodies before a handler parses JSON. */
export function requireJsonRequest(req: NextRequest, message: string): void {
  const mediaType = (req.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") throw new ApiError(415, message);
}
