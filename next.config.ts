import type { NextConfig } from "next";

/**
 * Headers that don't depend on a per-request nonce. The Content-Security-Policy
 * itself is set in proxy.ts, because it carries a fresh nonce each request.
 */
const securityHeaders = [
  // Keel is never meant to be framed. Belt (header) and braces (CSP
  // frame-ancestors) - the header still covers browsers that see it first.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak page paths (which contain page IDs) to anywhere off-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // Nothing in Keel needs these. WebAuthn is deliberately not restricted -
    // security keys need publickey-credentials-get on the same origin.
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Served behind Caddy / Tailscale Serve over TLS. Browsers ignore HSTS on
  // non-secure origins, so this is safe to send unconditionally.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // The desktop build packages a self-contained server (see scripts/desktop-build.mjs).
  output: process.env.KEEL_STANDALONE ? "standalone" : undefined,

  // Keel renders no <Image>, so the optimizer at /_next/image is nothing but
  // attack surface - it is the sharp/libvips and SVG-DoS advisory path. Off.
  images: { unoptimized: true },

  // Don't advertise the framework version to scanners.
  poweredByHeader: false,

  // Caddy compresses for the VPS, but the desktop app, a local install and a
  // Tailscale-direct connection have no proxy in front of them.
  compress: true,

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Everything here is per-user and session-dependent. Without this a
        // shared proxy could serve one person's workspace to another.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Vary", value: "Cookie" },
        ],
      },
      {
        // Attachments are the one API surface that may cache: a given id
        // always serves the same bytes, and `private` keeps shared proxies
        // out just as firmly as no-store does. Listed after /api/:path* so
        // the more specific rule wins.
        source: "/api/attachments/:path*",
        headers: [
          { key: "Cache-Control", value: "private, max-age=31536000, immutable" },
          { key: "Vary", value: "Cookie" },
        ],
      },
    ];
  },
};

export default nextConfig;
