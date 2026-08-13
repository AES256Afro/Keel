// Is this request part of the desktop app's local sign-in handoff?
//
// The handoff exists because Google refuses OAuth inside an Electron window, so
// sign-in runs in the system browser and the resulting session is parked for the
// app window to redeem. That redemption endpoint is necessarily unauthenticated
// - it *is* how you become authenticated - which is fine on 127.0.0.1 and
// dangerous anywhere else: an attacker can park their own session and then get a
// victim to load the claim URL, silently signing the victim into the attacker's
// account (session fixation).
//
// So the handoff only exists on loopback. On the VPS or over Tailscale, where
// Keel is reachable by someone else, these endpoints are simply not there.

import type { NextRequest } from "next/server";
import { keelFlag } from "@/lib/env";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** Strip the port (and IPv6 brackets) from a Host / X-Forwarded-Host value. */
function hostnameOf(value: string): string {
  const v = value.trim().toLowerCase();
  return v.startsWith("[") ? v.slice(0, v.indexOf("]") + 1) : v.split(":")[0];
}

function isLoopbackAddress(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    v === "::1" ||
    v === "localhost" ||
    v === "0.0.0.0" ||
    v.startsWith("127.") ||
    // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    /^::ffff:127\./.test(v)
  );
}

export function isDesktopHandoffAllowed(req: NextRequest): boolean {
  // The Electron shell sets this when it spawns the bundled server, so a
  // custom PORT/hostname setup still works.
  if (keelFlag("DESKTOP_HANDOFF")) return true;

  if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.get("host") ?? ""))) return false;

  // `next start` synthesizes x-forwarded-* for every request, so their mere
  // presence proves nothing - the VALUES are what distinguish a local socket
  // from a real proxy hop. Any non-loopback hop means the browser reached us
  // through something else, whatever the upstream Host header claims.
  const xfh = req.headers.get("x-forwarded-host");
  if (xfh && !LOOPBACK_HOSTS.has(hostnameOf(xfh))) return false;

  const xff = req.headers.get("x-forwarded-for");
  if (xff && !xff.split(",").every((hop) => isLoopbackAddress(hop))) return false;

  return true;
}
