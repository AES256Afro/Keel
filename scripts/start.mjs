#!/usr/bin/env node
// `npm start` - launch the production server honouring .env.
//
// `next start` reads .env for the *application's* environment, but it resolves
// its own listen port from the real process environment before that happens. So
// an installer that writes PORT=8080 into .env would silently serve on 3000.
// This reads the env file first, then passes the port and host through as CLI
// flags, which works identically on macOS, Linux and Windows (a shell one-liner
// like `next start -p ${PORT:-3000}` does not).
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Load KEY=value lines. Real environment variables always win. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

for (const file of [process.env.KEEL_ENV_FILE, path.join(root, ".env")]) {
  if (file) loadEnvFile(file);
}

const port = String(Number(process.env.PORT) || 3000);
// Containers must listen on every interface; a local install should not.
//
// HOSTNAME is honoured for Next.js-standalone compatibility, but only as an
// ADDRESS. Docker sets HOSTNAME to the container ID in every container, and
// binding to that name means loopback inside the container refuses - the
// healthcheck fails forever (and anything gated on service_healthy never
// starts) while the published port happily works. A machine name is the
// machine's identity, not an instruction about which interface to serve on;
// only an explicit IP literal (or localhost) can be that instruction.
// The IPv6 arm requires a colon: a 12-hex-char container ID is otherwise a
// perfectly valid match for "hex characters", which is the exact input this
// function exists to reject.
const isAddress = (h) =>
  h === "localhost" || /^[\d.]+$/.test(h) || (h.includes(":") && /^\[?[0-9a-fA-F:]+\]?$/.test(h));
const host =
  process.env.HOST ||
  (process.env.HOSTNAME && isAddress(process.env.HOSTNAME) ? process.env.HOSTNAME : null) ||
  (process.env.container || existsSync("/.dockerenv") ? "0.0.0.0" : "localhost");

const args = ["next", "start", "-p", port, "-H", host];
console.log(`[keel] starting on http://${host}:${port}`);

const child = spawn("npx", args, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
  shell: process.platform === "win32",
});

// Forward shutdown signals so a service manager can stop us cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
