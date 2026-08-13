// Builds the Keel desktop app for the current OS (Windows .exe installer or
// Linux AppImage/deb). Usage:
//
//   npm run desktop:build            # build for this OS
//   node scripts/desktop-build.mjs --dir   # unpacked app only (fast, for testing)
//
// Steps: regenerate schema.sql → standalone Next build → assemble the server
// bundle → electron-builder.

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

// fileURLToPath is required for Windows (URL.pathname yields "/C:/..." there).
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
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

// 1. Schema SQL for first-run database creation inside the packaged app.
run("npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output prisma/schema.sql");

// 2. Standalone production build.
run("npx next build", { KEEL_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" });

// 3. Assemble the standalone server: static assets, schema.sql, Prisma engines.
const standalone = path.join(root, ".next", "standalone");
removeBuildMachinePath(standalone);
const copies = [
  [path.join(root, ".next", "static"), path.join(standalone, ".next", "static")],
  [path.join(root, "public"), path.join(standalone, "public")],
  [path.join(root, "prisma", "schema.sql"), path.join(standalone, "prisma", "schema.sql")],
  // Belt-and-braces: make sure the Prisma client + engine are present even if
  // file tracing missed them.
  [path.join(root, "node_modules", ".prisma"), path.join(standalone, "node_modules", ".prisma")],
  [path.join(root, "node_modules", "@prisma", "client"), path.join(standalone, "node_modules", "@prisma", "client")],
];
for (const [from, to] of copies) {
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

// 3b. Never ship local data inside the app: file tracing can pull the dev
// database and local backups into the bundle  -  scrub them.
const standalonePrisma = path.join(standalone, "prisma");
if (fs.existsSync(standalonePrisma)) {
  for (const entry of fs.readdirSync(standalonePrisma)) {
    if (entry.includes(".db")) {
      fs.rmSync(path.join(standalonePrisma, entry), { force: true });
      console.log(`scrubbed prisma/${entry}`);
    }
  }
}
for (const dir of ["backups", "logs", "dist-desktop"]) {
  const target = path.join(standalone, dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`scrubbed ${dir}/`);
  }
}

// 4. Package with electron-builder for the current platform. --publish never:
// electron-builder must not try to create GitHub releases itself (it does so
// automatically on tag builds)  -  the CI workflow handles publishing.
const dirOnly = process.argv.includes("--dir") ? " --dir" : "";
run(`npx electron-builder --config electron-builder.yml --publish never${dirOnly}`);

console.log("\nDone. Installers are in dist-desktop/");
