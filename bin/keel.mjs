#!/usr/bin/env node
// The keel CLI - run, inspect, move and update a self-hosted Keel.
//
// Node builtins only, on purpose: this file must work the moment the tarball
// is unpacked, before any npm install, on macOS, Linux and Windows.
//
//   keel start [--port 3000] [--foreground]
//   keel stop | status | logs
//   keel export <file>          portable copy of the whole notebook
//   keel import <file>          restore a copy (backs up current first)
//   keel to-docker [dir]        generate a Docker deployment from this install
//   keel update [--check]       update this install in place
//   keel paths                  where everything lives
//
// Data lives in KEEL_HOME (default ~/.keel): the database, the env file, the
// logs, the PID. The app directory (this package) holds no state at all -
// which is exactly what makes `keel update` a directory swap.

import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(CLI_DIR, "..");
const HOME = process.env.KEEL_HOME || path.join(os.homedir(), ".keel");
const PID_FILE = path.join(HOME, "keel.pid");
const PORT_FILE = path.join(HOME, "keel.port");
const LOG_FILE = path.join(HOME, "keel.log");
const ENV_FILE = path.join(HOME, ".env");
const DB_FILE = path.join(HOME, "keel.db");
const UPLOADS_DIR = path.join(HOME, "uploads");
const REPO = "AES256Afro/Keel";

const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));
const serverEntry = ["server/server.js", "server.js", "scripts/start.mjs"]
  .map((p) => path.join(APP_DIR, p))
  .find((p) => fs.existsSync(p));

const say = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(
      ENV_FILE,
      `# Keel configuration - the in-app Setup guide (✳ Setup) explains every option.
# PORT=3000
# KEEL_BACKUP_PASSPHRASE=
# KEEL_ALLOWED_EMAILS=you@example.com
# KEEL_DISABLE_SIGNUP=1
`,
      { mode: 0o600 }
    );
  }
}

// Ask the OS for a PID's command line. "" means the question could not be
// answered - never "the process is not ours".
function commandLineOf(pid) {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    } catch {
      return "";
    }
  }
  if (process.platform === "win32") {
    // Windows has no /proc and no ps, but it does have the same one-spawn
    // query the other platforms use. CIM first - wmic is deprecated and gone
    // from current Windows - with wmic as the fallback for older machines.
    const run = (file, args) => {
      try {
        const r = spawnSync(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
        return r.status === 0 ? r.stdout || "" : "";
      } catch {
        return "";
      }
    };
    const id = Number(pid);
    const cim = run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`,
    ]);
    if (cim.trim()) return cim;
    return run("wmic", ["process", "where", `processid=${id}`, "get", "commandline"]);
  }
  try {
    return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "";
  } catch {
    return "";
  }
}

// A live PID is not identity: after a crash leaves keel.pid behind, the number
// can be recycled by an unrelated process, which `keel stop` would then
// SIGTERM (as a whole group) - or, on Windows, `taskkill /F /T`, taking an
// unsaved document's whole process tree with it. Check the command line before
// trusting it.
//
// Three answers, and the difference matters: true (this is ours), false (this
// is somebody else's process - drop the stale PID file), null (the command
// line could not be read, so nothing has been proven either way; callers must
// not kill on a maybe).
function looksLikeKeel(pid) {
  const cmd = commandLineOf(pid);
  if (!cmd.trim()) return process.platform === "win32" ? null : false;
  // Both processes the PID file can name - the supervisor (its -e script
  // embeds serverEntry) and the foreground CLI - carry the install directory
  // on their command line. The server child itself would not: Next rewrites
  // its title to "next-server (…)", which is why it is never the recorded PID.
  if (process.platform !== "win32") return cmd.includes(APP_DIR);
  // Windows spells the same path several ways: case-insensitively, with
  // forward or back slashes, and - inside the supervisor's `node -e` script,
  // where the path is JSON-escaped - with every backslash doubled. Compare the
  // shapes, not the bytes, or the check would call every Windows install
  // unverified and refuse to stop it.
  const flat = (s) => s.toLowerCase().replace(/\//g, "\\").replace(/\\+/g, "\\");
  return flat(cmd).includes(flat(APP_DIR));
}

// The live process keel.pid names, or null. `verified` is false when the PID
// is live but this machine could not prove it is Keel's - `keel stop` refuses
// to force-kill that rather than gamble on a recycled number.
function runningProcess() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (pid > 0) {
      process.kill(pid, 0); // throws if gone
      const identity = looksLikeKeel(pid);
      if (identity === false) {
        fs.rmSync(PID_FILE, { force: true }); // stale file, recycled PID
        return null;
      }
      return { pid, verified: identity === true };
    }
  } catch {}
  return null;
}

function runningPid() {
  return runningProcess()?.pid ?? null;
}

function portOf() {
  try {
    const m = /^PORT=(\d+)/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
    if (m) return Number(m[1]);
  } catch {}
  return Number(process.env.PORT) || 3000;
}

// The port the server was actually started with. `keel start --port 4000`
// never touches the env file, so the configured port (portOf) and the running
// port can differ - and a health probe is only authoritative when it checks
// the port something could be listening on. Written on every start, removed
// on a confirmed stop; a stale file is harmless (a dead port just doesn't
// answer, costing one probe timeout).
function recordedPort() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
    if (p > 0) return p;
  } catch {}
  return null;
}

// What healthy() reports when the port answered but the answer was not Keel's
// - a dev server's 200 index.html, some other app's JSON. Distinct from null
// (nothing listening at all): an occupied port changes what start may
// conclude, while callers that only ask "is OUR server up" must treat it as no.
const OTHER_SERVER = Symbol("a server that is not keel");

// Probe /api/health on 127.0.0.1:port. Resolves to the identity payload
// ({ app: "keel", ok, boot }) when a Keel server answers, OTHER_SERVER when
// something non-Keel is listening, null when nothing answers. The body is
// awaited INSIDE the try on purpose: `return res.json()` adopted the promise
// after the try block was exited, so a 200 with a non-JSON body (any web dev
// server answering /api/health with its index.html) rejected healthy() itself
// and crashed status/export/import/to-docker/start with a raw SyntaxError.
async function healthy(port, tries = 1) {
  let answered = false;
  while (tries-- > 0) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      answered = true; // something is listening, whoever it is
      if (res.ok) {
        const body = await res.json();
        if (body?.app === "keel") return body;
      }
    } catch {} // fetch failed (nothing listening) or the body was not JSON
    if (tries) await new Promise((r) => setTimeout(r, 500));
  }
  return answered ? OTHER_SERVER : null;
}

function serverEnv(port, supervised) {
  // The bind address is chosen deliberately, never inherited from the shell.
  //
  // Next's standalone server (server/server.js, the entry a packaged install
  // spawns) binds process.env.HOSTNAME verbatim - and several distros export
  // HOSTNAME=<machine name> in every login shell. A machine's name is its
  // identity, not an instruction about which interface to serve on: left to
  // leak through, "chris-mbp" resolves to the LAN interface, the 127.0.0.1
  // health probe below fails, `keel start` reports "did not come up" - while
  // the detached server keeps serving the notebook on an address the user
  // never chose. Commit 6459af2 ("A container's name is not a bind address")
  // closed exactly this in scripts/start.mjs, but the packaged path spawns
  // server/server.js directly and never runs that guard. Same rule here: only
  // an explicit address (localhost, an IP literal) may pass through - via
  // HOST or HOSTNAME - and anything else means loopback. The IPv6 arm demands
  // a colon so a hex-looking machine name cannot slip past. HOST is pinned to
  // the same choice so the scripts/start.mjs fallback entry agrees.
  const isAddress = (h) =>
    h === "localhost" || /^[\d.]+$/.test(h) || (h.includes(":") && /^\[?[0-9a-fA-F:]+\]?$/.test(h));
  // The health probe uses IPv4 explicitly. Default to the same address so a
  // platform that resolves localhost to ::1 cannot start successfully on one
  // loopback family while every status check probes the other.
  const bind = [process.env.HOST, process.env.HOSTNAME].find((h) => h && isAddress(h)) || "127.0.0.1";
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: bind,
    HOST: bind,
    DATABASE_URL: process.env.DATABASE_URL || `file:${DB_FILE}`,
    KEEL_ENV_FILE: ENV_FILE,
    KEEL_BACKUP_DIR: process.env.KEEL_BACKUP_DIR || path.join(HOME, "backups"),
    // OneNote mirror images default to <cwd>/uploads, and the standalone
    // server pins cwd inside APP_DIR - the directory `keel update` swaps out.
    // On-disk state must live in KEEL_HOME with the rest of the data.
    NOPIN_UPLOAD_DIR: process.env.NOPIN_UPLOAD_DIR || UPLOADS_DIR,
    // Only the detached start wraps the server in a restart loop; --foreground
    // does not, so the in-app restart there would just exit. Report supervision
    // honestly per mode, so the Settings button's promise matches reality.
    KEEL_SUPERVISED: process.env.KEEL_SUPERVISED || (supervised ? "1" : "0"),
  };
}

async function cmdStart(args) {
  if (!serverEntry) die(`no server found under ${APP_DIR} - is this a packaged Keel?`);
  const running = runningProcess();
  if (running) {
    die(
      running.verified
        ? `already running (pid ${running.pid}) - try: keel status`
        : `${PID_FILE} names live pid ${running.pid}, which could not be verified as Keel on this machine` +
            ` - if Keel is not running, that PID was recycled: delete ${PID_FILE} and start again`
    );
  }
  ensureHome();
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : portOf();
  const foreground = args.includes("--foreground");

  // A listener already on the port dooms the spawn below to die of
  // EADDRINUSE - while the OTHER server keeps answering the health probe,
  // which the success check would then credit to a dead child. Refuse up
  // front; on a free port this probe fails with an instant refused
  // connection, so a normal start pays nothing.
  const squatter = await healthy(port);
  if (squatter === OTHER_SERVER) {
    die(`port ${port} is already in use by another server - stop it, or pick a free port with --port`);
  }
  if (squatter) {
    die(
      `another Keel server is already answering on :${port} (boot ${squatter.boot}) - a second install? each KEEL_HOME records only its own keel.pid`
    );
  }

  if (foreground) {
    const child = spawn("node", [serverEntry], { env: serverEnv(port, false), stdio: "inherit" });
    // The PID file is what stoppedGuard consults - a foreground server that
    // skipped it would let `keel import` overwrite the database mid-write.
    // Record THIS process, not the child: Next rewrites the server's title to
    // "next-server (…)", which looksLikeKeel could never verify, while the CLI
    // keeps its command line and (under job control) leads the process group
    // that `keel stop` signals.
    fs.writeFileSync(PID_FILE, String(process.pid));
    fs.writeFileSync(PORT_FILE, String(port)); // the guard probes what actually runs
    child.on("exit", (code) => {
      try {
        if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
          fs.rmSync(PID_FILE, { force: true });
        }
      } catch {}
      process.exit(code ?? 0);
    });
    // Handling the signals (instead of dying on them) keeps the exit handler
    // above in charge of the PID file; the child gets the signal forwarded.
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
    return;
  }

  // Detached, with a tiny supervisor loop: exit code 87 is the in-app
  // restart asking to be brought back.
  const log = fs.openSync(LOG_FILE, "a");
  const script = `
    let restarts = 0;
    const boot = () => {
      const child = require("child_process").spawn("node", [${JSON.stringify(serverEntry)}], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("exit", (code) => {
        if (code === 87 && restarts++ < 50) return boot();
        // A crash must not leave keel.pid pointing at a soon-recycled PID -
        // but only remove the file while it is still ours (a stop+start pair
        // may already have replaced it).
        try {
          const fs = require("fs");
          if (fs.readFileSync(${JSON.stringify(PID_FILE)}, "utf8").trim() === String(process.pid)) {
            fs.rmSync(${JSON.stringify(PID_FILE)}, { force: true });
          }
        } catch {}
        process.exit(code ?? 0);
      });
    };
    boot();
  `;
  const child = spawn("node", ["-e", script], {
    env: serverEnv(port, true),
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(PORT_FILE, String(port)); // the guard probes what actually runs
  child.unref();

  process.stdout.write(`starting Keel on http://localhost:${port} `);
  const health = await healthy(port, 60);
  // An answer on the port only proves SOMETHING is serving it. If the child
  // died meanwhile (EADDRINUSE: a server grabbed the port between the
  // pre-flight probe and the bind), the 200 belongs to that other server -
  // declaring "running" would hand the user someone else's notebook.
  const childAlive = () => {
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (health && health !== OTHER_SERVER && childAlive()) {
    say(`\n✔ running (pid ${child.pid}) - data in ${HOME}`);
    say(`  open http://localhost:${port} - first sign-in creates your account`);
  } else if (health && !childAlive()) {
    // The supervisor removes keel.pid on its way out only if it still owns
    // it; sweep both records so status/stoppedGuard don't trust a dead start.
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(child.pid)) {
        fs.rmSync(PID_FILE, { force: true });
      }
    } catch {}
    fs.rmSync(PORT_FILE, { force: true });
    say(`\n✗ port ${port} is already in use by another server - the Keel just started died; see ${LOG_FILE}`);
    process.exit(1);
  } else {
    say(`\n✗ did not come up - see ${LOG_FILE}`);
    process.exit(1);
  }
}

async function cmdStop() {
  const running = runningProcess();
  if (!running) {
    say("not running");
    return;
  }
  const pid = running.pid;
  // Killing is irreversible, so it needs proof, not a live PID. If the command
  // line could not be read (a locked-down Windows with neither CIM nor wmic),
  // the number in keel.pid may belong to anything - a browser, an unsaved
  // document - and `taskkill /F /T` would take its whole tree down. Say so and
  // stop, rather than kill something that was never ours.
  if (!running.verified) {
    die(
      `pid ${pid} is running, but this machine could not read its command line to confirm it is Keel` +
        ` - refusing to force-kill it, because a stale ${path.basename(PID_FILE)} can name an unrelated process.\n` +
        `  Check it in Task Manager: if it is Keel, stop it there; if it is not, delete ${PID_FILE}.`
    );
  }
  // The PID belongs to the supervisor loop, which has the Next server as a
  // child. On POSIX the detached child is its own group leader, so a negative
  // PID stops the whole group. Windows has no process groups and no SIGTERM
  // semantics, so taskkill /T walks the tree instead - without it the server
  // child would be orphaned and keep the port.
  let group = false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
      group = true;
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  // keel.pid is the evidence stoppedGuard trusts. Deleting it on the mere
  // ATTEMPT to kill blinded that guard whenever the kill didn't take -
  // taskkill refused, or the server simply shut down slowly - and the next
  // `keel export`/`import` then copied or clobbered a live database. Remove
  // the file only once the process group is confirmed gone: ESRCH is the only
  // answer that means gone (EPERM means alive but not ours - exactly when the
  // evidence must stay).
  const gone = () => {
    try {
      process.kill(group ? -pid : pid, 0);
      return false;
    } catch (err) {
      return err.code === "ESRCH";
    }
  };
  const deadline = Date.now() + 10_000;
  while (!gone() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!gone()) {
    die(
      `asked pid ${pid} to stop, but it is still running - keeping keel.pid so export/import stay guarded; retry, or stop the process yourself`
    );
  }
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(PORT_FILE, { force: true });
  say(`✔ stopped (pid ${pid})`);
}

async function cmdStatus() {
  const running = runningProcess();
  const pid = running?.pid ?? null;
  const port = recordedPort() ?? portOf();
  const health = await healthy(port);
  // Only a Keel answer counts as healthy; some other app on the port is
  // worth naming, not crediting.
  const up = health && health !== OTHER_SERVER ? health : null;
  say(`Keel ${pkg.version} @ ${APP_DIR}`);
  say(`data:   ${HOME}`);
  say(`state:  ${pid ? `running (pid ${pid})` : "stopped"}${up ? ` - healthy on :${port} (boot ${up.boot})` : ""}`);
  if (running && !running.verified) {
    say(`        (pid ${pid} could not be verified as Keel on this machine - see \`keel stop\` if it is not)`);
  }
  if (pid && !up) {
    say(
      health === OTHER_SERVER
        ? `        process exists but :${port} is answered by something that is not Keel - see ${LOG_FILE}`
        : `        process exists but :${port} is not answering - see ${LOG_FILE}`
    );
  }
}

function cmdLogs(args) {
  if (!fs.existsSync(LOG_FILE)) die("no log yet");
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  const n = Number(args[0]) || 100;
  say(lines.slice(-n).join("\n"));
}

// Copy a directory tree following EVERY symlink - bytes, not links. A backup
// or export that contains links dangles the moment it leaves this machine
// (and to-docker's container never mounts the link's host target). Node's
// cpSync({ dereference: true }) is not enough: it resolves only the source
// root - entries INSIDE the tree still copy as links (verified on Node 26).
// A directory-link cycle is visited once and not spun on.
//
// Nothing here throws. Every caller runs AFTER the database has already been
// copied (export) or replaced (import), so one unreadable file - a root-owned
// image left by a sudo'd restore or a docker-volume copy - used to abort the
// command with a raw stack, leaving a half-made bundle that looks finished.
// Unreadable and vanished entries are skipped by name instead, and the tally
// comes back so the caller can say plainly that the copy is incomplete.
function copyTreeDereferenced(src, dst, state = { copied: 0, skipped: [], seen: new Set() }) {
  const skip = (target, err) => {
    // A dangling symlink and a file removed mid-walk both report ENOENT; both
    // mean "no bytes here to preserve". Anything else is a permission wall.
    const why = err?.code === "ENOENT" ? "broken link or removed mid-copy" : `unreadable (${err?.code ?? err})`;
    say(`  (skipping ${target} - ${why})`);
    state.skipped.push(`${target} - ${why}`);
    return state;
  };
  let st;
  try {
    st = fs.statSync(src); // follows links; throws on a dangling one
  } catch (err) {
    return skip(src, err);
  }
  if (st.isDirectory()) {
    let entries;
    try {
      const real = fs.realpathSync(src);
      if (state.seen.has(real)) return state;
      state.seen.add(real);
      fs.mkdirSync(dst, { recursive: true });
      entries = fs.readdirSync(src);
    } catch (err) {
      return skip(`${src}${path.sep}`, err);
    }
    for (const entry of entries) {
      copyTreeDereferenced(path.join(src, entry), path.join(dst, entry), state);
    }
  } else {
    try {
      fs.copyFileSync(src, dst);
      state.copied++;
    } catch (err) {
      return skip(src, err);
    }
  }
  return state;
}

// What a copy left behind, said out loud. A partial copy is still worth
// keeping - the alternative is no export at all - but it must never pass for
// complete, so the gap is listed by name right under the success line.
function reportSkipped(state, what) {
  if (!state.skipped.length) return;
  say(`⚠ ${what} is INCOMPLETE - ${state.copied} file(s) copied, ${state.skipped.length} skipped:`);
  for (const entry of state.skipped.slice(0, 10)) say(`    ${entry}`);
  if (state.skipped.length > 10) say(`    …and ${state.skipped.length - 10} more`);
}

async function stoppedGuard(what) {
  const running = runningProcess();
  if (running) {
    die(
      running.verified
        ? `stop the server first (keel stop) - ${what} needs the database file at rest`
        : `${PID_FILE} names live pid ${running.pid}, which could not be verified as Keel on this machine` +
            ` - ${what} needs the database file at rest, so this stops here; see \`keel stop\``
    );
  }
  // The PID file is not the only way a server can be live (older CLIs did not
  // write one for --foreground; a stale file may just have been cleared). An
  // answer on the port is authoritative regardless - but only if it is a port
  // the server could actually be on: `keel start --port 4000` never touches
  // the env file, so probe the recorded runtime port as well as the
  // configured one.
  const ports = new Set([portOf(), recordedPort()].filter((p) => p));
  for (const port of ports) {
    const answer = await healthy(port);
    // Only a KEEL answer blocks: it means this database may be open in a
    // live server. Something ELSE on the port (a dev server squatting :3000)
    // holds no lock on our database, so it must not block - and treating its
    // 200 as proof of a running Keel used to crash these commands outright
    // whenever the body wasn't JSON.
    if (answer && answer !== OTHER_SERVER) {
      die(`a Keel server is answering on :${port} - stop it first; ${what} needs the database file at rest`);
    }
  }
}

async function cmdExport(args) {
  const target = args[0];
  if (!target) die("usage: keel export <file.db>");
  await stoppedGuard("a consistent export");
  if (!fs.existsSync(DB_FILE)) die(`no database at ${DB_FILE} yet`);
  // With the server stopped and WAL checkpointed on clean shutdown, the main
  // file is the whole notebook - editor attachments included, they live
  // inside it. OneNote mirror images are the one exception: they live on disk
  // under uploads/ and travel as a sibling directory.
  fs.copyFileSync(DB_FILE, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(DB_FILE + suffix)) fs.copyFileSync(DB_FILE + suffix, target + suffix);
  }
  if (fs.existsSync(UPLOADS_DIR) && fs.readdirSync(UPLOADS_DIR).length > 0) {
    // A user who moved uploads to a bigger disk with a symlink
    // (`ln -s /bigdisk ~/.keel/uploads`) must still get the BYTES in the
    // export - a copied link dangles the moment the bundle leaves this
    // machine, silently losing every image the success line claims to carry.
    const copy = copyTreeDereferenced(UPLOADS_DIR, `${target}.uploads`);
    // Some images beat no images - but a copy where nothing at all could be
    // read is not a copy, and the user must not carry that bundle away
    // believing it holds the mirror.
    if (copy.copied === 0 && copy.skipped.length) {
      die(
        `the database was copied to ${target}, but not one file under ${UPLOADS_DIR} could be read` +
          ` (${copy.skipped.length} skipped; first: ${copy.skipped[0]})\n` +
          `  the export carries no OneNote mirror images - fix the permissions and export again`
      );
    }
    say(`✔ exported to ${target} (+ ${path.basename(target)}.uploads - OneNote mirror images)`);
    reportSkipped(copy, `${path.basename(target)}.uploads`);
  } else {
    say(`✔ exported to ${target} - this one file (plus any -wal sidecar) is everything`);
  }
}

async function cmdImport(args) {
  const source = args[0];
  if (!source || !fs.existsSync(source)) die("usage: keel import <file.db>");
  await stoppedGuard("a safe import");
  ensureHome();
  let backup = null;
  if (fs.existsSync(DB_FILE)) {
    backup = `${DB_FILE}.pre-import-${Date.now()}`;
    fs.copyFileSync(DB_FILE, backup);
    // Back up the sidecars too, BEFORE deleting them below. If the server was
    // SIGKILLed, committed transactions may live only in -wal; a backup that
    // omitted it would silently drop them when restored.
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(DB_FILE + suffix)) fs.copyFileSync(DB_FILE + suffix, backup + suffix);
    }
    say(`current database kept at ${backup}`);
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(DB_FILE + suffix, { force: true });
  fs.copyFileSync(source, DB_FILE);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, DB_FILE + suffix);
  }
  // Exports carry OneNote mirror images as <file>.uploads (see cmdExport).
  // Replace, don't merge - the images must match the database being restored -
  // and keep the outgoing set next to the pre-import database backup. Every
  // copy dereferences: backups must hold bytes, not links (see cmdExport).
  if (fs.existsSync(`${source}.uploads`)) {
    if (backup && fs.existsSync(UPLOADS_DIR)) {
      reportSkipped(copyTreeDereferenced(UPLOADS_DIR, `${backup}.uploads`), `${backup}.uploads`);
    }
    // If uploads is a symlink (relocated to a bigger disk), operate on its
    // target: removing just the link would strand the old images at the
    // target and silently undo the relocation with a real directory in HOME.
    const uploadsReal = fs.existsSync(UPLOADS_DIR) ? fs.realpathSync(UPLOADS_DIR) : UPLOADS_DIR;
    fs.rmSync(uploadsReal, { recursive: true, force: true });
    const copy = copyTreeDereferenced(`${source}.uploads`, uploadsReal);
    // The live uploads tree is already gone by here, so say where the outgoing
    // images went before failing - that copy is the way back.
    if (copy.copied === 0 && copy.skipped.length) {
      die(
        `the database was restored, but not one file under ${source}.uploads could be read` +
          ` (${copy.skipped.length} skipped; first: ${copy.skipped[0]})\n` +
          `  ${uploadsReal} is now empty${backup ? `; the images that were there are at ${backup}.uploads` : ""}`
      );
    }
    reportSkipped(copy, `${uploadsReal}`);
  }
  say(`✔ imported - keel start and sign in as before`);
}

async function cmdToDocker(args) {
  const dir = path.resolve(args[0] || "keel-docker");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  await stoppedGuard("copying the database into the Docker volume");
  if (fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, path.join(dir, "data", "keel.db"));
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(DB_FILE + suffix))
        fs.copyFileSync(DB_FILE + suffix, path.join(dir, "data", "keel.db" + suffix));
    }
    say(`✔ database copied into ${path.join(dir, "data")}`);
  }
  // OneNote mirror images live outside the database; they ride the same
  // mounted volume so `docker compose build` never destroys them. Copied as
  // real files: a symlinked uploads dir (or link inside it) would point at a
  // host path the container never mounts - it only gets ./data.
  if (fs.existsSync(UPLOADS_DIR)) {
    const copy = copyTreeDereferenced(UPLOADS_DIR, path.join(dir, "data", "uploads"));
    if (copy.copied === 0 && copy.skipped.length) {
      die(
        `not one file under ${UPLOADS_DIR} could be read (${copy.skipped.length} skipped; first: ${copy.skipped[0]})\n` +
          `  the Docker deployment would start without any OneNote mirror images - fix the permissions and run this again`
      );
    }
    reportSkipped(copy, path.join(dir, "data", "uploads"));
  }
  if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, path.join(dir, ".env.keel"));
  fs.writeFileSync(
    path.join(dir, "docker-compose.yml"),
    `# Keel in Docker - generated by \`keel to-docker\`.
# Start it:   docker compose up -d
# Update it:  docker compose build --pull && docker compose up -d
services:
  keel:
    build: https://github.com/${REPO}.git#main
    restart: unless-stopped
    env_file: .env.keel
    environment:
      DATABASE_URL: file:/data/keel.db
      NOPIN_UPLOAD_DIR: /data/uploads
      PORT: "3000"
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 45s
`
  );
  say(`✔ wrote ${dir}/docker-compose.yml`);
  say(``);
  say(`Next steps:`);
  say(`  cd ${dir} && docker compose up -d`);
  say(`  # your notes, users and settings come along - it's the same database file.`);
  say(`  # For a REMOTE machine: copy the '${path.basename(dir)}' directory there first (scp -r),`);
  say(`  # then run the same command on that machine.`);
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "keel-cli" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function cmdUpdate(args) {
  const rel = await latestRelease().catch(() => null);
  if (!rel) {
    die(
      `couldn't reach GitHub releases for ${REPO} - if the repository is private,\n  update with the method you installed by (brew upgrade / npm update -g keel-notes / git pull).`
    );
  }
  const latest = rel.tag_name?.replace(/^v/, "");
  const current = pkg.version;
  if (args.includes("--check")) {
    say(latest === current ? `✔ up to date (${current})` : `update available: ${current} → ${latest}\n  run: keel update`);
    return;
  }
  if (latest === current) {
    say(`✔ already on ${current}`);
    return;
  }

  // Package-manager installs update through their manager, which also updates
  // the CLI itself - safer than overwriting our own install prefix.
  if (APP_DIR.includes("/Cellar/") || APP_DIR.includes("/homebrew/")) {
    say(`installed via Homebrew - updating with brew:`);
    const r = spawnSync("brew", ["upgrade", "keel"], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  if (APP_DIR.includes(`${path.sep}node_modules${path.sep}`)) {
    say(`installed via npm - updating with npm:`);
    const r = spawnSync("npm", ["update", "-g", "keel-notes"], { stdio: "inherit", shell: process.platform === "win32" });
    process.exit(r.status ?? 0);
  }

  // Directory install: download the platform tarball and swap in place.
  const platform = `${process.platform === "darwin" ? "macos" : process.platform}-${os.arch()}`;
  const asset = (rel.assets ?? []).find((a) => a.name.includes(platform) && a.name.endsWith(".tar.gz"));
  if (!asset) die(`release ${latest} has no build for ${platform} yet`);

  // The tag and asset name become path components below and directory names on
  // disk - never trust the shapes GitHub hands back. A release named "../evil"
  // must not be able to steer where files land.
  if (!/^\d+\.\d+\.\d+$/.test(latest)) die(`refusing to update to an unexpected version string: ${latest}`);
  if (!/^keel-[\w.-]+\.tar\.gz$/.test(asset.name) || asset.name.includes("..")) {
    die(`refusing an unexpected asset name: ${asset.name}`);
  }

  // Stage in a private, randomly-named directory (mkdtemp is 0700). The old
  // code wrote to a PREDICTABLE path in the world-writable /tmp, where a local
  // attacker on a shared host could pre-place a symlink or race the file
  // between write and extract (TOCTOU) to get their tarball run as this user.
  //
  // Failures are collected rather than die()d mid-flight: die() is
  // process.exit, which would skip the staging cleanup AND the restart of a
  // server this command may have stopped. One exit point below settles both.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "keel-update-"));
  let wasRunning = null;
  let runPort = null;
  let failure = null;
  try {
    // Download and unpack BEFORE stopping the server: a bad network day must
    // not end with Keel down and nothing gained.
    say(`downloading ${asset.name}…`);
    const res = await fetch(asset.browser_download_url, { headers: { "user-agent": "keel-cli" } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const tmp = path.join(stage, asset.name);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

    // Extract inside the private staging dir, never next to the live install.
    const r = spawnSync("tar", ["-xzf", tmp, "-C", stage], { stdio: "inherit" });
    const unpacked = path.join(stage, `keel-${latest}-${platform}`);
    if (r.status !== 0 || !fs.existsSync(unpacked)) throw new Error("unpack failed");

    // Only now - new version fully staged - take the server down. `keel start
    // --port N` never touches the env file, so the recorded runtime port is
    // the only memory of where the server was serving, and cmdStop deletes
    // that record: capture it first or the restart lands on the configured
    // port instead of the one every bookmark and reverse proxy points at.
    wasRunning = runningPid();
    runPort = recordedPort();
    if (wasRunning) await cmdStop();

    // The swap. Recovery contract: from the moment the old install leaves
    // APP_DIR until the new one is verified in place, ANY failure puts the
    // old directory back before the error escapes - the keel CLI itself lives
    // inside APP_DIR, so a torn swap would take the recovery tool with it.
    // After a successful swap the old version stays at .previous for MANUAL
    // recovery only: the database migrates forward on next start, and
    // automatically re-running old code against a newer schema would be worse
    // than a down server.
    const previous = `${APP_DIR}.previous`;
    fs.rmSync(previous, { recursive: true, force: true });
    fs.renameSync(APP_DIR, previous);
    try {
      try {
        fs.renameSync(unpacked, APP_DIR);
      } catch {
        // rename across devices can fail (staging in /tmp, install
        // elsewhere). Copy to a sibling of APP_DIR - same filesystem - and
        // rename the FINISHED copy in, so a half-copied tree (disk full,
        // permissions) can never sit at APP_DIR itself.
        const incoming = `${APP_DIR}.incoming`;
        fs.rmSync(incoming, { recursive: true, force: true });
        try {
          fs.cpSync(unpacked, incoming, { recursive: true });
          fs.renameSync(incoming, APP_DIR);
        } catch (err) {
          fs.rmSync(incoming, { recursive: true, force: true });
          throw err;
        }
      }
      if (!fs.existsSync(path.join(APP_DIR, "package.json"))) {
        throw new Error("the new version did not land where expected");
      }
    } catch (err) {
      // Roll back: clear whatever landed at APP_DIR, put the old install back.
      try {
        fs.rmSync(APP_DIR, { recursive: true, force: true });
        fs.renameSync(previous, APP_DIR);
      } catch {
        throw new Error(
          `swap failed (${err?.message ?? err}) AND rolling back failed - restore by hand: mv "${previous}" "${APP_DIR}"`
        );
      }
      throw new Error(`swap failed (${err?.message ?? err}) - the previous version was restored`);
    }
    say(`✔ updated to ${latest} (previous version kept at ${previous})`);
  } catch (err) {
    failure = err;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  if (failure) {
    console.error(`✗ update failed: ${failure.message}`);
    // If this command stopped a running server and a startable install is
    // (still or back) at APP_DIR, bring it up again rather than leaving Keel
    // silently down - on the port it was actually serving.
    if (wasRunning && fs.existsSync(path.join(APP_DIR, "package.json"))) {
      say(`restarting the current version…`);
      await cmdStart(runPort ? ["--port", String(runPort)] : []);
    }
    process.exit(1);
  }

  say(`  your data in ${HOME} was untouched; the database migrates itself on next start`);
  if (wasRunning) {
    say(`restarting…`);
    await cmdStart(runPort ? ["--port", String(runPort)] : []);
  }
}

function cmdPaths() {
  say(`app:      ${APP_DIR}`);
  say(`data:     ${HOME}`);
  say(`database: ${DB_FILE}`);
  say(`config:   ${ENV_FILE}`);
  say(`logs:     ${LOG_FILE}`);
  say(`uploads:  ${UPLOADS_DIR} (OneNote mirror images)`);
  say(`backups:  ${path.join(HOME, "backups")} (encrypted snapshots from the in-app backup)`);
}

function cmdHelp() {
  say(`keel ${pkg.version} - a self-hosted notebook that carries its own toolbox

  keel start [--port N] [--foreground]   run the server (data in ~/.keel)
  keel stop | status | logs [n]          manage it
  keel export <file.db>                  the whole notebook as one file
  keel import <file.db>                  restore it anywhere
  keel to-docker [dir]                   turn this install into a Docker deployment
  keel update [--check]                  update in place; data is never touched
  keel paths                             where everything lives

Everything else - backups to Drive/OneDrive/Azure/R2, access control, the
OneNote mirror - is configured inside the app: ✳ Setup in the sidebar.`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  logs: cmdLogs,
  export: cmdExport,
  import: cmdImport,
  "to-docker": cmdToDocker,
  update: cmdUpdate,
  paths: cmdPaths,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
  "--version": () => say(pkg.version),
};
const fn = commands[cmd] ?? cmdHelp;
await fn(args);
