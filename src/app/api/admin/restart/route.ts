import { NextResponse } from "next/server";
import { requireInstanceOwner, enforceLimit, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { isSupervised, scheduleRestartExit } from "@/lib/server-info";

/**
 * Restart the server from the app.
 *
 * The mechanism is deliberate exit: the process stops with a distinctive code
 * and whatever supervises it (Docker, systemd, launchd, the Windows task -
 * every install path sets one up) starts it fresh. The response goes out
 * first, then the exit fires, so the UI can honestly say "restarting" and
 * start polling for the new boot id.
 *
 * Instance-owner only: this stops the server for every user of the instance,
 * so workspace-level roles can never reach it.
 */
export async function POST() {
  try {
    const { user } = await requireInstanceOwner();
    await enforceLimit("server-restart", { limit: 3, windowMs: 60_000, userId: user.id });

    const supervised = isSupervised();
    await audit("server.restart", user, { detail: { supervised } });

    scheduleRestartExit();
    return NextResponse.json({
      ok: true,
      supervised,
      message: supervised
        ? "Restarting - back in a few seconds."
        : "Stopping. Nothing appears to be supervising this server, so it must be started again by hand.",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
