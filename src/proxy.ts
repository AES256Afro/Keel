import { NextRequest, NextResponse } from "next/server";
import { keelEnv } from "@/lib/env";

// Host-based routing: the same deployment serves two faces.
//   * notes.example.com (default) -> the Keel notebook (routes as-is)
//   * example.com / www.*          -> the public site (rewritten under /site)
// The apex host(s) are configured via KEEL_SITE_HOSTS (comma-separated). When
// unset (local dev), nothing is rewritten - hit /site and /admin directly.
const SITE_HOSTS = (keelEnv("SITE_HOSTS") ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Paths that keep their meaning on every host (shared auth, admin, APIs, the
// site routes themselves, and anything with a file extension).
function isReserved(pathname: string): boolean {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/site") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname === "/desktop-linked" ||
    pathname.includes(".")
  );
}

/**
 * Content-Security-Policy with a per-request nonce.
 *
 * Next.js reads the nonce out of this header and stamps it onto the scripts it
 * injects, so no inline script runs without it. `strict-dynamic` then lets those
 * trusted scripts load the chunk graph without enumerating every URL.
 *
 * Keel loads nothing from a third party - no CDN, no analytics, no fonts - so
 * everything else collapses to 'self'. The one concession is style-src
 * 'unsafe-inline': ProseMirror positions the slash menu by writing inline
 * style attributes (see Editor.tsx), and inline styles are a marginal XSS
 * vector compared to script.
 */
function contentSecurityPolicy(nonce: string, isDev: boolean, upgradeInsecure: boolean): string {
  const scriptSrc = isDev
    ? // `next dev` uses eval for HMR; production never does.
      `'self' 'unsafe-eval' 'unsafe-inline'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    // Every fetch in the app is same-origin.
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // Server Actions and every form post go to this origin.
    `form-action 'self'`,
    `manifest-src 'self'`,
    ...(upgradeInsecure ? [`upgrade-insecure-requests`] : []),
  ].join("; ");
}

export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const { pathname } = req.nextUrl;
  const hostname = req.nextUrl.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  // The desktop build and direct local installs use production assets over
  // loopback HTTP. Upgrading those same-origin links to HTTPS breaks local
  // navigation because no TLS server exists there.
  const csp = contentSecurityPolicy(nonce, isDev, !isDev && !isLoopback);

  // Next reads the nonce back out of the request's CSP header when rendering.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const url = req.nextUrl.clone();
  const rewriting = SITE_HOSTS.includes(host) && !isReserved(pathname);
  if (rewriting) url.pathname = `/site${pathname === "/" ? "" : pathname}`;

  const res = rewriting
    ? NextResponse.rewrite(url, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });

  // /api/attachments and /api/workspace/import never reach this proxy
  // (see the matcher): the attachment serving route carries its own, far
  // stricter CSP (`sandbox`), and both routes take uploads that must stream
  // past the proxy's body buffer rather than through it. Each enforces
  // auth and rate limits internally.
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    // Static assets and prefetches don't need a per-request nonce, and skipping
    // them keeps the proxy off the hot path.
    {
      source: "/((?!_next/static|_next/image|favicon.ico|api/attachments|api/workspace/import).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
