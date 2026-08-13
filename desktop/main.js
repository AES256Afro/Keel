// Keel desktop shell.
//
// Behavior:
// 1. If a Keel server is already running on the configured port (default
//    3000 - e.g. the Windows service or `npm run dev`), the app simply opens
//    a window on it: same server, same data as the browser.
// 2. Otherwise it starts the bundled server itself on that port - DETACHED,
//    so closing the app leaves the server (and scheduled backups) running.
//    The next launch finds it via /api/health and reattaches.
// 3. If the port is occupied by something that isn't Keel, it falls back to
//    a random free port.
//
// Sign-in state persists across launches (Electron's default session stores
// cookies on disk), and the user agent is normalized so Google OAuth works
// inside the window. Extra env (GOOGLE_*, MS_*, PORT) can be provided in
// <userData>/keel.env.
const { app, BrowserWindow, shell } = require("electron");
const { fork } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const net = require("net");
const fs = require("fs");

const isPackaged = app.isPackaged;
const serverDir = isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.join(__dirname, "..", ".next", "standalone");

let serverProcess = null;
let mainWindow = null;
let currentUrl = null;

function envFilePath() {
  return path.join(app.getPath("userData"), "keel.env");
}

// Write a commented template on first run so users can discover where to put
// their Google/OneDrive credentials without reading the docs. Never overwrites
// an existing file.
const ENV_TEMPLATE = `# Keel credentials for the built-in server.
#
# Fill these in to enable "Continue with Google" and Google Drive backups in
# the desktop app, then fully close and reopen Keel. Get the values from the
# Google Cloud console (see docs/CLOUD.md). Use the SAME redirect URIs you
# registered for http://localhost:3000.
#
# GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
# GOOGLE_CLIENT_SECRET=your-secret
#
# OneDrive backups (optional):
# MS_CLIENT_ID=your-application-client-id
# MS_CLIENT_SECRET=your-secret-value
`;

function ensureEnvTemplate() {
  const file = envFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, ENV_TEMPLATE);
  } catch {}
}

function loadUserEnv() {
  const extra = {};
  try {
    for (const line of fs.readFileSync(envFilePath(), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) {
        extra[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
  return extra;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function isKeel(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    return data.app === "keel";
  } catch {
    return false;
  }
}

async function waitForServer(url, tries = 240) {
  while (tries-- > 0) {
    if (await isKeel(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Google refuses OAuth inside embedded app windows ("this browser or app may
// not be secure"). So we run sign-in in the real system browser and hand the
// resulting session back to the app window via a one-time id:
//  1. open the system browser at /api/auth/google?desktop=<id> (on `localhost`
//     so the redirect URI matches what's registered with Google),
//  2. poll /api/auth/desktop-status until the browser finishes the sign-in,
//  3. load /api/auth/desktop-claim in THIS window so the session cookie lands
//     in the app's own jar.
let signInInFlight = false;
async function desktopGoogleSignin() {
  if (signInInFlight || !currentUrl) return;
  signInInFlight = true;
  try {
    const id = crypto.randomBytes(32).toString("hex");
    // Open the OAuth flow on the SAME origin the app is using (currentUrl is a
    // localhost URL, matching the registered Google redirect URI). Using a
    // different host here - e.g. 127.0.0.1 vs localhost - can land on a
    // different server process on Windows (IPv4 vs IPv6), so the session gets
    // parked where the app isn't polling. Keep them identical.
    shell.openExternal(`${currentUrl}/api/auth/google?desktop=${id}`);
    for (let i = 0; i < 200; i++) {
      if (!mainWindow) return;
      try {
        const res = await fetch(`${currentUrl}/api/auth/desktop-status?id=${id}`, {
          signal: AbortSignal.timeout(2000),
        });
        const data = await res.json();
        if (data.ready) {
          await mainWindow.loadURL(`${currentUrl}/api/auth/desktop-claim?id=${id}`);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    signInInFlight = false;
  }
}

function spawnServer(port, extraEnv) {
  const dataDir = path.join(app.getPath("userData"), "data");
  const backupDir = path.join(app.getPath("userData"), "backups");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  // Detached + unref: the server outlives the window so backups keep running
  // and reopening the app (or a browser tab) reattaches instantly.
  serverProcess = fork(path.join(serverDir, "server.js"), [], {
    cwd: serverDir,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      ...extraEnv,
      NODE_ENV: "production",
      PORT: String(port),
      // Enables the local sign-in handoff endpoints. They mint a session
      // without authenticating the caller, so the server refuses them unless
      // it knows it is the desktop app's own localhost server.
      KEEL_DESKTOP_HANDOFF: "1",
      // Bind where `localhost` resolves so the app, browser, and health checks
      // all reach this exact process (see the localhost note in start()).
      HOSTNAME: "localhost",
      // Safety net: even if the injected values above are ever lost, the
      // server itself re-reads this file (see loadEnvFiles in server-init).
      KEEL_ENV_FILE: envFilePath(),
      DATABASE_URL:
        extraEnv.DATABASE_URL ??
        "file:" + path.join(dataDir, "keel.db").split(path.sep).join("/"),
      KEEL_BACKUP_DIR: extraEnv.KEEL_BACKUP_DIR ?? backupDir,
    },
  });
  serverProcess.unref();
  serverProcess.on("exit", () => {
    serverProcess = null;
    // Server died while the app is open - bring it back.
    if (mainWindow && !app.isQuittingForReal) {
      start().catch(() => app.quit());
    }
  });
}

async function start() {
  ensureEnvTemplate();
  const extraEnv = loadUserEnv();
  const port = Number(extraEnv.PORT) || 3000;
  // Always talk to the server as `localhost` (not 127.0.0.1): it matches the
  // Google redirect URI, and it keeps the window, health checks, OAuth handoff
  // polling, and the system browser all pointed at the SAME server process
  // (a 127.0.0.1-vs-localhost split can hit different servers on Windows).
  let url = `http://localhost:${port}`;

  if (await isKeel(url)) {
    // Attach to the already-running server (service, dev server, or a server
    // left behind by a previous app session).
  } else if (await portBusy(port)) {
    // Port taken by something that isn't Keel - run privately instead.
    const fallback = await freePort();
    url = `http://localhost:${fallback}`;
    spawnServer(fallback, extraEnv);
  } else {
    spawnServer(port, extraEnv);
  }

  const ok = await waitForServer(url);
  if (!ok) {
    console.error("Keel server failed to start");
    app.quit();
    return;
  }
  currentUrl = url;

  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 720,
      minHeight: 480,
      autoHideMenuBar: true,
      title: "Keel",
      backgroundColor: "#191919",
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    // Google blocks OAuth in browsers that identify as embedded shells -
    // presenting as plain Chrome makes "Continue with Google" work in-window.
    const ua = mainWindow.webContents
      .getUserAgent()
      .replace(/ Electron\/[\d.]+/, "")
      .replace(/ Keel\/[\d.]+/i, "");
    mainWindow.webContents.setUserAgent(ua);
    // Links to other sites open in the real browser.
    mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
      shell.openExternal(target);
      return { action: "deny" };
    });
    // Intercept "Continue with Google": Google blocks OAuth in embedded
    // windows, so route it through the system browser and claim the session.
    mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return;
      }
      if (parsed.pathname === "/api/auth/google") {
        event.preventDefault();
        desktopGoogleSignin();
      }
    });
  }
  await mainWindow.loadURL(url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      start().catch(() => app.quit());
    }
  });

  app.whenReady().then(() => {
    start().catch((err) => {
      console.error(err);
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    // The server intentionally stays alive (scheduled backups, browser
    // access at localhost); only the window goes away.
    app.isQuittingForReal = true;
    app.quit();
  });
}
