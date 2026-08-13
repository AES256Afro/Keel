import { NextResponse } from "next/server";
import { BOOT_ID } from "@/lib/server-info";

// Without this, Next prerenders the route at BUILD time and bakes one boot id
// into the artifact - every restart of the same image then reports the same
// id, and the restart UI waits forever for a change that cannot come. Found
// on the real deployment, not in tests: local `next start` happened to
// execute the handler per process.
export const dynamic = "force-dynamic";

/** Unauthenticated identity check - used by the desktop shell to detect an
 *  already-running Keel server, and by the restart flow: `boot` changes on
 *  every process start, which is how the UI tells "the old process answered"
 *  from "the new one is up". It reveals nothing about the instance. */
export function GET() {
  return NextResponse.json({ app: "keel", ok: true, boot: BOOT_ID });
}
