#!/usr/bin/env node
/**
 * bigbox - troubleshoot and manage a BigBox home server (Keel + Pi-hole).
 *
 * One file, zero dependencies, Node 20+. Runs on Windows, Linux and macOS -
 * directly on the box, or from another machine with `--host user@bigbox`
 * (streams itself over SSH, nothing to install on the far side beyond Node,
 * which Keel already requires).
 *
 *   bigbox status                 one-screen health dashboard
 *   bigbox doctor [--fix]         full diagnostics + self-remediation
 *   bigbox restart keel|pihole    (also: start / stop)
 *   bigbox logs keel|pihole [-f]
 *   bigbox backup now|list|prune|verify
 *   bigbox paths                  where every piece of data lives
 *   bigbox net [--fix]            layered internet/DNS troubleshooting
 *   bigbox pihole <args…>         pass-through to the pihole CLI (native or docker)
 *   bigbox update                 update Keel in place and restart it
 *   bigbox report                 redacted support bundle for troubleshooting
 *   bigbox watch [--install]      watchdog loop that self-remediates
 *
 * Run `bigbox help` for everything.
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

const VERSION = '1.2.0';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const SELF = fileURLToPath(import.meta.url);

// ------------------------------------------------------------------ args ---
const flags = {
  dir: null, host: null, port: null, json: false, fix: false, dryRun: false,
  follow: false, lines: 80, keep: 10, interval: 300, install: false,
  uninstall: false, yes: false,
  guiPort: 0, bind: null, noOpen: false, installApp: false,
  color: process.stdout.isTTY && !process.env.NO_COLOR,
};
const words = [];
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    switch (t) {
      case '--dir': flags.dir = a[++i]; break;
      case '--host': flags.host = a[++i]; break;
      case '--port': flags.port = parseInt(a[++i], 10) || null; break;
      case '--json': flags.json = true; break;
      case '--fix': flags.fix = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '-f': case '--follow': flags.follow = true; break;
      case '-n': case '--lines': flags.lines = parseInt(a[++i], 10) || 80; break;
      case '--keep': flags.keep = parseInt(a[++i], 10) || 10; break;
      case '--interval': flags.interval = parseInt(a[++i], 10) || 300; break;
      case '--install': flags.install = true; break;
      case '--gui-port': flags.guiPort = parseInt(a[++i], 10) || 0; break;
      case '--bind': flags.bind = a[++i]; break;
      case '--no-open': flags.noOpen = true; break;
      case '--install-app': flags.installApp = true; break;
      case '--uninstall': flags.uninstall = true; break;
      case '-y': case '--yes': flags.yes = true; break;
      case '--no-color': flags.color = false; break;
      case '-V': case '--version': console.log(`bigbox ${VERSION}`); process.exit(0); break;
      case '-h': case '--help': words.push('help'); break;
      default: words.push(t);
    }
  }
}

// ----------------------------------------------------------------- output ---
const C = (n) => (s) => flags.color ? `\x1b[${n}m${s}\x1b[0m` : String(s);
const red = C(31), green = C(32), yellow = C(33), bold = C(1), dim = C(2);
const OK = () => green('✓'), WARN = () => yellow('!'), FAIL = () => red('✗');
const say = (s) => console.log(`${bold('==>')} ${s}`);
const line = (mark, s) => console.log(`  ${mark} ${s}`);

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtDur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function ts() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ------------------------------------------------------------------ shell ---
function run(cmd, args = [], opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8', timeout: opts.timeout ?? 20000,
      input: opts.input, windowsHide: true,
    });
    return { ok: r.status === 0 && !r.error, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, code: -1, out: '', err: String(e) };
  }
}
const haveCache = new Map();
function have(cmd) {
  if (!haveCache.has(cmd)) haveCache.set(cmd, run(IS_WIN ? 'where' : 'which', [cmd]).ok);
  return haveCache.get(cmd);
}
function ps1(script) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}
function runStream(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
    c.on('close', (code) => resolve(code ?? 0));
    c.on('error', () => resolve(1));
  });
}

// ------------------------------------------------------------ keel config ---
function parseEnvFile(p) {
  const env = {};
  try {
    for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const eq = l.indexOf('=');
      if (eq < 1) continue;
      let v = l.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[l.slice(0, eq).trim()] = v;
    }
  } catch { /* unreadable → empty */ }
  return env;
}

function findKeelDir() {
  const cands = [
    flags.dir, process.env.KEEL_DIR,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || '', 'Keel') : path.join(os.homedir(), 'keel'),
    path.join(os.homedir(), 'Keel'), path.join(os.homedir(), 'notes'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, '.env')) || fs.existsSync(path.join(c, 'package.json'))) return path.resolve(c);
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Resolve a containerised Keel's real paths on the host.
 *
 * A Docker install keeps DATABASE_URL and KEEL_BACKUP_DIR *inside* the
 * container, so there is no host .env to read - but the data itself is almost
 * always on a bind mount. Map the container-side paths through the mount table
 * and we can snapshot the database straight from the host: no `docker exec`,
 * no sqlite3 inside the image (the very thing whose absence silently breaks
 * container backup scripts after a rebuild).
 */
function containerPaths() {
  const svc = detectKeelService();
  if (svc.type !== 'docker') return null;

  const mounts = run('docker', ['inspect', '-f', '{{range .Mounts}}{{.Source}}>{{.Destination}}{{"\n"}}{{end}}', svc.name])
    .out.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [source, dest] = l.split('>'); return { source, dest }; })
    // Longest destination first, so /data/backups wins over /data.
    .sort((a, b) => (b.dest || '').length - (a.dest || '').length);
  if (!mounts.length) return null;

  const env = {};
  for (const l of run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', svc.name]).out.split('\n')) {
    const eq = l.indexOf('=');
    if (eq > 0) env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
  }

  /** Container path → host path, via the deepest mount that contains it. */
  const toHost = (p) => {
    if (!p) return null;
    for (const m of mounts) {
      if (p === m.dest || p.startsWith(m.dest.replace(/\/$/, '') + '/')) {
        return path.join(m.source, path.relative(m.dest, p));
      }
    }
    return null; // inside the container's own writable layer - not reachable
  };

  const dburl = env.DATABASE_URL || '';
  let dbPath = dburl.startsWith('file:') ? toHost(dburl.slice(5)) : null;
  if (dbPath && !fs.existsSync(dbPath)) dbPath = null;
  if (!dbPath && !dburl.startsWith('postgres')) {
    // No usable DATABASE_URL: look for a single .db in the mounted directories.
    for (const m of mounts) {
      try {
        const hit = fs.readdirSync(m.source).filter((f) => f.endsWith('.db'));
        if (hit.length === 1) { dbPath = path.join(m.source, hit[0]); break; }
      } catch { /* unreadable mount */ }
    }
  }

  const backupDir = toHost(env.KEEL_BACKUP_DIR)
    || (dbPath ? path.join(path.dirname(path.dirname(dbPath)), 'backups') : null);

  return {
    env, dbPath, backupDir,
    container: svc.name,
    isPostgres: dburl.startsWith('postgres'),
  };
}

function keelConfig() {
  const dir = findKeelDir();
  const env = dir ? parseEnvFile(path.join(dir, '.env')) : {};
  let dbPath = null;
  const dburl = env.DATABASE_URL || '';
  if (dburl.startsWith('file:')) {
    let p = dburl.slice(5);
    if (!path.isAbsolute(p) && dir) p = path.resolve(dir, 'prisma', p); // prisma resolves relative to the schema dir
    dbPath = p;
  }
  if (!dir && !dbPath) {
    // No host install - this is probably a container. Cost is one docker
    // inspect, and only on machines where nothing was found on disk.
    const c = containerPaths();
    if (c) {
      return {
        dir: null, env: c.env, port: flags.port || parseInt(c.env.PORT, 10) || 0,
        dbPath: c.dbPath, isPostgres: c.isPostgres, backupDir: c.backupDir,
        logPath: null, container: c.container,
      };
    }
  }

  return {
    dir, env,
    port: flags.port || parseInt(env.PORT, 10) || 0, // 0 = not known yet; getPort() resolves it
    dbPath,
    isPostgres: dburl.startsWith('postgres'),
    backupDir: env.KEEL_BACKUP_DIR || (dir ? path.join(dir, 'backups') : null),
    logPath: dir ? path.join(dir, 'keel.log') : null,
  };
}

// --------------------------------------------------------- keel service ---
function detectKeelService() {
  if (IS_WIN) {
    if (run('schtasks', ['/Query', '/TN', 'Keel']).ok) return { type: 'schtasks', name: 'Keel' };
  } else if (IS_MAC) {
    const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.keel.server.plist');
    if (fs.existsSync(plist)) return { type: 'launchd', name: 'com.keel.server', plist };
  } else if (have('systemctl')) {
    if (run('systemctl', ['--user', 'cat', 'keel.service']).ok) return { type: 'systemd', name: 'keel' };
    if (run('systemctl', ['cat', 'keel.service']).ok) return { type: 'systemd-system', name: 'keel' };
  }
  if (have('docker')) {
    const names = run('docker', ['ps', '-a', '--format', '{{.Names}}']).out.split('\n');
    const hit = names.find((n) => /keel|nopin/i.test(n));
    if (hit) return { type: 'docker', name: hit };
  }
  return { type: 'none', name: null };
}

function keelServiceState(svc) {
  switch (svc.type) {
    case 'systemd': return run('systemctl', ['--user', 'is-active', 'keel']).out === 'active' ? 'running' : 'stopped';
    case 'systemd-system': return run('systemctl', ['is-active', 'keel']).out === 'active' ? 'running' : 'stopped';
    case 'launchd': {
      const r = run('launchctl', ['list']);
      const l = r.out.split('\n').find((x) => x.includes(svc.name));
      if (!l) return 'stopped';
      return l.trim().startsWith('-') ? 'stopped' : 'running';
    }
    case 'schtasks': {
      const r = run('schtasks', ['/Query', '/TN', svc.name, '/FO', 'LIST', '/V']);
      return /:\s*Running/i.test(r.out) ? 'running' : 'stopped';
    }
    case 'docker': {
      const r = run('docker', ['inspect', '-f', '{{.State.Running}}', svc.name]);
      return r.out === 'true' ? 'running' : 'stopped';
    }
    default: return 'unknown';
  }
}

// The port Keel answers on, resolved once: --port flag, then the host .env,
// then the Docker published-port mapping (docker installs keep PORT inside
// the container, so the host .env never has it), then 3000.
let portCache = null;
function getPort(cfg) {
  if (portCache) return portCache;
  if (cfg.port) return (portCache = cfg.port);
  const svc = detectKeelService();
  if (svc.type === 'docker') {
    const mapped = run('docker', ['port', svc.name]).out; // "3000/tcp -> 0.0.0.0:8080"
    const m = mapped.match(/->\s*[\d.[\]:]*:(\d+)\s*$/m);
    if (m) return (portCache = parseInt(m[1], 10));
    const env = run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', svc.name])
      .out.match(/^PORT=(\d+)$/m);
    if (env) return (portCache = parseInt(env[1], 10)); // host-network container
  }
  return (portCache = 3000);
}

function keelCtl(svc, action) { // action: start | stop | restart → {ok, detail}
  const seq = {
    systemd: { start: [['systemctl', ['--user', 'start', 'keel']]], stop: [['systemctl', ['--user', 'stop', 'keel']]], restart: [['systemctl', ['--user', 'restart', 'keel']]] },
    'systemd-system': { start: [['sudo', ['systemctl', 'start', 'keel']]], stop: [['sudo', ['systemctl', 'stop', 'keel']]], restart: [['sudo', ['systemctl', 'restart', 'keel']]] },
    schtasks: {
      start: [['schtasks', ['/Run', '/TN', svc.name]]],
      stop: [['schtasks', ['/End', '/TN', svc.name]]],
      restart: [['schtasks', ['/End', '/TN', svc.name]], ['schtasks', ['/Run', '/TN', svc.name]]],
    },
    docker: { start: [['docker', ['start', svc.name]]], stop: [['docker', ['stop', svc.name]]], restart: [['docker', ['restart', svc.name]]] },
  }[svc.type];

  if (svc.type === 'launchd') {
    if (action === 'restart') {
      const uid = run('id', ['-u']).out;
      const k = run('launchctl', ['kickstart', '-k', `gui/${uid}/${svc.name}`]);
      if (k.ok) return { ok: true, detail: 'kickstarted' };
      run('launchctl', ['unload', svc.plist]);
      const l = run('launchctl', ['load', '-w', svc.plist]);
      return { ok: l.ok, detail: l.ok ? 'reloaded' : l.err };
    }
    const r = action === 'start' ? run('launchctl', ['load', '-w', svc.plist]) : run('launchctl', ['unload', svc.plist]);
    return { ok: r.ok, detail: r.ok ? action : r.err };
  }
  if (!seq) return { ok: false, detail: `no service manager found for Keel - install with install.${IS_WIN ? 'ps1 -Service' : 'sh --service'}` };
  for (const [cmd, args] of seq[action]) {
    const r = run(cmd, args, { timeout: 60000 });
    if (!r.ok && action !== 'restart') return { ok: false, detail: r.err || r.out };
    if (!r.ok && cmd === 'schtasks' && args[0] === '/End') continue; // task may simply not be running
    if (!r.ok) return { ok: false, detail: r.err || r.out };
  }
  return { ok: true, detail: action };
}

// -------------------------------------------------------------- pi-hole ---
function detectPihole() {
  if (!IS_WIN && have('pihole')) return { type: 'native', name: 'pihole' };
  if (have('docker')) {
    const names = run('docker', ['ps', '-a', '--format', '{{.Names}}']).out.split('\n');
    const hit = names.find((n) => /pihole|pi-hole/i.test(n));
    if (hit) return { type: 'docker', name: hit };
  }
  return { type: 'none', name: null };
}

function piholeState(ph) {
  if (ph.type === 'native') {
    if (have('systemctl')) {
      const a = run('systemctl', ['is-active', 'pihole-FTL']).out;
      if (a === 'active') return 'running';
      if (a) return 'stopped';
    }
    const s = run('pihole', ['status'], { timeout: 15000 });
    if (/enabled|active|running/i.test(s.out)) return 'running';
    return s.ok ? 'stopped' : 'unknown';
  }
  if (ph.type === 'docker') {
    return run('docker', ['inspect', '-f', '{{.State.Running}}', ph.name]).out === 'true' ? 'running' : 'stopped';
  }
  return 'absent';
}

function piholeCtl(ph, action) { // start | stop | restart | restartdns
  if (ph.type === 'docker') {
    const act = action === 'restartdns' ? 'restart' : action;
    const r = run('docker', [act, ph.name], { timeout: 90000 });
    return { ok: r.ok, detail: r.ok ? act : (r.err || r.out) };
  }
  if (ph.type === 'native') {
    if (action === 'restartdns') {
      const r = run('pihole', ['restartdns'], { timeout: 60000 });
      if (r.ok) return { ok: true, detail: 'DNS resolver restarted' };
    }
    const via = have('systemctl') ? run('sudo', ['-n', 'systemctl', action === 'restartdns' ? 'restart' : action, 'pihole-FTL'], { timeout: 60000 }) : { ok: false, err: 'no systemctl' };
    if (via.ok) return { ok: true, detail: `pihole-FTL ${action}` };
    return { ok: false, detail: `${via.err || via.out} - try: sudo systemctl ${action === 'restartdns' ? 'restart' : action} pihole-FTL` };
  }
  return { ok: false, detail: 'Pi-hole not found on this machine' };
}

// ------------------------------------------------------------- probes -----
async function httpProbe(url, timeout = 5000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    return { up: true, status: r.status, ms: Date.now() - t0, body: await r.text().catch(() => '') };
  } catch (e) {
    return { up: false, err: e?.cause?.code || e?.name || String(e.message || e), ms: Date.now() - t0 };
  }
}

async function resolveVia(server, name = 'example.com') {
  const t0 = Date.now();
  try {
    const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
    if (server) r.setServers([server]);
    const addrs = await r.resolve4(name);
    return { ok: true, ms: Date.now() - t0, addrs };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.code || String(e) };
  }
}

async function systemLookup(name = 'example.com') {
  const t0 = Date.now();
  try {
    const r = await dns.promises.lookup(name);
    return { ok: true, ms: Date.now() - t0, addr: r.address };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.code || String(e) };
  }
}

function ping(host) {
  const args = IS_WIN ? ['-n', '1', '-w', '2000', host]
    : IS_MAC ? ['-c', '1', '-t', '3', host]
      : ['-c', '1', '-W', '2', host];
  return run('ping', args, { timeout: 8000 }).ok;
}

function defaultGateway() {
  if (IS_LINUX) {
    const m = run('ip', ['route', 'show', 'default']).out.match(/default via (\S+)/);
    return m ? m[1] : null;
  }
  if (IS_MAC) {
    const m = run('route', ['-n', 'get', 'default']).out.match(/gateway:\s*(\S+)/);
    return m ? m[1] : null;
  }
  const r = ps1("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop");
  const ip = r.out.split('\n')[0]?.trim();
  return ip && ip !== '0.0.0.0' ? ip : null;
}

function systemDnsServers() {
  try { return dns.getServers(); } catch { return []; }
}

function diskUsage(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - free, pct: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch { return null; }
}

function cpuTemps() {
  if (!IS_LINUX) return [];
  const out = [];
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      try {
        const t = parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8'), 10) / 1000;
        const type = fs.readFileSync(`/sys/class/thermal/${z}/type`, 'utf8').trim();
        if (t > 0) out.push({ zone: type, c: Math.round(t) });
      } catch { /* zone unreadable */ }
    }
  } catch { /* no thermal sysfs */ }
  return out;
}

// SQLite access: prefer the sqlite3 CLI, fall back to node:sqlite (Node 22+).
function sqliteQuery(db, sql) {
  if (have('sqlite3')) {
    const r = run('sqlite3', [db, sql], { timeout: 60000 });
    return r.ok ? { ok: true, out: r.out } : { ok: false, err: r.err || r.out };
  }
  try {
    // node:sqlite ships with Node 22.5+; on Node 20 this throws and we report "skipped".
    // Silence its ExperimentalWarning - it would interleave with our output.
    const origEmit = process.emit;
    process.emit = function (event, warning, ...rest) {
      if (event === 'warning' && warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning?.message || '')) return false;
      return origEmit.call(this, event, warning, ...rest);
    };
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const d = new DatabaseSync(db, { readOnly: false });
    try {
      const rows = d.prepare(sql).all();
      return { ok: true, out: rows.map((r) => Object.values(r).join('|')).join('\n') };
    } finally { d.close(); }
  } catch (e) {
    return { ok: false, err: `no sqlite3 CLI and node:sqlite unavailable (${e.code || e.message})` };
  }
}

function sqliteBackup(db, dest) {
  if (have('sqlite3')) {
    const r = run('sqlite3', [db, `.backup '${dest.replace(/'/g, "''")}'`], { timeout: 300000 });
    if (r.ok) return { ok: true, how: 'sqlite3 .backup (online, consistent)' };
    return { ok: false, err: r.err || r.out };
  }
  // Cold-ish copy: checkpoint if we can, then copy db + sidecars.
  sqliteQuery(db, 'PRAGMA wal_checkpoint(TRUNCATE);');
  try {
    fs.copyFileSync(db, dest);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, dest + ext);
    }
    return { ok: true, how: 'file copy (db + wal/shm)' };
  } catch (e) {
    return { ok: false, err: String(e.message || e) };
  }
}

// ----------------------------------------------------------- check suite ---
// Each check → { name, level: 'ok'|'warn'|'fail'|'info', detail, fix? }
// fix = { desc, apply: async () => ({ok, detail}) }

async function runChecks(cfg, { net = true } = {}) {
  const checks = [];
  const add = (name, level, detail, fix) => { checks.push({ name, level, detail, fix }); return checks.at(-1); };
  const svc = detectKeelService();
  const ph = detectPihole();

  // Keel install
  if (cfg.dir) {
    add('Keel install', 'ok', cfg.dir);
  } else if (svc.type === 'docker') {
    add('Keel install', 'info', `no host install - Keel runs in container ${svc.name}`);
  } else {
    add('Keel install', 'fail', 'no Keel directory found - pass --dir or set KEEL_DIR');
  }

  // Node version
  const major = parseInt(process.versions.node, 10);
  add('Node.js', major >= 20 ? 'ok' : 'warn', `v${process.versions.node}${major >= 20 ? '' : ' - Keel needs 20+'}`);

  // Keel service
  const state = keelServiceState(svc);
  if (svc.type === 'none') {
    add('Keel service', 'warn', `not registered as a service (install.${IS_WIN ? 'ps1 -Service' : 'sh --service'} sets this up)`);
  } else if (state === 'running') {
    add('Keel service', 'ok', `${svc.type} · ${svc.name} · running`);
  } else {
    add('Keel service', 'fail', `${svc.type} · ${svc.name} · ${state}`, {
      desc: 'start the Keel service',
      apply: async () => keelCtl(svc, 'start'),
    });
  }

  // Keel HTTP
  const health = await httpProbe(`http://127.0.0.1:${getPort(cfg)}/api/health`);
  if (health.up && health.status < 500) {
    add('Keel HTTP', 'ok', `http://127.0.0.1:${getPort(cfg)} answered ${health.status} in ${health.ms}ms`);
  } else {
    add('Keel HTTP', 'fail', `no answer on port ${getPort(cfg)} (${health.err || `HTTP ${health.status}`})`, svc.type !== 'none' ? {
      desc: 'restart the Keel service',
      apply: async () => keelCtl(svc, 'restart'),
    } : undefined);
  }

  // Database
  if (cfg.isPostgres) {
    add('Database', 'info', 'Postgres (managed externally - not checked here)');
  } else if (cfg.dbPath) {
    if (!fs.existsSync(cfg.dbPath)) {
      add('Database', 'fail', `${cfg.dbPath} does not exist`);
    } else {
      const sz = fs.statSync(cfg.dbPath).size;
      add('Database', 'ok', `${cfg.dbPath} (${fmtBytes(sz)})`);
      const wal = cfg.dbPath + '-wal';
      if (fs.existsSync(wal)) {
        const wsz = fs.statSync(wal).size;
        if (wsz > 64 * 1024 * 1024) {
          add('WAL journal', 'warn', `write-ahead log is ${fmtBytes(wsz)} - a checkpoint will fold it back into the db`, {
            desc: 'checkpoint the WAL (PRAGMA wal_checkpoint(TRUNCATE))',
            apply: async () => {
              const r = sqliteQuery(cfg.dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);');
              return { ok: r.ok, detail: r.ok ? 'checkpointed' : r.err };
            },
          });
        } else {
          add('WAL journal', 'ok', fmtBytes(wsz));
        }
      }
      const integ = sqliteQuery(cfg.dbPath, 'PRAGMA quick_check;');
      if (integ.ok) {
        add('DB integrity', integ.out === 'ok' ? 'ok' : 'fail', integ.out === 'ok' ? 'quick_check passed' : integ.out.split('\n')[0]);
      } else {
        add('DB integrity', 'info', `skipped (${integ.err})`);
      }
    }
  } else if (svc.type === 'docker') {
    // Reached only when the database could NOT be mapped to a host path - so
    // either there are no mounts at all, or the database sits outside them.
    // Both mean the data lives in the container's writable layer and dies with
    // it, which is worth saying plainly rather than filing under 'info'.
    const mounts = run('docker', ['inspect', '-f', '{{range .Mounts}}{{.Source}} → {{.Destination}}  {{end}}', svc.name]).out.trim();
    add('Database', 'warn', mounts
      ? `not on any mounted volume - it lives in the container layer and is lost if the container is recreated (mounts: ${mounts})`
      : 'the container has NO volume mounts - all data dies with the container; mount its data directory to the host');
  } else {
    add('Database', 'warn', 'DATABASE_URL not found in .env');
  }

  // Backups
  if (cfg.backupDir) {
    let files = [];
    try {
      files = fs.readdirSync(cfg.backupDir)
        .map((f) => { const p = path.join(cfg.backupDir, f); const st = fs.statSync(p); return { f, p, mtime: st.mtimeMs, dir: st.isDirectory() }; })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { /* missing dir handled below */ }
    if (!fs.existsSync(cfg.backupDir)) {
      add('Backups', 'warn', `backup folder ${cfg.backupDir} does not exist`, {
        desc: 'create the backup folder',
        apply: async () => { fs.mkdirSync(cfg.backupDir, { recursive: true }); return { ok: true, detail: 'created' }; },
      });
    } else if (files.length === 0) {
      add('Backups', 'warn', `no backups in ${cfg.backupDir} yet`, cfg.dbPath && fs.existsSync(cfg.dbPath) ? {
        desc: 'take a snapshot now (bigbox backup now)',
        apply: async () => backupNow(cfg, { quiet: true }),
      } : undefined);
    } else {
      const age = Date.now() - files[0].mtime;
      const stale = age > 7 * 24 * 3600 * 1000;
      add('Backups', stale ? 'warn' : 'ok', `${files.length} item(s), newest ${fmtAge(age)} (${files[0].f})`, stale && cfg.dbPath ? {
        desc: 'backup is stale - take a snapshot now',
        apply: async () => backupNow(cfg, { quiet: true }),
      } : undefined);
    }
    if (!cfg.env.KEEL_BACKUP_PASSPHRASE) {
      add('Backup passphrase', 'info', 'KEEL_BACKUP_PASSPHRASE not set - scheduled encrypted backups would fail');
    }
  }

  // Alerting - a box that cannot reach you fails silently by construction
  const chans = loadChannels();
  add('Notifications', chans.length ? 'ok' : 'warn', chans.length
    ? `${chans.length} channel(s): ${[...new Set(chans.map((c) => c.type))].join(', ')}`
    : 'none - failures will be silent. Set up: bigbox notify add <url>');

  // Disk
  const du = diskUsage(cfg.dbPath ? path.dirname(cfg.dbPath) : cfg.dir || os.homedir());
  if (du) {
    const level = du.pct >= 95 ? 'fail' : du.pct >= 85 ? 'warn' : 'ok';
    add('Disk space', level, `${du.pct}% used · ${fmtBytes(du.free)} free of ${fmtBytes(du.total)}`,
      level !== 'ok' && cfg.backupDir ? {
        desc: `prune old snapshots beyond the newest ${flags.keep}`,
        apply: async () => backupPrune(cfg, flags.keep, { quiet: true }),
      } : undefined);
  }

  // Memory / load / temps
  add('Memory', 'info', `${fmtBytes(os.totalmem() - os.freemem())} of ${fmtBytes(os.totalmem())} in use`);
  if (!IS_WIN) add('Load / uptime', 'info', `${os.loadavg().map((x) => x.toFixed(2)).join(' ')} · up ${fmtDur(os.uptime())}`);
  const temps = cpuTemps();
  if (temps.length) {
    const hot = temps.find((t) => t.c >= 80);
    add('Temperature', hot ? 'warn' : 'info', temps.map((t) => `${t.zone} ${t.c}°C`).join(' · ') + (hot ? ' - check cooling/dust' : ''));
  }

  // Linux: linger, so the user service survives logout
  if (IS_LINUX && svc.type === 'systemd' && have('loginctl')) {
    const lr = run('loginctl', ['show-user', os.userInfo().username, '--property=Linger']);
    if (lr.ok && lr.out.includes('Linger=no')) {
      add('Login linger', 'warn', 'Keel (user service) stops when you log out', {
        desc: `enable lingering for ${os.userInfo().username}`,
        apply: async () => {
          const r = run('loginctl', ['enable-linger', os.userInfo().username]);
          return { ok: r.ok, detail: r.ok ? 'enabled' : `${r.err} - run: sudo loginctl enable-linger ${os.userInfo().username}` };
        },
      });
    }
  }

  // Pi-hole
  const phState = piholeState(ph);
  if (ph.type === 'none') {
    add('Pi-hole', 'info', 'not found on this machine');
  } else if (phState === 'running') {
    add('Pi-hole', 'ok', `${ph.type === 'docker' ? `docker · ${ph.name}` : 'native'} · running`);
    const d = await resolveVia('127.0.0.1');
    if (d.ok) {
      add('Pi-hole DNS', 'ok', `resolved example.com via 127.0.0.1 in ${d.ms}ms`);
    } else {
      add('Pi-hole DNS', 'fail', `127.0.0.1 did not answer (${d.err})`, {
        desc: 'restart the Pi-hole DNS resolver',
        apply: async () => piholeCtl(ph, 'restartdns'),
      });
    }
  } else {
    add('Pi-hole', 'fail', `found (${ph.type}) but ${phState}`, {
      desc: 'start Pi-hole',
      apply: async () => piholeCtl(ph, 'start'),
    });
  }

  // Internet ladder (condensed for doctor; `bigbox net` prints the full story)
  if (net) {
    const gw = defaultGateway();
    if (!gw) {
      add('Gateway', 'fail', 'no default route - cable/Wi-Fi down or DHCP failed');
    } else {
      const gwOk = ping(gw);
      add('Gateway', gwOk ? 'ok' : 'fail', `${gw}${gwOk ? '' : ' unreachable'}`);
    }
    const raw = ping('1.1.1.1');
    add('Internet (IP)', raw ? 'ok' : 'fail', raw ? 'ping 1.1.1.1 OK' : 'cannot reach 1.1.1.1 - WAN/modem/ISP problem');
    const sys = await systemLookup();
    add('DNS (system)', sys.ok ? 'ok' : 'fail', sys.ok ? `example.com → ${sys.addr} in ${sys.ms}ms` : `system resolver failed (${sys.err})`);
    if (raw) {
      const web = await httpProbe('https://one.one.one.one', 6000);
      add('HTTPS', web.up ? 'ok' : 'warn', web.up ? `outbound TLS OK (${web.ms}ms)` : `HTTPS blocked or filtered (${web.err})`);
    }
  }

  // Remote access layers (informational)
  if (have('tailscale')) {
    const t = run('tailscale', ['status', '--peers=false'], { timeout: 8000 });
    add('Tailscale', t.ok ? 'ok' : 'warn', t.ok ? (t.out.split('\n')[0] || 'up') : 'installed but not responding (tailscale up?)');
  }
  if (have('cloudflared')) add('Cloudflare Tunnel', 'info', 'cloudflared is installed (managed from Keel Settings)');

  return checks;
}

function renderChecks(checks) {
  for (const c of checks) {
    const mark = c.level === 'ok' ? OK() : c.level === 'fail' ? FAIL() : c.level === 'warn' ? WARN() : dim('·');
    line(mark, `${bold(c.name.padEnd(18))} ${c.detail}`);
  }
}

function summarize(checks) {
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return { fails, warns };
}

// ------------------------------------------------------------- commands ---
async function cmdStatus(cfg) {
  const checks = await runChecks(cfg, { net: true });
  if (flags.json) { console.log(JSON.stringify({ at: new Date().toISOString(), checks }, null, 2)); return summarize(checks).fails ? 2 : 0; }
  say(`BigBox status - ${os.hostname()} (${process.platform})`);
  renderChecks(checks);
  const { fails, warns } = summarize(checks);
  console.log();
  if (fails) line(FAIL(), `${fails} problem(s) - run ${bold('bigbox doctor --fix')} to attempt repair`);
  else if (warns) line(WARN(), `${warns} warning(s) - run ${bold('bigbox doctor')} for details`);
  else line(OK(), 'everything looks healthy');
  return fails ? 2 : warns ? 1 : 0;
}

async function cmdDoctor(cfg) {
  say(`BigBox doctor - ${os.hostname()}`);
  const checks = await runChecks(cfg, { net: true });
  if (flags.json && !flags.fix) { console.log(JSON.stringify({ at: new Date().toISOString(), checks }, null, 2)); return summarize(checks).fails ? 2 : 0; }
  renderChecks(checks);
  const fixes = checks.filter((c) => c.fix && (c.level === 'fail' || c.level === 'warn'));
  console.log();
  if (!fixes.length) {
    const { fails, warns } = summarize(checks);
    if (fails || warns) line(WARN(), 'nothing here is auto-fixable - see details above');
    else line(OK(), 'no problems found');
    return summarize(checks).fails ? 2 : 0;
  }
  if (!flags.fix) {
    say(`${fixes.length} issue(s) can be self-remediated:`);
    for (const c of fixes) line(dim('→'), `${c.name}: ${c.fix.desc}`);
    console.log(`\n  Re-run with ${bold('--fix')} to apply (add ${bold('--dry-run')} to preview).`);
    return 1;
  }
  say(flags.dryRun ? 'Dry run - would apply:' : 'Applying fixes');
  let applied = 0;
  for (const c of fixes) {
    if (flags.dryRun) { line(dim('→'), `${c.name}: ${c.fix.desc}`); continue; }
    const r = await c.fix.apply();
    line(r.ok ? OK() : FAIL(), `${c.name}: ${c.fix.desc} - ${r.detail || (r.ok ? 'done' : 'failed')}`);
    if (r.ok) applied++;
  }
  if (!flags.dryRun && applied) {
    console.log();
    say('Re-checking');
    await new Promise((r) => setTimeout(r, 4000)); // give restarted services a beat
    const after = await runChecks(cfg, { net: true });
    renderChecks(after);
    const { fails } = summarize(after);
    console.log();
    line(fails ? WARN() : OK(), fails ? `${fails} problem(s) remain` : 'all clear after remediation');
    return fails ? 2 : 0;
  }
  return 0;
}

async function cmdCtl(cfg, action, target) {
  const svc = detectKeelService();
  const ph = detectPihole();
  const doKeel = target === 'keel' || target === 'all';
  const doPihole = target === 'pihole' || target === 'all';
  const doDns = target === 'dns';
  let rc = 0;

  if (doKeel) {
    say(`${action} Keel`);
    const r = keelCtl(svc, action);
    line(r.ok ? OK() : FAIL(), r.detail);
    if (r.ok && action !== 'stop') {
      for (let i = 0; i < 15; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const h = await httpProbe(`http://127.0.0.1:${getPort(cfg)}/api/health`, 3000);
        if (h.up) { line(OK(), `Keel is answering on port ${getPort(cfg)} (${h.ms}ms)`); break; }
        if (i === 14) { line(WARN(), `service ${action}ed but port ${getPort(cfg)} not answering yet - check: bigbox logs keel`); rc = 1; }
      }
    }
    if (!r.ok) rc = 2;
  }
  if (doPihole) {
    say(`${action} Pi-hole`);
    const r = piholeCtl(ph, action);
    line(r.ok ? OK() : FAIL(), r.detail);
    if (r.ok && action !== 'stop') {
      await new Promise((res) => setTimeout(res, 3000));
      const d = await resolveVia('127.0.0.1');
      line(d.ok ? OK() : WARN(), d.ok ? `DNS answering (${d.ms}ms)` : `DNS not answering yet (${d.err})`);
    }
    if (!r.ok) rc = 2;
  }
  if (doDns) {
    say('Restarting DNS resolver');
    const r = piholeCtl(ph, 'restartdns');
    line(r.ok ? OK() : FAIL(), r.detail);
    if (!r.ok) rc = 2;
  }
  return rc;
}

async function cmdLogs(cfg, target) {
  const n = String(flags.lines);
  if (target === 'pihole') {
    const ph = detectPihole();
    if (ph.type === 'docker') return runStream('docker', ['logs', ...(flags.follow ? ['-f'] : []), '--tail', n, ph.name]);
    if (ph.type === 'native') {
      if (flags.follow && have('pihole')) return runStream('pihole', ['-t']);
      for (const p of ['/var/log/pihole/pihole.log', '/var/log/pihole.log']) {
        if (fs.existsSync(p)) return runStream('tail', [...(flags.follow ? ['-f'] : []), '-n', n, p]);
      }
      if (have('journalctl')) return runStream('journalctl', ['-u', 'pihole-FTL', '-n', n, ...(flags.follow ? ['-f'] : [])]);
    }
    line(FAIL(), 'no Pi-hole logs found on this machine');
    return 1;
  }
  const svc = detectKeelService();
  switch (svc.type) {
    case 'systemd': return runStream('journalctl', ['--user', '-u', 'keel', '-n', n, ...(flags.follow ? ['-f'] : [])]);
    case 'systemd-system': return runStream('journalctl', ['-u', 'keel', '-n', n, ...(flags.follow ? ['-f'] : [])]);
    case 'docker': return runStream('docker', ['logs', ...(flags.follow ? ['-f'] : []), '--tail', n, svc.name]);
    case 'launchd':
      if (cfg.logPath && fs.existsSync(cfg.logPath)) return runStream('tail', [...(flags.follow ? ['-f'] : []), '-n', n, cfg.logPath]);
      line(FAIL(), `no log file at ${cfg.logPath}`);
      return 1;
    case 'schtasks': {
      if (cfg.logPath && fs.existsSync(cfg.logPath)) {
        const content = fs.readFileSync(cfg.logPath, 'utf8').split(/\r?\n/);
        console.log(content.slice(-flags.lines).join('\n'));
        return 0;
      }
      line(WARN(), 'the scheduled task does not redirect output - check Event Viewer, or run Keel in a terminal (`npm start`) to see live logs');
      return 1;
    }
    default:
      line(FAIL(), 'no Keel service found - is it installed as a service?');
      return 1;
  }
}

function backupNow(cfg, { quiet = false } = {}) {
  if (!cfg.dbPath || !fs.existsSync(cfg.dbPath)) return { ok: false, detail: 'no SQLite database found (Postgres installs back up on the DB side)' };
  let dest = path.join(cfg.backupDir, `keel-snapshot-${ts()}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(cfg.backupDir, `keel-snapshot-${ts()}-${i}`);
  fs.mkdirSync(dest, { recursive: true });
  // Keep the database's own name so a restore is an obvious file copy back.
  const dbName = path.basename(cfg.dbPath);
  const r = sqliteBackup(cfg.dbPath, path.join(dest, dbName));
  if (!r.ok) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ } return { ok: false, detail: r.err }; }
  try {
    // Configuration travels with the snapshot - above all KEEL_BACKUP_PASSPHRASE,
    // without which an encrypted backup cannot be restored at all. A container
    // install has no host .env, so serialise what the container actually has.
    const envDest = path.join(dest, 'keel.env');
    const envSrc = cfg.dir ? path.join(cfg.dir, '.env') : null;
    if (envSrc && fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, envDest);
    } else if (cfg.container && cfg.env) {
      const keep = Object.entries(cfg.env)
        .filter(([k]) => /^(KEEL_|DATABASE_URL|PORT|GOOGLE_|GITHUB_|MS_)/.test(k))
        .map(([k, v]) => `${k}=${v}`);
      if (keep.length) fs.writeFileSync(envDest, `# captured from container ${cfg.container}\n${keep.join('\n')}\n`);
    }
    if (fs.existsSync(envDest) && !IS_WIN) fs.chmodSync(envDest, 0o600);
  } catch { /* config capture is best-effort */ }
  const size = fs.statSync(path.join(dest, dbName)).size;
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(), host: os.hostname(), tool: `bigbox ${VERSION}`,
    method: r.how, dbBytes: size, source: cfg.dbPath,
  }, null, 2));
  if (!quiet) {
    line(OK(), `snapshot written: ${dest}`);
    line(dim('·'), `${r.how} · ${fmtBytes(size)} · includes .env copy (keel.env - contains your backup passphrase, keep it private)`);
  }
  return { ok: true, detail: `snapshot ${path.basename(dest)} (${fmtBytes(size)})` };
}

function backupPrune(cfg, keep, { quiet = false } = {}) {
  let snaps = [];
  try {
    snaps = fs.readdirSync(cfg.backupDir)
      .filter((f) => f.startsWith('keel-snapshot-'))
      .map((f) => ({ f, p: path.join(cfg.backupDir, f), mtime: fs.statSync(path.join(cfg.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return { ok: false, detail: 'backup folder unreadable' }; }
  const victims = snaps.slice(keep);
  if (!victims.length) return { ok: true, detail: `nothing to prune (${snaps.length} snapshot(s), keeping ${keep})` };
  for (const v of victims) {
    if (flags.dryRun) { line(dim('→'), `would delete ${v.f}`); continue; }
    fs.rmSync(v.p, { recursive: true, force: true });
    if (!quiet) line(OK(), `deleted ${v.f}`);
  }
  return { ok: true, detail: `pruned ${victims.length} snapshot(s), kept ${Math.min(keep, snaps.length)}` };
}

async function cmdBackup(cfg, sub) {
  if (!cfg.dir && !cfg.dbPath) { line(FAIL(), 'no Keel install found'); return 2; }
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  switch (sub) {
    case 'now': {
      say('Backing up Keel');
      const r = backupNow(cfg);
      if (!r.ok) {
        line(FAIL(), r.detail);
        // The exact failure mode that once went unnoticed for ten days.
        try { await sendNotification('BigBox: backup FAILED', r.detail, { ok: false }); } catch { /* best-effort */ }
        return 2;
      }
      line(dim('·'), `Keel's own in-app backups (Settings → Backups) also land in ${cfg.backupDir}`);
      return 0;
    }
    case 'list': {
      say(`Backups in ${cfg.backupDir}`);
      let items = [];
      try {
        items = fs.readdirSync(cfg.backupDir).map((f) => {
          const p = path.join(cfg.backupDir, f); const st = fs.statSync(p);
          let size = st.size;
          if (st.isDirectory()) {
            size = 0;
            try { for (const g of fs.readdirSync(p)) size += fs.statSync(path.join(p, g)).size; } catch { /* partial */ }
          }
          return { f, size, mtime: st.mtimeMs, dir: st.isDirectory() };
        }).sort((a, b) => b.mtime - a.mtime);
      } catch { /* empty */ }
      if (!items.length) { line(WARN(), 'no backups yet - run: bigbox backup now'); return 1; }
      for (const it of items) line(dim('·'), `${it.f.padEnd(40)} ${fmtBytes(it.size).padStart(9)}  ${fmtAge(Date.now() - it.mtime)}`);
      return 0;
    }
    case 'prune': {
      say(`Pruning snapshots (keeping newest ${flags.keep})`);
      const r = backupPrune(cfg, flags.keep);
      line(r.ok ? OK() : FAIL(), r.detail);
      return r.ok ? 0 : 2;
    }
    case 'verify': {
      say('Verifying newest snapshot');
      let snaps = [];
      try {
        snaps = fs.readdirSync(cfg.backupDir).filter((f) => f.startsWith('keel-snapshot-')).sort().reverse();
      } catch { /* none */ }
      if (!snaps.length) { line(WARN(), 'no bigbox snapshots found - run: bigbox backup now'); return 1; }
      const snapDir = path.join(cfg.backupDir, snaps[0]);
      const dbFile = (() => {
        try { return fs.readdirSync(snapDir).find((f) => f.endsWith('.db')); } catch { return null; }
      })();
      if (!dbFile) { line(FAIL(), `${snaps[0]} contains no .db file`); return 2; }
      const db = path.join(snapDir, dbFile);
      const r = sqliteQuery(db, 'PRAGMA integrity_check;');
      if (!r.ok) { line(WARN(), `cannot verify (${r.err})`); return 1; }
      const good = r.out === 'ok';
      line(good ? OK() : FAIL(), `${snaps[0]}: integrity_check ${good ? 'passed' : `FAILED - ${r.out.split('\n')[0]}`}`);
      return good ? 0 : 2;
    }
    default:
      line(FAIL(), `unknown backup subcommand '${sub || ''}' - use: now | list | prune | verify`);
      return 2;
  }
}

function cmdPaths(cfg) {
  say(`BigBox data map - ${os.hostname()}`);
  const row = (k, v, note) => line(dim('·'), `${bold(k.padEnd(18))} ${v ?? dim('(not found)')}${note ? dim(`  ${note}`) : ''}`);
  row('Keel install', cfg.dir || (cfg.container ? `container ${cfg.container} (no host install)` : null));
  row('Config (.env)', cfg.dir ? path.join(cfg.dir, '.env') : (cfg.container ? `container environment - bigbox env` : null),
    'backup passphrase, OAuth secrets');
  if (cfg.isPostgres) row('Database', 'Postgres (see DATABASE_URL)', 'data lives in the DB server');
  else row('Database', cfg.dbPath, cfg.dbPath && fs.existsSync(cfg.dbPath) ? fmtBytes(fs.statSync(cfg.dbPath).size) : '');
  row('Backups', cfg.backupDir, 'point this at a synced folder (Drive/OneDrive/Syncthing) for off-site copies');
  const svc = detectKeelService();
  if (svc.type === 'systemd') row('Service', '~/.config/systemd/user/keel.service', 'logs: journalctl --user -u keel');
  if (svc.type === 'launchd') row('Service', svc.plist, `logs: ${cfg.logPath}`);
  if (svc.type === 'schtasks') row('Service', `Scheduled Task "${svc.name}"`, 'Task Scheduler');
  if (svc.type === 'docker') row('Service', `docker container "${svc.name}"`, 'logs: docker logs ' + svc.name);
  const ph = detectPihole();
  if (ph.type === 'native') {
    row('Pi-hole config', '/etc/pihole/', 'gravity db, custom lists, teleporter backups');
    row('Pi-hole dnsmasq', '/etc/dnsmasq.d/', '');
  } else if (ph.type === 'docker') {
    const mounts = run('docker', ['inspect', '-f', '{{range .Mounts}}{{.Source}} → {{.Destination}}\n{{end}}', ph.name]).out;
    row('Pi-hole (docker)', ph.name, '');
    for (const m of mounts.split('\n').filter(Boolean)) line(dim('·'), `${''.padEnd(19)}${m}`);
  }
  console.log();
  line(dim('·'), 'Attachments live inside the Keel database, so a database backup covers everything.');
  return 0;
}

/**
 * Walk the network stack from the wire up and return structured steps plus a
 * plain-language diagnosis. Shared by `bigbox net` and the GUI, so both tell
 * the same story.
 */
async function runNetLadder(cfg) {
  const ph = detectPihole();
  const steps = [];
  const step = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };

  const gw = defaultGateway();
  step('1. Default route', !!gw, gw ? `gateway is ${gw}` : 'none - network cable/Wi-Fi down, or DHCP gave no lease');

  const gwOk = gw ? ping(gw) : false;
  if (gw) step('2. Router reachable', gwOk, gwOk ? `${gw} answers ping` : `${gw} does not answer - router down or local link broken`);

  const rawOk = ping('1.1.1.1');
  step('3. Internet (no DNS)', rawOk, rawOk ? 'ping 1.1.1.1 OK - the WAN link works' : 'cannot reach 1.1.1.1 - modem/ISP outage (DNS is not the problem)');

  let phOk = null;
  if (ph.type !== 'none') {
    const d = await resolveVia('127.0.0.1');
    phOk = d.ok;
    step('4. DNS via Pi-hole', d.ok, d.ok ? `example.com resolved in ${d.ms}ms` : `Pi-hole (127.0.0.1) not answering (${d.err})`);
  }

  // Isolates "Pi-hole is broken" from "the internet's DNS is broken".
  const up = await resolveVia('1.1.1.1');
  step(ph.type !== 'none' ? '5. DNS upstream (1.1.1.1)' : '4. DNS (1.1.1.1)', up.ok, up.ok ? `resolved in ${up.ms}ms` : `upstream DNS failed (${up.err})`);

  const sys = await systemLookup();
  step('6. System resolver', sys.ok, sys.ok ? `example.com → ${sys.addr} (servers: ${systemDnsServers().slice(0, 3).join(', ')})` : `failed (${sys.err}) - check /etc/resolv.conf or DHCP DNS settings`);

  const web = await httpProbe('https://www.google.com', 8000);
  step('7. HTTPS end-to-end', web.up, web.up ? `TLS handshake + fetch OK in ${web.ms}ms` : `failed (${web.err})`);

  const port = getPort(cfg);
  const keel = await httpProbe(`http://127.0.0.1:${port}/api/health`, 4000);
  step('8. Keel (local)', keel.up, keel.up ? `port ${port} answering` : `port ${port} not answering - bigbox restart keel`);

  const firstFailure = steps.find((s) => !s.ok)?.name ?? null;
  let diagnosis;
  if (!firstFailure) {
    diagnosis = { level: 'ok', text: "every layer works - if a device on your network still has trouble, it is that device's DNS/network settings, not BigBox" };
  } else if (firstFailure.startsWith('1.') || firstFailure.startsWith('2.')) {
    diagnosis = { level: 'fail', title: 'Local network problem.', text: 'Check the cable/Wi-Fi and the router. Nothing on BigBox can fix this.' };
  } else if (firstFailure.startsWith('3.')) {
    diagnosis = { level: 'fail', title: 'Your ISP/modem link is down.', text: "Router is fine locally. Power-cycle the modem; if it persists, it's the ISP." };
  } else if (phOk === false && up.ok) {
    diagnosis = { level: 'fail', title: 'Pi-hole is the problem', text: 'upstream DNS works but Pi-hole does not answer.', fixable: 'restart-dns' };
  } else if (!up.ok && rawOk) {
    diagnosis = { level: 'fail', title: 'Outbound DNS (port 53) appears blocked', text: 'IP traffic works but no resolver answers. Check firewall/ISP DNS interception.' };
  } else if (!sys.ok) {
    diagnosis = { level: 'fail', title: 'The system resolver is misconfigured', text: 'point it at Pi-hole (127.0.0.1) or a public resolver.' };
  } else if (!web.up) {
    diagnosis = { level: 'warn', text: 'DNS works but HTTPS fails - captive portal, firewall, or TLS interception in the path.' };
  } else if (!keel.up) {
    diagnosis = { level: 'warn', text: 'The internet is fine; only Keel is down. Restart Keel, then check its logs if it does not come back.' };
  } else {
    diagnosis = { level: 'warn', text: `${firstFailure} failed.` };
  }
  return { steps, diagnosis, ph };
}

async function cmdNet(cfg) {
  if (flags.json) {
    const { steps, diagnosis } = await runNetLadder(cfg);
    console.log(JSON.stringify({ at: new Date().toISOString(), steps, diagnosis }, null, 2));
    return diagnosis.level === 'ok' ? 0 : 2;
  }
  say('Internet troubleshooting - walking the stack from the wire up');
  const { steps, diagnosis, ph } = await runNetLadder(cfg);
  for (const s of steps) line(s.ok ? OK() : FAIL(), `${bold(s.name.padEnd(22))} ${s.detail}`);
  console.log();

  const mark = diagnosis.level === 'ok' ? OK() : diagnosis.level === 'warn' ? WARN() : FAIL();
  line(mark, `${diagnosis.title ? bold(diagnosis.title) + ' ' : ''}${diagnosis.text}`);

  if (diagnosis.fixable === 'restart-dns') {
    if (flags.fix) {
      const r = piholeCtl(ph, 'restartdns');
      line(r.ok ? OK() : FAIL(), `restart Pi-hole DNS: ${r.detail}`);
      if (r.ok) {
        await new Promise((res) => setTimeout(res, 3000));
        const again = await resolveVia('127.0.0.1');
        line(again.ok ? OK() : FAIL(), again.ok ? 'Pi-hole is answering again' : 'still down - try: bigbox logs pihole');
      }
    } else {
      line(dim('→'), `run ${bold('bigbox net --fix')} (or ${bold('bigbox restart dns')}) to restart it`);
    }
  }
  return diagnosis.level === 'ok' ? 0 : 2;
}

async function cmdPihole(passArgs) {
  const ph = detectPihole();
  if (ph.type === 'native') return runStream('pihole', passArgs);
  if (ph.type === 'docker') return runStream('docker', ['exec', ph.name, 'pihole', ...passArgs]);
  line(FAIL(), 'Pi-hole not found on this machine');
  return 1;
}

async function cmdUpdate(cfg) {
  if (!cfg.dir) { line(FAIL(), 'no Keel install found'); return 2; }
  const svc = detectKeelService();
  say(`Updating Keel in ${cfg.dir}`);

  line(dim('·'), 'snapshotting the database first (rollback insurance)');
  const b = backupNow(cfg, { quiet: true });
  line(b.ok ? OK() : WARN(), b.ok ? b.detail : `backup skipped: ${b.detail}`);

  const git = (args) => run('git', ['-C', cfg.dir, ...args], { timeout: 120000 });
  const dirty = git(['status', '--porcelain']).out;
  if (dirty && !flags.yes) {
    line(FAIL(), 'the install directory has local changes - re-run with --yes to update anyway (git stash is applied first)');
    return 2;
  }
  if (dirty) { git(['stash', 'push', '-m', `bigbox-update-${ts()}`]); line(WARN(), 'local changes stashed (git stash list to recover)'); }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  let r = git(['fetch', 'origin', branch]);
  if (!r.ok) { line(FAIL(), `git fetch failed: ${r.err}`); return 2; }
  const before = git(['rev-parse', 'HEAD']).out.slice(0, 8);
  r = git(['reset', '--hard', `origin/${branch}`]);
  if (!r.ok) { line(FAIL(), `git reset failed: ${r.err}`); return 2; }
  const after = git(['rev-parse', 'HEAD']).out.slice(0, 8);
  line(OK(), before === after ? `already up to date (${after})` : `updated ${before} → ${after}`);

  if (before !== after || flags.yes) {
    const npm = IS_WIN ? 'npm.cmd' : 'npm';
    say('Installing dependencies and rebuilding (this can take a few minutes)');
    for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'db:migrate:deploy'], ['run', 'build']]) {
      const rr = run(npm, args, { timeout: 900000 });
      line(rr.ok ? OK() : FAIL(), `npm ${args.join(' ')}`);
      if (!rr.ok) { console.log(dim((rr.err || rr.out).split('\n').slice(-15).join('\n'))); return 2; }
    }
    say('Restarting Keel');
    const rs = keelCtl(svc, 'restart');
    line(rs.ok ? OK() : FAIL(), rs.detail);
    if (rs.ok) {
      for (let i = 0; i < 15; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const h = await httpProbe(`http://127.0.0.1:${getPort(cfg)}/api/health`, 3000);
        if (h.up) { line(OK(), 'Keel is back up'); return 0; }
      }
      line(WARN(), 'restarted but not answering yet - check: bigbox logs keel');
      return 1;
    }
    return 2;
  }
  return 0;
}

function redactEnv(env) {
  const SECRET = /PASS|SECRET|KEY|TOKEN|DATABASE_URL/i;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET.test(k) ? (v ? '<set, redacted>' : '<empty>') : v]));
}

async function cmdReport(cfg) {
  say('Building a support bundle (secrets redacted)');
  const checks = await runChecks(cfg, { net: true });
  const svc = detectKeelService();
  const ph = detectPihole();
  let logTail = '(no logs collected)';
  if (svc.type === 'systemd') logTail = run('journalctl', ['--user', '-u', 'keel', '-n', '60', '--no-pager']).out;
  else if (svc.type === 'docker') logTail = run('docker', ['logs', '--tail', '60', svc.name]).err || run('docker', ['logs', '--tail', '60', svc.name]).out;
  else if (cfg.logPath && fs.existsSync(cfg.logPath)) logTail = fs.readFileSync(cfg.logPath, 'utf8').split(/\r?\n/).slice(-60).join('\n');

  const md = [
    `# BigBox report - ${os.hostname()} - ${new Date().toISOString()}`,
    '',
    '## System',
    `- Platform: ${process.platform} ${os.release()} (${os.arch()})`,
    `- Node: ${process.version} · bigbox ${VERSION}`,
    `- Uptime: ${fmtDur(os.uptime())} · load: ${IS_WIN ? 'n/a' : os.loadavg().map((x) => x.toFixed(2)).join(' ')}`,
    `- Memory: ${fmtBytes(os.totalmem() - os.freemem())} / ${fmtBytes(os.totalmem())}`,
    '',
    '## Services',
    `- Keel: ${svc.type} (${svc.name ?? '-'}) · state: ${keelServiceState(svc)}`,
    `- Pi-hole: ${ph.type} (${ph.name ?? '-'}) · state: ${piholeState(ph)}`,
    '',
    '## Checks',
    ...checks.map((c) => `- [${c.level.toUpperCase()}] ${c.name}: ${c.detail}`),
    '',
    '## Keel .env (redacted)',
    '```',
    ...Object.entries(redactEnv(cfg.env)).map(([k, v]) => `${k}=${v}`),
    '```',
    '',
    '## Last 60 log lines (Keel)',
    '```',
    logTail || '(empty)',
    '```',
    '',
  ].join('\n');
  const out = path.join(cfg.backupDir && fs.existsSync(cfg.backupDir) ? cfg.backupDir : process.cwd(), `bigbox-report-${ts()}.md`);
  fs.writeFileSync(out, md);
  line(OK(), `report written: ${out}`);
  line(dim('·'), 'safe to share - passphrases, secrets and DATABASE_URL are redacted (skim the log tail before posting publicly)');
  return 0;
}

// ------------------------------------------------------------ notify ------
// Alert channels. The watchdog has been able to fix things for a while; this
// is what finally lets it TELL someone. Channels live in ~/.bigbox/notify.json
// (mode 600 - the URLs carry tokens), alert state in ~/.bigbox/state.json so
// an ongoing failure alerts once, reminds every six hours, and announces its
// own recovery instead of paging every five minutes forever.

function bigboxDir() {
  const d = path.join(os.homedir(), '.bigbox');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* exists */ }
  return d;
}
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJson600(f, obj) {
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
  if (!IS_WIN) { try { fs.chmodSync(f, 0o600); } catch { /* best effort */ } }
}
const NOTIFY_FILE = () => path.join(bigboxDir(), 'notify.json');
const STATE_FILE = () => path.join(bigboxDir(), 'state.json');
function loadChannels() { return readJson(NOTIFY_FILE(), {}).channels || []; }

function detectChannelType(url) {
  if (/\/api\/push\//.test(url)) return 'kuma';
  if (/\/message\b/.test(url) && /[?&]token=/.test(url)) return 'gotify';
  if (/ntfy/i.test(url)) return 'ntfy';
  return 'webhook';
}

/** Tokens stay out of terminal output and reports. */
function maskUrl(u) {
  return u
    .replace(/([?&]token=)[^&]+/, '$1…')
    .replace(/(\/api\/push\/)[A-Za-z0-9_-]+/, '$1…')
    .replace(/(ntfy\.[a-z]+\/)(.{3})[^/?]*/, '$1$2…');
}

async function postChannel(ch, { title, message, ok = false }) {
  const signal = AbortSignal.timeout(8000);
  try {
    let res;
    if (ch.type === 'ntfy') {
      res = await fetch(ch.url, {
        method: 'POST', signal, body: message,
        // ntfy headers must be latin-1; strip anything that is not
        headers: {
          Title: title.replace(/[^\x20-\x7e]/g, ''),
          Priority: ok ? 'default' : 'high',
          Tags: ok ? 'white_check_mark' : 'rotating_light',
        },
      });
    } else if (ch.type === 'gotify') {
      res = await fetch(ch.url, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message, priority: ok ? 4 : 8 }),
      });
    } else if (ch.type === 'kuma') {
      // A push monitor: bigbox reports its own verdict as the status.
      const base = ch.url.split('?')[0];
      res = await fetch(`${base}?status=${ok ? 'up' : 'down'}&msg=${encodeURIComponent(`${title}: ${message}`.slice(0, 250))}`, { signal });
    } else {
      res = await fetch(ch.url, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'bigbox', host: os.hostname(), title, message, ok, at: new Date().toISOString() }),
      });
    }
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e?.cause?.code || e?.name || String(e.message || e) };
  }
}

async function sendNotification(title, message, { ok = false } = {}) {
  const results = [];
  for (const ch of loadChannels()) {
    results.push({ ch, ...(await postChannel(ch, { title, message, ok })) });
  }
  return results;
}

// Alert state machine: new failure → alert; persisting → remind after 6h;
// cleared → recovery message. Keyed per subsystem, survives restarts on disk.
const RESEND_MS = 6 * 3600 * 1000;
async function reconcileAlerts(events) {
  const st = readJson(STATE_FILE(), {});
  st.alerts = st.alerts || {};
  const now = Date.now();
  for (const [key, msg] of Object.entries(events)) {
    const a = st.alerts[key];
    if (!a) {
      st.alerts[key] = { since: now, lastSent: now };
      await sendNotification(`BigBox: ${key} problem`, msg, { ok: false });
    } else if (now - a.lastSent > RESEND_MS) {
      a.lastSent = now;
      await sendNotification(`BigBox: ${key} still failing`, `${msg} - since ${new Date(a.since).toISOString().replace('T', ' ').slice(0, 16)}`, { ok: false });
    }
  }
  for (const key of Object.keys(st.alerts)) {
    if (!(key in events)) {
      const downFor = fmtDur(Math.round((now - st.alerts[key].since) / 1000));
      delete st.alerts[key];
      await sendNotification(`BigBox: ${key} recovered`, `healthy again after ${downFor}`, { ok: true });
    }
  }
  writeJson600(STATE_FILE(), st);
}

/** One message a day when nothing is wrong, so silence itself means something. */
async function maybeDailyDigest(cfg) {
  if (!loadChannels().length) return false;
  const st = readJson(STATE_FILE(), {});
  const today = new Date().toISOString().slice(0, 10);
  if (st.lastDigest === today) return false;
  const checks = await runChecks(cfg, { net: false });
  const { fails, warns } = summarize(checks);
  const bad = checks
    .filter((c) => c.level === 'fail' || c.level === 'warn')
    .map((c) => `${c.level === 'fail' ? '✗' : '!'} ${c.name}: ${c.detail}`);
  const title = fails ? `BigBox daily - ${fails} problem(s)`
    : warns ? `BigBox daily - ok, ${warns} warning(s)`
      : 'BigBox daily - all clear';
  await sendNotification(title, bad.length ? bad.slice(0, 8).join('\n') : `all ${checks.length} checks healthy`, { ok: !fails });
  st.lastDigest = today;
  writeJson600(STATE_FILE(), st);
  return true;
}

async function cmdNotify(sub, args) {
  const channels = loadChannels();
  const save = (chs) => writeJson600(NOTIFY_FILE(), { channels: chs });

  if (!sub || sub === 'list' || sub === 'show') {
    say('Notification channels');
    if (!channels.length) {
      line(WARN(), 'none configured - failures are only visible in logs');
      line(dim('→'), 'add one: bigbox notify add https://ntfy.sh/your-topic');
      return 1;
    }
    channels.forEach((ch, i) => line(dim('·'), `${i + 1}. ${bold(ch.type.padEnd(8))} ${maskUrl(ch.url)}`));
    line(dim('→'), `stored in ${NOTIFY_FILE()}`);
    return 0;
  }

  if (sub === 'add') {
    let [a, b] = args;
    const type = b ? a : (a ? detectChannelType(a) : null);
    const url = b || a;
    if (!url || !/^https?:\/\//.test(url)) {
      line(FAIL(), 'usage: bigbox notify add [ntfy|gotify|kuma|webhook] <https url>');
      line(dim('·'), 'ntfy:    https://ntfy.sh/<your-topic>            (easiest - pick a hard-to-guess topic)');
      line(dim('·'), 'gotify:  https://gotify.example/message?token=…');
      line(dim('·'), 'kuma:    the push-monitor URL, …/api/push/<key>');
      line(dim('·'), 'webhook: any https endpoint that accepts JSON');
      return 2;
    }
    if (!['ntfy', 'gotify', 'kuma', 'webhook'].includes(type)) { line(FAIL(), `unknown channel type '${type}'`); return 2; }
    if (channels.some((c) => c.url === url)) { line(OK(), 'already configured'); return 0; }
    const ch = { type, url };
    say(`Adding ${type} channel`);
    // Prove it delivers BEFORE saving - a channel that never worked is worse
    // than none, because it feels like coverage.
    const r = await postChannel(ch, { title: 'BigBox test', message: `notifications configured on ${os.hostname()} - this channel will receive alerts`, ok: true });
    line(r.ok ? OK() : FAIL(), r.ok ? `test message delivered (${r.detail})` : `test failed: ${r.detail}`);
    if (!r.ok && !flags.yes) { line(dim('→'), 'not saved - fix the URL, or re-run with --yes to save anyway'); return 2; }
    channels.push(ch); save(channels);
    line(OK(), `saved (${NOTIFY_FILE()}, mode 600)`);
    return 0;
  }

  if (sub === 'remove') {
    const n = parseInt(args[0], 10);
    if (!n || n > channels.length) { line(FAIL(), `usage: bigbox notify remove <1..${channels.length || 1}>`); return 2; }
    const [gone] = channels.splice(n - 1, 1); save(channels);
    line(OK(), `removed ${gone.type} ${maskUrl(gone.url)}`);
    return 0;
  }

  if (sub === 'test' || sub === 'send') {
    if (!channels.length) { line(FAIL(), 'no channels configured - bigbox notify add <url>'); return 2; }
    const msg = sub === 'send' ? args.join(' ') : `test from ${os.hostname()} - if you can read this, alerts work`;
    if (!msg) { line(FAIL(), 'usage: bigbox notify send <message>'); return 2; }
    say(sub === 'test' ? 'Sending a test to every channel' : 'Sending');
    const results = await sendNotification(sub === 'test' ? 'BigBox test' : `BigBox @ ${os.hostname()}`, msg, { ok: true });
    for (const r of results) line(r.ok ? OK() : FAIL(), `${r.ch.type.padEnd(8)} ${r.detail}  ${dim(maskUrl(r.ch.url))}`);
    return results.every((r) => r.ok) ? 0 : 2;
  }

  line(FAIL(), `unknown notify subcommand '${sub}' - use: list | add | remove | test | send`);
  return 2;
}

async function cmdDigest(cfg) {
  if (!loadChannels().length) { line(FAIL(), 'no notification channels - add one first: bigbox notify add <url>'); return 2; }
  const st = readJson(STATE_FILE(), {});
  delete st.lastDigest; // force: the command means "send it now"
  writeJson600(STATE_FILE(), st);
  say('Building the daily digest');
  const sent = await maybeDailyDigest(cfg);
  line(sent ? OK() : FAIL(), sent ? 'digest sent' : 'digest could not be sent');
  return sent ? 0 : 2;
}

// ------------------------------------------------------------- watchdog ---
function watchLogPath(cfg) {
  const base = cfg.dir || path.join(os.homedir(), '.bigbox');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'bigbox-watch.log');
}

async function watchOnce(cfg, logFile, { act = true } = {}) {
  const stamp = new Date().toISOString();
  const notes = [];
  const events = {}; // subsystem key → human message; drives the alert state machine
  const svc = detectKeelService();
  const ph = detectPihole();

  const port = getPort(cfg);
  const health = await httpProbe(`http://127.0.0.1:${port}/api/health`, 5000);
  if (!health.up) {
    let msg = `Keel not answering on port ${port} (${health.err || `HTTP ${health.status}`})`;
    if (act && svc.type !== 'none') {
      const r = keelCtl(svc, 'restart');
      msg += ` → restart: ${r.ok ? 'ok' : r.detail}`;
    } else if (svc.type === 'none') {
      msg += ' - no service manager to restart it';
    }
    events.keel = msg; notes.push(msg);
  }

  if (ph.type !== 'none') {
    const d = await resolveVia('127.0.0.1');
    if (!d.ok) {
      let msg = `DNS not answering (${d.err})`;
      if (act) {
        const r = piholeState(ph) !== 'running' ? piholeCtl(ph, 'start') : piholeCtl(ph, 'restartdns');
        msg += ` → ${r.ok ? 'restarted' : r.detail}`;
      }
      events.dns = msg; notes.push(msg);
    }
  }

  const du = diskUsage(cfg.dbPath ? path.dirname(cfg.dbPath) : os.homedir());
  if (du && du.pct >= 95) {
    let msg = `disk ${du.pct}% full (${fmtBytes(du.free)} free)`;
    if (act && cfg.backupDir) {
      const r = backupPrune(cfg, flags.keep, { quiet: true });
      msg += ` → prune: ${r.detail}`;
    }
    events.disk = msg; notes.push(msg);
  }

  // Alerting is deliberately independent of --fix: a watchdog that only
  // observes should still page you.
  try { await reconcileAlerts(events); } catch { /* alerting is best-effort */ }
  try { fs.appendFileSync(logFile, `${stamp} ${notes.length ? notes.join(' | ') : 'ok'}\n`); } catch { /* log best-effort */ }
  return { stamp, notes };
}

async function cmdWatch(cfg) {
  const nodeBin = process.execPath;
  if (flags.uninstall) {
    say('Removing the BigBox watchdog service');
    if (IS_LINUX) { run('systemctl', ['--user', 'disable', '--now', 'bigbox-watch.service']); try { fs.rmSync(path.join(os.homedir(), '.config/systemd/user/bigbox-watch.service')); } catch { /* absent */ } run('systemctl', ['--user', 'daemon-reload']); }
    else if (IS_MAC) { const p = path.join(os.homedir(), 'Library/LaunchAgents/com.bigbox.watch.plist'); run('launchctl', ['unload', p]); try { fs.rmSync(p); } catch { /* absent */ } }
    else run('schtasks', ['/Delete', '/F', '/TN', 'BigBoxWatch']);
    line(OK(), 'watchdog removed');
    return 0;
  }
  if (flags.install) {
    say('Installing the BigBox watchdog as a service');
    const cmdline = `${nodeBin} ${SELF} watch --fix --interval ${flags.interval}${cfg.dir ? ` --dir ${cfg.dir}` : ''}`;
    if (IS_LINUX && have('systemctl')) {
      const unitDir = path.join(os.homedir(), '.config/systemd/user');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(path.join(unitDir, 'bigbox-watch.service'), [
        '[Unit]', 'Description=BigBox watchdog (Keel + Pi-hole self-remediation)', 'After=network.target', '',
        '[Service]', `ExecStart=${cmdline}`, 'Restart=always', 'RestartSec=30', '',
        '[Install]', 'WantedBy=default.target', '',
      ].join('\n'));
      run('systemctl', ['--user', 'daemon-reload']);
      const r = run('systemctl', ['--user', 'enable', '--now', 'bigbox-watch.service']);
      line(r.ok ? OK() : FAIL(), r.ok ? 'systemd user service bigbox-watch installed and started' : (r.err || r.out));
      run('loginctl', ['enable-linger', os.userInfo().username]);
      return r.ok ? 0 : 2;
    }
    if (IS_MAC) {
      const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.bigbox.watch.plist');
      fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bigbox.watch</string>
  <key>ProgramArguments</key><array>${[nodeBin, SELF, 'watch', '--fix', '--interval', String(flags.interval), ...(cfg.dir ? ['--dir', cfg.dir] : [])].map((s) => `<string>${s}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${watchLogPath(cfg)}</string>
  <key>StandardErrorPath</key><string>${watchLogPath(cfg)}</string>
</dict></plist>\n`);
      run('launchctl', ['unload', plist]);
      const r = run('launchctl', ['load', '-w', plist]);
      line(r.ok ? OK() : FAIL(), r.ok ? 'launchd agent com.bigbox.watch installed' : (r.err || r.out));
      return r.ok ? 0 : 2;
    }
    if (IS_WIN) {
      const r = run('schtasks', ['/Create', '/F', '/TN', 'BigBoxWatch', '/SC', 'ONLOGON', '/TR', `"${nodeBin}" "${SELF}" watch --fix --interval ${flags.interval}`]);
      if (r.ok) run('schtasks', ['/Run', '/TN', 'BigBoxWatch']);
      line(r.ok ? OK() : FAIL(), r.ok ? 'scheduled task BigBoxWatch registered and started' : (r.err || r.out));
      return r.ok ? 0 : 2;
    }
    line(FAIL(), 'no supported service manager found');
    return 2;
  }

  // Foreground loop
  const logFile = watchLogPath(cfg);
  const channels = loadChannels();
  say(`BigBox watchdog - every ${flags.interval}s${flags.fix ? ', self-remediating' : ' (observe only - add --fix to remediate)'} · log: ${logFile}`);
  line(channels.length ? OK() : WARN(), channels.length
    ? `alerts go to ${channels.length} channel(s): ${[...new Set(channels.map((c) => c.type))].join(', ')}`
    : 'no notification channels - failures will only reach this log. Add one: bigbox notify add <url>');
  for (;;) {
    const result = await watchOnce(cfg, logFile, { act: flags.fix });
    try { await maybeDailyDigest(cfg); } catch { /* digest is best-effort */ }
    line(result.notes.length ? WARN() : OK(), `${result.stamp} - ${result.notes.length ? result.notes.join(' | ') : 'all healthy'}`);
    await new Promise((r) => setTimeout(r, flags.interval * 1000));
  }
}

// --------------------------------------------------------------- remote ---
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * The shell snippet run on the far side.
 *
 * `node /dev/stdin` looks tempting and cannot work: when stdin is a pipe,
 * Node's module loader resolves /dev/stdin to /proc/<pid>/fd/pipe:[inode] and
 * fails with ENOENT. So land the script in a temp file first, run that, and
 * remove it - preserving the script's exit code, which carries health status.
 */
function remoteCommand(cliArgs) {
  return 'f="${TMPDIR:-/tmp}/.bigbox-$$.mjs"; cat > "$f" && node "$f" '
    + cliArgs.map(shq).join(' ')
    + '; rc=$?; rm -f "$f"; exit $rc';
}

/**
 * Reuse one SSH connection across calls (ControlMaster), so a GUI polling
 * every 15s pays the handshake once. Windows' OpenSSH has no multiplexing.
 * batch=true refuses password prompts - right for the GUI, which has no
 * terminal to prompt on; the CLI leaves them interactive.
 */
/**
 * Where the multiplexed connection's socket lives, or null to skip
 * multiplexing.
 *
 * A Unix socket path must fit in sockaddr_un - 104 bytes on macOS - and while
 * setting the master up, SSH appends its own ~17-character random suffix. The
 * obvious ControlPath=$TMPDIR/...-%C blows that budget on macOS, where TMPDIR
 * is a long /var/folders/… path and %C is a 40-char hash. So: a short home
 * directory, a short hash, and a length check that gives up rather than fail
 * the connection.
 */
function controlPath() {
  try {
    const dir = path.join(os.homedir(), '.bigbox');
    fs.mkdirSync(dir, { recursive: true });
    const tag = createHash('sha1').update(String(flags.host)).digest('hex').slice(0, 8);
    const p = path.join(dir, `s-${tag}`);
    return p.length <= 80 ? p : null;
  } catch {
    return null;
  }
}

function sshOpts(batch) {
  const opts = batch ? ['-o', 'BatchMode=yes'] : [];
  // Windows' OpenSSH has no connection multiplexing.
  const cp = IS_WIN ? null : controlPath();
  if (cp) {
    opts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${cp}`, '-o', 'ControlPersist=60');
  }
  return opts;
}

async function remote() {
  const args = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--host') { i++; continue; }
    args.push(a[i]);
  }
  const child = spawn('ssh', [...sshOpts(false), flags.host, remoteCommand([...args, '--no-color'])], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', () => { /* remote closed early; its exit code is the story */ });
  child.stdin.end(fs.readFileSync(SELF));
  return new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
}

// ------------------------------------------------------------------- env ---
// Setting a variable on a containerised Keel means editing a compose file you
// have to find first, remembering that a plain .env beside it is only used for
// ${VAR} substitution, and knowing that `docker restart` will not pick the
// change up. That is three chances to get it wrong, so the tool does it.

const SECRET_KEY = /PASS|SECRET|KEY|TOKEN|DATABASE_URL/i;

/** Where variables for this install should be written, and how to apply them. */
function envTarget(cfg) {
  const svc = detectKeelService();
  if (svc.type === 'docker') {
    const label = (k) => run('docker', ['inspect', '-f', `{{index .Config.Labels "${k}"}}`, svc.name]).out.trim();
    const workdir = label('com.docker.compose.project.working_dir');
    const configs = label('com.docker.compose.project.config_files');
    const service = label('com.docker.compose.service');
    if (workdir && configs && service) {
      // config_files can list several, comma-separated; the first is the base.
      const composeFile = path.isAbsolute(configs.split(',')[0])
        ? configs.split(',')[0]
        : path.join(workdir, configs.split(',')[0]);
      return {
        kind: 'compose',
        file: path.join(workdir, 'bigbox.env'),
        composeFile, workdir, service, container: svc.name,
      };
    }
    return { kind: 'docker-plain', container: svc.name };
  }
  if (cfg.dir) return { kind: 'dotenv', file: path.join(cfg.dir, '.env'), svc };
  return { kind: 'none' };
}

function readEnvFile(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}

/**
 * Upsert KEY=VALUE lines, preserving comments, order and anything already
 * there. Values are written unquoted: docker compose's env_file parser keeps
 * quotes literally, so "abc" would arrive as a value including the quotes.
 */
function upsertEnv(lines, pairs) {
  const out = lines.slice();
  const changed = [];
  for (const [k, v] of pairs) {
    if (/[\n\r]/.test(v)) throw new Error(`value for ${k} contains a newline`);
    const idx = out.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    const before = idx >= 0 ? out[idx].slice(out[idx].indexOf('=') + 1).trim() : null;
    const next = `${k}=${v}`;
    if (idx >= 0) {
      if (out[idx] !== next) { out[idx] = next; changed.push({ k, from: before, to: v }); }
    } else {
      while (out.length && out.at(-1).trim() === '') out.pop();
      out.push(next);
      changed.push({ k, from: null, to: v });
    }
  }
  if (out.at(-1) !== '') out.push('');
  return { lines: out, changed };
}

/**
 * Make sure the service actually loads our env file. Line-based rather than a
 * YAML round-trip: this edits someone's hand-written compose file, and a
 * reformat that silently drops their comments would be a poor trade for a
 * two-line insertion. The original is backed up first.
 */
function wireEnvFile(composeFile, service, envFileName) {
  const src = fs.readFileSync(composeFile, 'utf8');
  const lines = src.split(/\r?\n/);
  const svcIdx = lines.findIndex((l) => new RegExp(`^(\\s+)${service}\\s*:\\s*$`).test(l));
  if (svcIdx < 0) return { ok: false, reason: `service "${service}" not found in ${composeFile}` };

  const svcIndent = lines[svcIdx].match(/^(\s*)/)[1].length;
  let end = svcIdx + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== '' && l.match(/^(\s*)/)[1].length <= svcIndent) break;
    end++;
  }
  const block = lines.slice(svcIdx + 1, end);
  const childIndent = ' '.repeat(
    block.find((l) => l.trim())?.match(/^(\s*)/)[1].length ?? svcIndent + 2
  );

  const rel = envFileName;
  const efIdx = block.findIndex((l) => new RegExp(`^${childIndent}env_file\\s*:`).test(l));
  if (efIdx >= 0) {
    const inline = block[efIdx].match(/^\s*env_file\s*:\s*(\S.*)$/);
    if (inline && inline[1] && !inline[1].startsWith('[')) {
      // Scalar form: env_file: other.env → convert to a list holding both.
      if (inline[1].trim() === rel) return { ok: true, already: true };
      block.splice(efIdx, 1, `${childIndent}env_file:`, `${childIndent}  - ${inline[1].trim()}`, `${childIndent}  - ${rel}`);
    } else {
      let i = efIdx + 1;
      const items = [];
      while (i < block.length && /^\s*-\s+/.test(block[i])) { items.push(block[i].trim().replace(/^-\s*/, '')); i++; }
      if (items.includes(rel)) return { ok: true, already: true };
      block.splice(i, 0, `${childIndent}  - ${rel}`);
    }
  } else {
    block.unshift(`${childIndent}env_file:`, `${childIndent}  - ${rel}`);
  }

  const updated = [...lines.slice(0, svcIdx + 1), ...block, ...lines.slice(end)].join('\n');
  const backup = `${composeFile}.bigbox-bak`;
  if (!flags.dryRun) {
    fs.copyFileSync(composeFile, backup);
    fs.writeFileSync(composeFile, updated);
  }
  return { ok: true, wired: true, backup, preview: updated };
}

function applyEnv(target) {
  if (target.kind === 'compose') {
    // Recreate, not restart: environment is fixed when a container is created,
    // so `docker restart` would keep the old values and look like a no-op.
    const r = run('docker', ['compose', '-f', target.composeFile, 'up', '-d'], { timeout: 300000 });
    if (r.ok) return { ok: true, detail: 'container recreated with the new environment' };
    const legacy = run('docker-compose', ['-f', target.composeFile, 'up', '-d'], { timeout: 300000 });
    return legacy.ok
      ? { ok: true, detail: 'container recreated (docker-compose v1)' }
      : { ok: false, detail: (r.err || r.out || '').split('\n').slice(-3).join(' ') };
  }
  if (target.kind === 'dotenv') return keelCtl(target.svc, 'restart');
  return { ok: false, detail: 'nothing to apply' };
}

async function cmdEnv(cfg, sub, args) {
  const target = envTarget(cfg);
  if (target.kind === 'none') { line(FAIL(), 'no Keel install found - pass --dir'); return 2; }
  if (target.kind === 'docker-plain') {
    line(FAIL(), `container ${target.container} was not created by docker compose`);
    line(dim('·'), 'recreate it with `docker run -e KEY=VALUE …`, or move the stack to compose');
    return 2;
  }

  if (sub === 'path') { console.log(target.file); return 0; }

  if (!sub || sub === 'show' || sub === 'list') {
    say(`Environment for Keel - ${target.kind === 'compose' ? `compose service “${target.service}”` : 'local install'}`);
    line(dim('·'), `file: ${target.file}${fs.existsSync(target.file) ? '' : dim(' (not created yet)')}`);
    if (target.kind === 'compose') line(dim('·'), `compose: ${target.composeFile}`);
    console.log();
    const shown = readEnvFile(target.file).filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (shown.length) {
      say('Set by bigbox');
      for (const l of shown) {
        const [k, ...rest] = l.split('=');
        line(dim('·'), `${bold(k.trim())}=${SECRET_KEY.test(k) ? dim('<set, hidden>') : rest.join('=')}`);
      }
    } else {
      line(dim('·'), 'this file has nothing in it yet');
    }
    if (target.kind === 'compose') {
      console.log();
      say('Live in the container');
      const live = run('docker', ['exec', target.container, 'env']).out.split('\n')
        .filter((l) => /^(KEEL_|GOOGLE_|GITHUB_|MS_|DATABASE_URL|PORT|HOSTNAME|NODE_ENV)/.test(l));
      for (const l of live.sort()) {
        const [k, ...rest] = l.split('=');
        line(dim('·'), `${bold(k)}=${SECRET_KEY.test(k) ? dim('<set, hidden>') : rest.join('=')}`);
      }
    }
    console.log();
    line(dim('→'), `set one with: ${bold('bigbox env set KEY=VALUE')}`);
    return 0;
  }

  if (sub !== 'set' && sub !== 'unset') {
    line(FAIL(), `unknown env subcommand '${sub}' - use: show | set | unset | path`);
    return 2;
  }

  const pairs = [];
  for (const a of args) {
    if (sub === 'unset') { pairs.push([a.trim(), null]); continue; }
    const eq = a.indexOf('=');
    if (eq < 1) { line(FAIL(), `expected KEY=VALUE, got '${a}'`); return 2; }
    pairs.push([a.slice(0, eq).trim(), a.slice(eq + 1)]);
  }
  if (!pairs.length) { line(FAIL(), `nothing to ${sub}`); return 2; }

  say(`${sub === 'set' ? 'Setting' : 'Removing'} ${pairs.length} variable(s)`);
  let lines = readEnvFile(target.file);
  let changed = [];
  if (sub === 'unset') {
    for (const [k] of pairs) {
      const before = lines.length;
      lines = lines.filter((l) => !new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
      if (lines.length !== before) changed.push({ k, from: 'set', to: null });
    }
  } else {
    try { ({ lines, changed } = upsertEnv(lines, pairs)); }
    catch (e) { line(FAIL(), String(e.message)); return 2; }
  }

  if (!changed.length) { line(OK(), 'already exactly as requested - nothing to do'); return 0; }
  for (const c of changed) {
    const val = c.to === null ? dim('(removed)') : SECRET_KEY.test(c.k) ? dim('<hidden>') : c.to;
    line(dim('·'), `${bold(c.k)} ${c.from === null ? 'added' : 'updated'} → ${val}`);
  }

  if (flags.dryRun) { line(WARN(), 'dry run - nothing written'); return 0; }

  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, lines.join('\n'));
    if (!IS_WIN) fs.chmodSync(target.file, 0o600); // these are secrets
  } catch (e) {
    line(FAIL(), `cannot write ${target.file}: ${e.message}`);
    if (e.code === 'EACCES') line(dim('·'), `that directory is root-owned - re-run with sudo, or: sudo chown ${os.userInfo().username} ${path.dirname(target.file)}`);
    return 2;
  }
  line(OK(), `wrote ${target.file} (mode 600)`);

  if (target.kind === 'compose') {
    const w = wireEnvFile(target.composeFile, target.service, path.basename(target.file));
    if (!w.ok) { line(FAIL(), w.reason); return 2; }
    if (w.already) line(OK(), `${path.basename(target.composeFile)} already loads ${path.basename(target.file)}`);
    else line(OK(), `added env_file: ${path.basename(target.file)} to ${path.basename(target.composeFile)} (backup: ${path.basename(w.backup)})`);
  }

  say('Applying');
  const r = applyEnv(target);
  line(r.ok ? OK() : FAIL(), r.detail);
  if (!r.ok) return 2;

  if (target.kind === 'compose') {
    await new Promise((res) => setTimeout(res, 3000));
    const live = run('docker', ['exec', target.container, 'env']).out;
    for (const [k] of pairs) {
      const present = new RegExp(`^${k}=`, 'm').test(live);
      if (sub === 'set') line(present ? OK() : WARN(), `${k} ${present ? 'is live in the container' : 'is NOT visible in the container - check the compose file'}`);
      else line(present ? WARN() : OK(), `${k} ${present ? 'is still set (defined elsewhere in compose?)' : 'is gone'}`);
    }
  }
  return 0;
}

// ------------------------------------------------------------------- gui ---
// A local web UI. The server shells out to this very script for every panel -
// locally, or over SSH when --host is set - so the GUI can never drift from
// what the CLI reports, and a Mac can drive a headless box with no agent
// installed on it.

function cliRun(args, timeout = 180000) {
  const extra = [];
  if (flags.dir) extra.push('--dir', flags.dir);
  if (flags.port) extra.push('--port', String(flags.port));
  const full = [...args, ...extra, '--no-color'];
  const r = flags.host
    ? spawnSync('ssh', [...sshOpts(true), flags.host, remoteCommand(full)], {
      input: fs.readFileSync(SELF), encoding: 'utf8', timeout, windowsHide: true,
    })
    : spawnSync(process.execPath, [SELF, ...full], { encoding: 'utf8', timeout, windowsHide: true });
  return {
    code: r.status ?? -1,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim() || (r.error ? String(r.error.message) : ''),
  };
}

/** One line the user can act on, instead of a Node stack trace in a banner. */
function briefError(r) {
  const raw = `${r.err || ''}\n${r.out || ''}`.trim();
  const first = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || `no output (exit ${r.code})`;
  let hint = '';
  if (/permission denied|publickey|authentication failed/i.test(raw)) {
    hint = ` - SSH could not authenticate. Check your key works: ssh ${flags.host}`;
  } else if (/node: (command )?not found|not found: node/i.test(raw)) {
    hint = ' - Node 20+ is not installed on that machine';
  } else if (/could not resolve hostname|connection (refused|timed out)|no route to host/i.test(raw)) {
    hint = ' - cannot reach that host';
  } else if (/host key verification failed/i.test(raw)) {
    hint = ` - unknown host key. Connect once manually first: ssh ${flags.host}`;
  }
  return first.slice(0, 300) + hint;
}

function cliJson(args) {
  const r = cliRun(args);
  // Exit codes carry health (1 = warnings, 2 = problems), so a non-zero exit
  // is expected here - only unparseable output is an actual error.
  try {
    return { ok: true, data: JSON.parse(r.out) };
  } catch {
    return { ok: false, error: briefError(r) };
  }
}

// Every button the UI can press, named here so a request body can never
// become a command line.
const GUI_ACTIONS = {
  'restart-keel': { label: 'Restart Keel', args: ['restart', 'keel'] },
  'start-keel': { label: 'Start Keel', args: ['start', 'keel'] },
  'stop-keel': { label: 'Stop Keel', args: ['stop', 'keel'] },
  'restart-pihole': { label: 'Restart Pi-hole', args: ['restart', 'pihole'] },
  'restart-dns': { label: 'Restart DNS', args: ['restart', 'dns'] },
  'doctor-fix': { label: 'Run doctor --fix', args: ['doctor', '--fix'] },
  'backup-now': { label: 'Back up now', args: ['backup', 'now'] },
  'backup-verify': { label: 'Verify newest backup', args: ['backup', 'verify'] },
  'backup-prune': { label: 'Prune old snapshots', args: ['backup', 'prune'] },
  'update': { label: 'Update Keel', args: ['update'] },
  'gravity': { label: 'Update Pi-hole gravity', args: ['pihole', '-g'] },
};

function openBrowser(url) {
  if (IS_MAC) return run('open', [url]);
  if (IS_WIN) return run('cmd', ['/c', 'start', '', url]);
  return run('xdg-open', [url]);
}

// No cfg parameter: every panel is produced by re-running the CLI (locally or
// over SSH), so the server never reads the local install itself.
async function cmdGui() {
  if (flags.installApp) return installMacApp();

  const http = await import('node:http');
  const token = randomToken();
  const port = flags.guiPort || 7717;
  const bind = flags.bind || '127.0.0.1';
  const label = flags.host || os.hostname();

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      // This page can restart services; never let another origin frame or
      // script it, and never leak the token in a referrer.
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
    });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // A browser on another machine can be lured into requesting a name that
    // resolves here (DNS rebinding). When we are bound to loopback, only
    // loopback Host headers are legitimate.
    if (bind === '127.0.0.1') {
      const host = (req.headers.host || '').split(':')[0];
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
        return send(res, 403, JSON.stringify({ error: 'bad host header' }));
      }
    }

    const supplied = url.searchParams.get('t')
      || req.headers['x-bigbox-token']
      || (req.headers.cookie || '').match(/bigbox-token=([a-f0-9]+)/)?.[1];
    if (supplied !== token) {
      return send(res, 401, 'Unauthorized - open the URL printed in the terminal.', 'text/plain; charset=utf-8');
    }

    try {
      if (url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          // Drop the token from the address bar into a cookie so it stops
          // travelling in URLs the moment the page loads.
          'Set-Cookie': `bigbox-token=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return res.end(guiHtml(label, flags.host ? 'remote' : 'local'));
      }
      if (url.pathname === '/api/status') {
        const r = cliJson(['status', '--json']);
        return send(res, 200, JSON.stringify(r));
      }
      if (url.pathname === '/api/net') {
        const r = cliJson(['net', '--json']);
        return send(res, 200, JSON.stringify(r));
      }
      if (url.pathname === '/api/text') {
        const which = url.searchParams.get('view');
        const views = {
          paths: ['paths'],
          backups: ['backup', 'list'],
          'logs-keel': ['logs', 'keel', '-n', url.searchParams.get('lines') || '200'],
          'logs-pihole': ['logs', 'pihole', '-n', url.searchParams.get('lines') || '200'],
          doctor: ['doctor'],
        };
        if (!views[which]) return send(res, 400, JSON.stringify({ error: 'unknown view' }));
        const r = cliRun(views[which]);
        return send(res, 200, JSON.stringify({ text: r.out || r.err || '(no output)' }));
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const body = await new Promise((resolve) => {
          let b = '';
          req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
          req.on('end', () => resolve(b));
        });
        let name = '';
        try { name = JSON.parse(body || '{}').action; } catch { /* invalid json → unknown action */ }
        const act = GUI_ACTIONS[name];
        if (!act) return send(res, 400, JSON.stringify({ error: 'unknown action' }));
        const r = cliRun(act.args, 900000);
        return send(res, 200, JSON.stringify({
          ok: r.code === 0, label: act.label, output: r.out || r.err || '(no output)',
        }));
      }
      return send(res, 404, JSON.stringify({ error: 'not found' }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, bind, resolve);
    });
  } catch (e) {
    if (e?.code === 'EADDRINUSE') {
      line(FAIL(), `port ${port} is already in use - another ${bold('bigbox gui')} is probably running.`);
      line(dim('·'), `Use its window, stop it with Ctrl+C, or start this one on another port: ${bold(`bigbox gui --gui-port ${port + 1}`)}`);
      return 2;
    }
    if (e?.code === 'EADDRNOTAVAIL') {
      line(FAIL(), `cannot listen on ${bind} - no interface on this machine has that address`);
      return 2;
    }
    throw e;
  }

  const shown = bind === '127.0.0.1' ? '127.0.0.1' : bind;
  const link = `http://${shown}:${port}/?t=${token}`;
  say(`BigBox GUI - managing ${bold(label)}${flags.host ? dim(' (over SSH)') : ''}`);
  line(OK(), `open ${bold(link)}`);
  if (bind !== '127.0.0.1') {
    line(WARN(), `bound to ${bind} - anyone who can reach that address and the token can restart services`);
  }
  line(dim('·'), 'Ctrl+C to stop.');
  if (!flags.noOpen) openBrowser(link);
  await new Promise(() => { /* serve until interrupted */ });
  return 0;
}

/** The GUI's session token - this guards service restarts, so: real CSPRNG. */
function randomToken() {
  return randomBytes(24).toString('hex');
}

/** Wrap the GUI in a double-clickable .app so macOS treats it like an app. */
function installMacApp() {
  if (!IS_MAC) { line(FAIL(), '--install-app is macOS-only (Linux/Windows launchers: see the README)'); return 2; }
  const appDir = path.join(os.homedir(), 'Applications', 'BigBox.app');
  const macos = path.join(appDir, 'Contents', 'MacOS');
  const resources = path.join(appDir, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  const args = [flags.host ? `--host ${flags.host}` : '', flags.dir ? `--dir ${flags.dir}` : '']
    .filter(Boolean).join(' ');
  const launcher = `#!/bin/sh
# Generated by bigbox - re-run \`bigbox gui --install-app\` to refresh.
exec "${process.execPath}" "${SELF}" gui ${args}
`;
  fs.writeFileSync(path.join(macos, 'BigBox'), launcher, { mode: 0o755 });

  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>BigBox</string>
  <key>CFBundleDisplayName</key><string>BigBox</string>
  <key>CFBundleIdentifier</key><string>dev.bigbox.manager</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>BigBox</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- The GUI opens in the default browser; this process is only the server. -->
  <key>LSUIElement</key><true/>
</dict></plist>
`);

  const icon = buildAppIcon(resources);
  line(OK(), `installed ${appDir}`);
  line(dim('·'), icon ? 'icon generated' : 'no icon (needs sips + iconutil) - the app still works');
  line(dim('·'), 'find it in Finder → Applications, or Spotlight "BigBox". Drag it to the Dock to keep it.');
  return 0;
}

/**
 * Write Resources/AppIcon.icns. The PNG is generated here rather than shipped
 * as a binary blob, so this file stays the single self-contained script that
 * can be streamed over SSH.
 */
function buildAppIcon(resources) {
  if (!have('sips') || !have('iconutil')) return false;
  try {
    const png = makeIconPng(512);
    const tmp = path.join(resources, 'icon-512.png');
    fs.writeFileSync(tmp, png);
    const iconset = path.join(resources, 'AppIcon.iconset');
    fs.mkdirSync(iconset, { recursive: true });
    for (const [size, name] of [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'],
      [64, 'icon_32x32@2x'], [128, 'icon_128x128'], [256, 'icon_128x128@2x'],
      [256, 'icon_256x256'], [512, 'icon_256x256@2x'], [512, 'icon_512x512']]) {
      run('sips', ['-z', String(size), String(size), tmp, '--out', path.join(iconset, `${name}.png`)]);
    }
    const r = run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
    return r.ok;
  } catch {
    return false;
  }
}

/** A minimal PNG encoder - rounded gradient tile with a white box glyph. */
function makeIconPng(size) {
  const zlib = createRequire(import.meta.url)('node:zlib');
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const inset = size * 0.28, thick = size * 0.075;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded-rect mask
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) { px[i + 3] = 0; continue; }
      // Diagonal gradient, slate → indigo
      const t = (x + y) / (2 * size);
      px[i] = Math.round(30 + t * 50);
      px[i + 1] = Math.round(41 + t * 40);
      px[i + 2] = Math.round(59 + t * 120);
      px[i + 3] = 255;
      // Box glyph: an open-topped crate outline
      const inBox = x > inset && x < size - inset && y > inset * 1.05 && y < size - inset * 0.85;
      const inHollow = x > inset + thick && x < size - inset - thick
        && y > inset * 1.05 + thick && y < size - inset * 0.85 - thick;
      const lid = y > inset * 0.72 && y < inset * 1.05 - thick * 0.15
        && x > inset - thick && x < size - inset + thick;
      if ((inBox && !inHollow) || lid) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
    }
  }
  // Raw scanlines with filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The whole UI: one page, no build step, no external requests (the CSP above
// blocks them anyway). Client script avoids template literals so it can live
// inside this one.
function guiHtml(label, mode) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BigBox - ${escapeHtml(label)}</title>
<style>
  :root {
    --bg:#0f1115; --panel:#161a22; --elev:#1c212b; --border:#262d3a;
    --fg:#e6e9ef; --muted:#9aa4b6; --faint:#6b7688;
    --ok:#3fb950; --warn:#d29922; --fail:#f85149; --accent:#6e8bff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg:#f6f7f9; --panel:#fff; --elev:#fff; --border:#e2e5ea;
      --fg:#12151b; --muted:#5b6472; --faint:#8b95a5;
      --ok:#1a7f37; --warn:#9a6700; --fail:#cf222e; --accent:#3f5fd0;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    padding:14px 20px; background:var(--panel); border-bottom:1px solid var(--border);
    position:sticky; top:0; z-index:5; }
  h1 { font-size:16px; margin:0; letter-spacing:-.01em; }
  .chip { font-size:12px; color:var(--muted); background:var(--elev);
    border:1px solid var(--border); border-radius:999px; padding:3px 10px; }
  .spacer { flex:1; }
  nav { display:flex; gap:2px; padding:0 20px; background:var(--panel);
    border-bottom:1px solid var(--border); overflow-x:auto; }
  nav button { background:none; border:none; border-bottom:2px solid transparent;
    color:var(--muted); padding:10px 14px; font-size:13px; cursor:pointer; white-space:nowrap; }
  nav button:hover { color:var(--fg); }
  nav button.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .banner { border-radius:10px; padding:14px 16px; margin-bottom:18px;
    border:1px solid var(--border); background:var(--panel); font-weight:600; display:flex; gap:10px; align-items:center; }
  .banner.ok { border-color:color-mix(in srgb,var(--ok) 45%,var(--border)); }
  .banner.warn { border-color:color-mix(in srgb,var(--warn) 45%,var(--border)); }
  .banner.fail { border-color:color-mix(in srgb,var(--fail) 45%,var(--border)); }
  /* align-items:start so a long path in one card doesn't stretch its whole row */
  .grid { display:grid; gap:10px; align-items:start;
    grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    padding:12px 14px; display:flex; gap:10px; align-items:flex-start; }
  .dot { width:9px; height:9px; border-radius:50%; margin-top:6px; flex:none; background:var(--faint); }
  .dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.fail{background:var(--fail)}
  .card .name { font-weight:600; font-size:13px; }
  .card .detail { color:var(--muted); font-size:12.5px; word-break:break-word; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
    color:var(--faint); margin:26px 0 10px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; }
  button.act { background:var(--elev); color:var(--fg); border:1px solid var(--border);
    border-radius:8px; padding:8px 13px; font-size:13px; cursor:pointer; }
  button.act:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  button.act:disabled { opacity:.5; cursor:progress; }
  button.act.danger:hover:not(:disabled) { border-color:var(--fail); color:var(--fail); }
  pre { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    padding:14px; overflow:auto; max-height:60vh; font-size:12.5px; line-height:1.55;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; }
  .out { position:sticky; bottom:0; margin-top:20px; }
  .out h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--faint); margin:0 0 8px; }
  .row { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
  label.tgl { font-size:12.5px; color:var(--muted); display:flex; align-items:center; gap:6px; cursor:pointer; }
  .step { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); }
  .step:last-child { border-bottom:none; }
  .step .n { font-weight:600; font-size:13px; min-width:190px; }
  .muted { color:var(--muted); }
  .spin { display:inline-block; width:11px; height:11px; border:2px solid var(--border);
    border-top-color:var(--accent); border-radius:50%; animation:s .7s linear infinite; }
  @keyframes s { to { transform:rotate(360deg); } }
</style></head><body>
<header>
  <h1>BigBox</h1>
  <span class="chip" id="host">${escapeHtml(label)}</span>
  <span class="chip">${mode === 'remote' ? 'over SSH' : 'local'}</span>
  <span class="spacer"></span>
  <span class="chip" id="stamp">loading…</span>
  <label class="tgl"><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button class="act" id="refresh">Refresh</button>
</header>
<nav>
  <button data-tab="overview" class="on">Overview</button>
  <button data-tab="network">Network</button>
  <button data-tab="backups">Backups</button>
  <button data-tab="logs">Logs</button>
  <button data-tab="paths">Paths</button>
</nav>
<main>
  <div id="overview">
    <div class="banner" id="banner"><span class="spin"></span> checking…</div>
    <div class="grid" id="checks"></div>
    <h2>Services</h2>
    <div class="actions">
      <button class="act" data-act="restart-keel">Restart Keel</button>
      <button class="act" data-act="restart-pihole">Restart Pi-hole</button>
      <button class="act" data-act="restart-dns">Restart DNS</button>
      <button class="act danger" data-act="stop-keel">Stop Keel</button>
      <button class="act" data-act="start-keel">Start Keel</button>
    </div>
    <h2>Repair &amp; maintenance</h2>
    <div class="actions">
      <button class="act" data-act="doctor-fix">Run doctor --fix</button>
      <button class="act" data-act="gravity">Update Pi-hole gravity</button>
      <button class="act danger" data-act="update">Update Keel</button>
    </div>
  </div>

  <div id="network" hidden>
    <div class="banner" id="netbanner"><span class="spin"></span> not run yet</div>
    <div class="card" style="display:block"><div id="netsteps" class="muted">Press “Run test”.</div></div>
    <div class="row" style="margin-top:12px"><button class="act" id="runnet">Run test</button>
      <button class="act" data-act="restart-dns">Restart DNS</button></div>
  </div>

  <div id="backups" hidden>
    <div class="actions" style="margin-bottom:12px">
      <button class="act" data-act="backup-now">Back up now</button>
      <button class="act" data-act="backup-verify">Verify newest</button>
      <button class="act danger" data-act="backup-prune">Prune old</button>
    </div>
    <pre id="backupsout">loading…</pre>
  </div>

  <div id="logs" hidden>
    <div class="row">
      <select class="act" id="logtarget"><option value="logs-keel">Keel</option><option value="logs-pihole">Pi-hole</option></select>
      <select class="act" id="loglines"><option>100</option><option selected>200</option><option>500</option></select>
      <button class="act" id="loadlogs">Load</button>
      <label class="tgl"><input type="checkbox" id="logfollow"> follow (10s)</label>
    </div>
    <pre id="logsout">Press “Load”.</pre>
  </div>

  <div id="paths" hidden><pre id="pathsout">loading…</pre></div>

  <div class="out" id="outwrap" hidden>
    <h3 id="outtitle">Output</h3>
    <pre id="out"></pre>
  </div>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var loaded = {};

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json(); });
  }

  function show(tab) {
    ['overview','network','backups','logs','paths'].forEach(function (t) {
      $(t).hidden = t !== tab;
    });
    document.querySelectorAll('nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    if (tab === 'backups' && !loaded.backups) loadText('backups', 'backupsout');
    if (tab === 'paths' && !loaded.paths) loadText('paths', 'pathsout');
  }
  document.querySelectorAll('nav button').forEach(function (b) {
    b.onclick = function () { show(b.dataset.tab); };
  });

  function loadText(view, target, lines) {
    loaded[view] = true;
    var url = '/api/text?view=' + encodeURIComponent(view) + (lines ? '&lines=' + lines : '');
    $(target).textContent = 'loading…';
    return api(url).then(function (d) { $(target).textContent = d.text || d.error || '(empty)'; })
      .catch(function (e) { $(target).textContent = 'failed: ' + e; });
  }

  function renderStatus(d) {
    if (!d.ok) {
      $('banner').className = 'banner fail';
      $('banner').textContent = 'Could not reach BigBox: ' + (d.error || 'unknown error');
      return;
    }
    var checks = d.data.checks || [];
    var fails = checks.filter(function (c) { return c.level === 'fail'; }).length;
    var warns = checks.filter(function (c) { return c.level === 'warn'; }).length;
    var b = $('banner');
    b.className = 'banner ' + (fails ? 'fail' : warns ? 'warn' : 'ok');
    b.textContent = fails ? (fails + ' problem' + (fails > 1 ? 's' : '') + ' - try “Run doctor --fix”')
      : warns ? (warns + ' warning' + (warns > 1 ? 's' : ''))
      : 'Everything looks healthy';
    $('checks').innerHTML = '';
    checks.forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'card';
      var dot = document.createElement('span');
      dot.className = 'dot ' + (c.level === 'info' ? '' : c.level);
      var body = document.createElement('div');
      var n = document.createElement('div'); n.className = 'name'; n.textContent = c.name;
      var t = document.createElement('div'); t.className = 'detail'; t.textContent = c.detail;
      body.appendChild(n); body.appendChild(t);
      card.appendChild(dot); card.appendChild(body);
      $('checks').appendChild(card);
    });
    $('stamp').textContent = new Date().toLocaleTimeString();
  }

  function refresh() {
    return api('/api/status').then(renderStatus).catch(function (e) {
      $('banner').className = 'banner fail';
      $('banner').textContent = 'Request failed: ' + e;
    });
  }
  $('refresh').onclick = refresh;

  function runAction(name) {
    var all = document.querySelectorAll('button.act[data-act]');
    all.forEach(function (b) { b.disabled = true; });
    $('outwrap').hidden = false;
    $('outtitle').textContent = 'Running…';
    $('out').textContent = '';
    return api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: name })
    }).then(function (d) {
      $('outtitle').textContent = (d.ok ? '✓ ' : '✗ ') + (d.label || name);
      $('out').textContent = d.output || d.error || '(no output)';
      $('out').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // An action can change what the open tab is showing (a new snapshot, a
      // pruned one); reload it rather than leaving a stale list on screen.
      loaded.backups = false;
      if (!$('backups').hidden) loadText('backups', 'backupsout');
      return refresh();
    }).catch(function (e) {
      $('outtitle').textContent = '✗ ' + name;
      $('out').textContent = String(e);
    }).finally(function () {
      all.forEach(function (b) { b.disabled = false; });
    });
  }
  document.querySelectorAll('button.act[data-act]').forEach(function (b) {
    b.onclick = function () {
      var name = b.dataset.act;
      var risky = { 'stop-keel': 1, 'update': 1, 'backup-prune': 1 };
      if (risky[name] && !confirm('Run “' + b.textContent.trim() + '” on ' + $('host').textContent + '?')) return;
      runAction(name);
    };
  });

  $('runnet').onclick = function () {
    $('netbanner').className = 'banner';
    $('netbanner').innerHTML = '<span class="spin"></span> walking the stack…';
    $('netsteps').textContent = '';
    api('/api/net').then(function (d) {
      if (!d.ok) { $('netbanner').className = 'banner fail'; $('netbanner').textContent = d.error; return; }
      var g = d.data;
      $('netbanner').className = 'banner ' + g.diagnosis.level;
      $('netbanner').textContent = (g.diagnosis.title ? g.diagnosis.title + ' ' : '') + g.diagnosis.text;
      $('netsteps').innerHTML = '';
      g.steps.forEach(function (s) {
        var row = document.createElement('div'); row.className = 'step';
        var dot = document.createElement('span'); dot.className = 'dot ' + (s.ok ? 'ok' : 'fail');
        var n = document.createElement('div'); n.className = 'n'; n.textContent = s.name;
        var t = document.createElement('div'); t.className = 'muted'; t.textContent = s.detail;
        row.appendChild(dot); row.appendChild(n); row.appendChild(t);
        $('netsteps').appendChild(row);
      });
    });
  };

  $('loadlogs').onclick = function () {
    loadText($('logtarget').value, 'logsout', $('loglines').value);
  };
  setInterval(function () {
    if ($('logfollow').checked && !$('logs').hidden) $('loadlogs').onclick();
  }, 10000);

  setInterval(function () { if ($('auto').checked) refresh(); }, 15000);
  refresh();
})();
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ----------------------------------------------------------------- help ---
function help() {
  console.log(`${bold('bigbox')} ${VERSION} - troubleshoot and manage your BigBox (Keel + Pi-hole)

${bold('Usage:')} bigbox <command> [options]

${bold('Everyday')}
  gui                         open the dashboard in your browser (see below)
  status                      one-screen health dashboard (exit code 0/1/2)
  doctor [--fix] [--dry-run]  full diagnostics; --fix self-remediates what it can
  restart keel|pihole|dns|all also: start, stop
  logs keel|pihole [-f] [-n N]
  net [--fix]                 walk the network stack layer by layer and say what broke

${bold('Data')}
  backup now                  consistent SQLite snapshot + .env copy into the backup folder
  backup list                 everything in the backup folder (app backups + snapshots)
  backup prune [--keep N]     delete old bigbox snapshots (default keep 10)
  backup verify               integrity-check the newest snapshot
  paths                       where the database, backups, configs and logs live
  env [show]                  Keel's environment: what bigbox sets, what's live
  env set KEY=VALUE …         write it, wire it into compose, recreate, verify
  env unset KEY …             remove it and apply

${bold('Care & feeding')}
  update [--yes]              update Keel in place (snapshot → git → build → restart)
  pihole <args…>              pass-through: bigbox pihole -g · bigbox pihole disable 5m
  report                      redacted support bundle (markdown) for sharing
  notify add <url>            alert channel: ntfy, Gotify, Uptime Kuma push, or webhook
  notify test | send <msg>    prove alerts actually reach your phone
  digest                      send the once-a-day summary now
  watch [--fix]               watchdog loop; --install registers it as a boot service
  watch --install|--uninstall

${bold('Options')}
  --dir PATH        Keel install directory (default: auto-detect, or $KEEL_DIR)
  --port N          Keel's HTTP port (default: .env PORT, docker's published port, or 3000)
  --host USER@HOST  run any command on the box over SSH (needs Node there - Keel guarantees it)
  --json            machine-readable output for status/doctor/net
  --interval N      watchdog period in seconds (default 300)
  --no-color, -y/--yes, -V/--version, -h/--help

${bold('GUI options')}
  --gui-port N      port for the dashboard        (default 7717)
  --bind ADDR       listen address                (default 127.0.0.1 - see the README before changing)
  --no-open         don't launch a browser
  --install-app     macOS: install ~/Applications/BigBox.app that opens the GUI

${bold('Examples')}
  bigbox gui                          # dashboard for this machine
  bigbox gui --host chris@bigbox      # …on your Mac, managing the box over SSH
  bigbox gui --install-app --host chris@bigbox   # macOS: a real app icon for that
  bigbox status
  bigbox doctor --fix
  bigbox restart keel
  bigbox net                          # "is it the ISP, the router, or Pi-hole?"
  bigbox backup now && bigbox backup verify
  bigbox --host admin@bigbox status   # from your laptop
  bigbox pihole disable 5m            # pause blocking for 5 minutes`);
}

// ----------------------------------------------------------------- main ---
(async () => {
  // `gui` is the one command that stays local when --host is set: the server
  // runs here and reaches the box over SSH per request.
  if (flags.host && words[0] !== 'gui') process.exit(await remote());

  const cmd = words[0] || 'status';
  const cfg = keelConfig();
  let rc = 0;
  switch (cmd) {
    case 'help': help(); break;
    case 'status': rc = await cmdStatus(cfg); break;
    case 'doctor': rc = await cmdDoctor(cfg); break;
    case 'start': case 'stop': case 'restart': {
      const target = words[1] || 'keel';
      if (!['keel', 'pihole', 'dns', 'all'].includes(target)) { line(FAIL(), `unknown target '${target}' - use keel | pihole | dns | all`); rc = 2; break; }
      rc = await cmdCtl(cfg, cmd, target);
      break;
    }
    case 'logs': rc = await cmdLogs(cfg, words[1] || 'keel'); break;
    case 'backup': rc = await cmdBackup(cfg, words[1] || 'now'); break;
    case 'paths': case 'where': rc = cmdPaths(cfg); break;
    case 'net': rc = await cmdNet(cfg); break;
    case 'pihole': rc = await cmdPihole(words.slice(1)); break;
    case 'update': rc = await cmdUpdate(cfg); break;
    case 'report': rc = await cmdReport(cfg); break;
    case 'watch': rc = await cmdWatch(cfg); break;
    case 'gui': rc = await cmdGui(); break;
    case 'env': rc = await cmdEnv(cfg, words[1], words.slice(2)); break;
    case 'notify': rc = await cmdNotify(words[1], words.slice(2)); break;
    case 'digest': rc = await cmdDigest(cfg); break;
    case 'fix': flags.fix = true; rc = await cmdDoctor(cfg); break;
    default:
      line(FAIL(), `unknown command '${cmd}'`);
      console.log();
      help();
      rc = 2;
  }
  process.exit(rc);
})().catch((e) => {
  console.error(`${FAIL()} unexpected error: ${e?.stack || e}`);
  process.exit(2);
});
