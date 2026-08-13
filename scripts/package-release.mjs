#!/usr/bin/env node
// Build a distributable Keel: everything a machine needs to run the server,
// in one directory, with the `keel` CLI on top.
//
//   node scripts/package-release.mjs           # dist/keel-<version>-<os>-<arch>/  + .tar.gz
//
// The output is what a GitHub release ships, what the Homebrew formula
// unpacks. One artifact supports the release and CLI installation paths.
// Platform-specific because the Prisma query engine is a native
// binary; build on (or CI for) each platform you ship.

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertNoSensitiveArtifactPaths,
  scrubSensitiveArtifactPaths,
} from "./artifact-safety.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const platform = `${process.platform === "darwin" ? "macos" : process.platform}-${os.arch()}`;
const name = `keel-${pkg.version}-${platform}`;
const dist = path.join(root, "dist");
const out = path.join(dist, name);

const run = (cmd, env = {}) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
};

function removeBuildMachinePath(bundleRoot) {
  const serverEntry = path.join(bundleRoot, "server.js");
  const escapedRoot = JSON.stringify(root).slice(1, -1);
  const source = fs.readFileSync(serverEntry, "utf8");
  const sanitized = source.split(escapedRoot).join(".");
  fs.writeFileSync(serverEntry, sanitized);

  if (sanitized.includes(root) || sanitized.includes(escapedRoot)) {
    throw new Error("standalone server still contains the local build path");
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Fresh schema.sql + standalone build.
run("npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output prisma/schema.sql");
run("npx next build", { KEEL_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" });

// 2. Assemble the server bundle (same recipe the desktop build uses).
const standalone = path.join(root, ".next", "standalone");
const server = path.join(out, "server");
fs.cpSync(standalone, server, { recursive: true });
removeBuildMachinePath(server);
const copies = [
  [path.join(root, ".next", "static"), path.join(server, ".next", "static")],
  [path.join(root, "public"), path.join(server, "public")],
  [path.join(root, "prisma", "schema.sql"), path.join(server, "prisma", "schema.sql")],
  [path.join(root, "prisma", "migrations"), path.join(server, "prisma", "migrations")],
  [path.join(root, "node_modules", ".prisma"), path.join(server, "node_modules", ".prisma")],
  [path.join(root, "node_modules", "@prisma", "client"), path.join(server, "node_modules", "@prisma", "client")],
];
for (const [from, to] of copies) {
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

// Never ship local data or secrets: tracing can pull the dev database, local
// backups or an .env into the bundle.
for (const entry of fs.readdirSync(path.join(server, "prisma"))) {
  if (entry.includes(".db")) fs.rmSync(path.join(server, "prisma", entry), { force: true });
}
// Tracing over-approximates: it pulls in whole directories the compiled
// server never reads at runtime - including dist/, which would make every
// release contain the previous one and double in size each time.
for (const junk of [
  "backups", "logs", ".env", ".env.prod", "secrets",
  "dist", "dist-desktop", "src", "docs", "ops", "desktop", "deploy", ".git", ".github",
]) {
  fs.rmSync(path.join(server, junk), { recursive: true, force: true });
}
scrubSensitiveArtifactPaths(server);

// 3. The CLI and its package manifest.
fs.mkdirSync(path.join(out, "bin"), { recursive: true });
fs.copyFileSync(path.join(root, "bin", "keel.mjs"), path.join(out, "bin", "keel.mjs"));
fs.chmodSync(path.join(out, "bin", "keel.mjs"), 0o755);
fs.mkdirSync(path.join(out, "scripts"), { recursive: true });
fs.copyFileSync(
  path.join(root, "scripts", "claim-instance.mjs"),
  path.join(out, "scripts", "claim-instance.mjs")
);

fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "keel-notes",
      version: pkg.version,
      description: "Keel, a self-hosted notebook for pages, databases, kanban, mind maps, wikilinks, and a graph.",
      license: "BUSL-1.1",
      homepage: "https://github.com/AES256Afro/Keel",
      repository: { type: "git", url: "git+https://github.com/AES256Afro/Keel.git" },
      bin: { keel: "bin/keel.mjs" },
      engines: { node: ">=20" },
      // Everything is prebuilt - installing this package must never compile.
      scripts: {},
      os: process.platform === "darwin" ? ["darwin"] : [process.platform],
      cpu: [os.arch()],
    },
    null,
    2
  ) + "\n"
);

fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));

fs.writeFileSync(
  path.join(out, "README.md"),
  `# Keel ${pkg.version} (${platform})

Run it:

    ./bin/keel.mjs start

Or install the CLI on your PATH:

    npm install -g .

Then \`keel start\`, register an account, generate a five-minute claim token in
Keel, and run \`keel claim <token>\` to confirm instance ownership. \`keel help\`
lists status, stop, update, export, and the rest. Your data lives in ~/.keel.
`
);

// Scrubbing is defense in depth. The independent scan fails closed if tracing,
// a later copy step, or a new secret location escapes it.
assertNoSensitiveArtifactPaths(out, "release");

// 4. Tarball for the GitHub release / Homebrew.
run(`tar -czf ${JSON.stringify(path.join(dist, `${name}.tar.gz`))} -C ${JSON.stringify(dist)} ${JSON.stringify(name)}`);
const size = fs.statSync(path.join(dist, `${name}.tar.gz`)).size;
console.log(`\n✔ dist/${name}.tar.gz (${(size / 1048576).toFixed(1)} MB)`);
console.log(`✔ dist/${name}/ - test it with: node dist/${name}/bin/keel.mjs start --foreground`);
