#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register("./ts-loader.mjs", import.meta.url);
const { prepareNamedTunnelLaunch } = await import(
  pathToFileURL(path.join(root, "src/lib/tunnel.ts")).href
);

const token = "eyJhIjoi" + "sensitive-tunnel-token".repeat(4);
const launch = prepareNamedTunnelLaunch(token);
let passed = 0;
const check = (label, condition) => {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok ${label}`);
};

try {
  check("named tunnel argv contains no token", !launch.args.some((arg) => arg.includes(token)));
  check("named tunnel uses the token-file interface", launch.args.includes("--token-file"));
  check("token file contains the exact token", fs.readFileSync(launch.tokenFile, "utf8") === token);
  if (process.platform !== "win32") {
    check("token directory is mode 0700", (fs.statSync(path.dirname(launch.tokenFile)).mode & 0o777) === 0o700);
    check("token file is mode 0600", (fs.statSync(launch.tokenFile).mode & 0o777) === 0o600);
  }
} finally {
  launch.cleanup();
}
check("token file is removed after cleanup", !fs.existsSync(launch.tokenFile));
console.log(`\nTunnel security checks passed (${passed}).`);
