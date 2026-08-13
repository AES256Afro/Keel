// Identity of this running server process - for the Settings "Server" panel
// and the in-app restart flow.

import { existsSync, readFileSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { keelEnv } from "@/lib/env";

/** Regenerated on every process start. The restart UI polls /api/health until
 *  this CHANGES - "the old process answered" and "the new process is up" are
 *  otherwise indistinguishable. */
export const BOOT_ID = randomBytes(8).toString("hex");

const BOOT_TIME = Date.now();

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - BOOT_TIME) / 1000);
}

export function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The exit code a deliberate restart uses.
 *
 * Non-zero on purpose: every supervisor the installers set up restarts on any
 * exit (systemd Restart=always, launchd KeepAlive, Docker unless-stopped, the
 * Windows scheduled task's RestartCount) - but a hand-rolled systemd unit with
 * Restart=on-failure only resurrects non-zero exits, so non-zero is the code
 * that works everywhere.
 */
export const RESTART_EXIT_CODE = 87;

/**
 * Is anything supervising this process - i.e. will exiting bring us back?
 *
 * KEEL_SUPERVISED=1/0 overrides the guesswork. Otherwise: Docker leaves
 * /.dockerenv, systemd sets INVOCATION_ID, launchd sets XPC_SERVICE_NAME for
 * its jobs. A plain `npm start` in a terminal has none of these - restarting
 * there means stopping, and the UI says so in as many words.
 */
export function isSupervised(): boolean {
  const override = keelEnv("SUPERVISED");
  if (override === "1" || override?.toLowerCase() === "true") return true;
  if (override === "0" || override?.toLowerCase() === "false") return false;
  if (existsSync("/.dockerenv")) return true;
  if (process.env.INVOCATION_ID) return true; // systemd
  if (process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== "0") return true; // launchd
  return false;
}

/**
 * Exit soon, but after the HTTP response has left the building.
 *
 * The delay is the whole trick: exit synchronously and the 200 telling the
 * user "restarting now" dies with the process, so the UI reports a network
 * error for a restart that is actually going fine.
 */
export function scheduleRestartExit(delayMs = 400): void {
  setTimeout(() => {
    process.exit(RESTART_EXIT_CODE);
  }, delayMs).unref();
}
