// In-app Cloudflare Tunnel manager (for the LOCAL hosting mode  -  the always-on
// VPS uses Caddy instead). Runs `cloudflared` as a child of the Node server:
//   • quick tunnel  → cloudflared tunnel --url http://localhost:<port>
//                     yields an instant https://<random>.trycloudflare.com URL
//   • named tunnel  → cloudflared tunnel run --token <token>
//                     serves your own hostname (configured in Cloudflare)
//
// Node-only (child_process); route handlers run in the Node runtime.
import { spawn, spawnSync, type ChildProcess } from "child_process";

export interface TunnelState {
  running: boolean;
  mode: "quick" | "named" | null;
  url: string | null; // the trycloudflare URL for quick tunnels
  error: string | null;
  startedAt: number | null;
}

const g = globalThis as unknown as {
  __keelTunnel?: { proc: ChildProcess | null; state: TunnelState };
};
const store = (g.__keelTunnel ??= {
  proc: null,
  state: { running: false, mode: null, url: null, error: null, startedAt: null },
});

export function cloudflaredAvailable(): boolean {
  try {
    const r = spawnSync("cloudflared", ["--version"], { timeout: 4000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function tunnelState(): TunnelState {
  return { ...store.state, running: Boolean(store.proc) };
}

export function startTunnel(opts: { mode: "quick" | "named"; token?: string; port: number }) {
  if (store.proc) return tunnelState(); // already running

  const args =
    opts.mode === "named" && opts.token
      ? ["tunnel", "run", "--token", opts.token]
      : ["tunnel", "--no-autoupdate", "--url", `http://localhost:${opts.port}`];

  let proc: ChildProcess;
  try {
    proc = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    store.state = {
      running: false,
      mode: null,
      url: null,
      error: e instanceof Error ? e.message : "Failed to start cloudflared",
      startedAt: null,
    };
    return tunnelState();
  }

  store.proc = proc;
  store.state = { running: true, mode: opts.mode, url: null, error: null, startedAt: Date.now() };

  const scan = (buf: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m && !store.state.url) store.state.url = m[0];
  };
  proc.stdout?.on("data", scan);
  proc.stderr?.on("data", scan);
  proc.on("exit", (code) => {
    store.proc = null;
    store.state.running = false;
    if (code) store.state.error = `cloudflared exited (code ${code})`;
  });
  proc.on("error", (err) => {
    store.proc = null;
    store.state.running = false;
    store.state.error =
      err && err.message.includes("ENOENT")
        ? "cloudflared is not installed  -  see the setup link."
        : err.message;
  });

  return tunnelState();
}

export function stopTunnel() {
  if (store.proc) {
    store.proc.kill();
    store.proc = null;
  }
  store.state = { running: false, mode: null, url: null, error: null, startedAt: null };
  return tunnelState();
}
