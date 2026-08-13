import { NextResponse } from "next/server";
import { requireInstanceOwner, handleApiError } from "@/lib/api";
import { appVersion } from "@/lib/server-info";

export const dynamic = "force-dynamic";

const REPO = "AES256Afro/Keel";
const CACHE_MS = 6 * 60 * 60 * 1000;

const g = globalThis as unknown as {
  __keelUpdateCache?: { at: number; latest: string | null; url: string | null };
};

/** [major, minor, patch] compare - enough for our own tags. */
function newer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * "Is there a newer Keel?" for the Settings → Server panel.
 *
 * Asks GitHub's public releases API (cached six hours - checking for updates
 * must never become the reason the instance talks to the internet often).
 * Failure is a first-class answer, not an error: a private repository, an
 * offline server or a rate limit all report "couldn't check" and the panel
 * says so instead of pretending to know.
 */
export async function GET() {
  try {
    await requireInstanceOwner();
    const current = appVersion();

    if (!g.__keelUpdateCache || Date.now() - g.__keelUpdateCache.at > CACHE_MS) {
      let latest: string | null = null;
      let url: string | null = null;
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "keel-server" },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const rel = await res.json();
          latest = typeof rel.tag_name === "string" ? rel.tag_name.replace(/^v/, "") : null;
          url = typeof rel.html_url === "string" ? rel.html_url : null;
        }
      } catch {
        // Unreachable or rate-limited - cached as "unknown" so we don't retry
        // on every settings visit.
      }
      g.__keelUpdateCache = { at: Date.now(), latest, url };
    }

    const { latest, url } = g.__keelUpdateCache;
    return NextResponse.json({
      current,
      latest,
      url,
      updateAvailable: Boolean(latest && newer(latest, current)),
      checked: latest !== null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
