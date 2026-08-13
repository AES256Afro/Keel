import { NextRequest, NextResponse } from "next/server";
import { keelEnv } from "@/lib/env";

// What this file exists to prevent, because it happened: behind
// Tailscale Serve → Docker, the Host header the app sees is the container's
// own hostname. Build an absolute redirect from that and the browser is sent
// to http://89e559d8d1fe:3000/... - a name that exists nowhere outside the
// container. ERR_NAME_NOT_RESOLVED, straight from clicking "Today".

/**
 * A same-origin redirect with a RELATIVE Location.
 *
 * Browsers resolve it against whatever origin they are already on, which is by
 * definition the right one - no proxy, tunnel or container topology can break
 * it. Use this for every bounce inside the app; never NextResponse.redirect
 * with a URL built from the request.
 */
export function relativeRedirect(pathWithQuery: string, status: 302 | 307 = 307): NextResponse {
  // Belt and braces: refuse to emit protocol-relative ("//evil.test") or
  // absolute URLs, which would turn a helper meant to prevent bad Locations
  // into an open-redirect primitive.
  if (!pathWithQuery.startsWith("/") || pathWithQuery.startsWith("//")) {
    pathWithQuery = "/";
  }
  return new NextResponse(null, { status, headers: { Location: pathWithQuery } });
}

/**
 * The origin the USER'S BROWSER sees - for values that leave the app and must
 * round-trip externally: OAuth redirect URIs, WebAuthn origins.
 *
 * Resolution order:
 *   1. KEEL_PUBLIC_URL - explicit, set once in the deployment env. The only
 *      fully deterministic answer; every proxied deployment should set it.
 *   2. X-Forwarded-Host/-Proto - standard proxy headers when present.
 *   3. The Host header - correct for direct connections (dev, LAN).
 */
export function publicOrigin(req: NextRequest): string {
  const configured = keelEnv("PUBLIC_URL")?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host") ||
    req.nextUrl.host;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The same resolution for server components, which have Headers, not a request. */
export function publicOriginFromHeaders(h: Headers): string {
  const configured = keelEnv("PUBLIC_URL")?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  return `${proto}://${host}`;
}
