#!/usr/bin/env node

// Render every supported Compose shape with synthetic credentials. This catches
// leaks and interpolation mistakes in the configuration Docker will actually
// run, rather than only inspecting the YAML text.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "keel-compose-check-"));
let passed = 0;

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  ok ${label}`);
}

function render(files, env) {
  const args = [
    "compose",
    "--ansi",
    "never",
    "--env-file",
    env.compose,
    "--project-name",
    "keel-compose-check",
  ];
  for (const file of files) args.push("-f", path.join(root, file));
  args.push("config", "--format", "json");

  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KEEL_APP_ENV_FILE: env.app,
      KEEL_CADDY_ENV_FILE: env.caddy,
      KEEL_HOST_PORT: "43123",
      KEEL_BOOTSTRAP_PORT: "43124",
    },
  });
  if (result.error) {
    throw new Error(`Docker Compose is required for test:compose: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`docker compose config failed:\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`docker compose config did not return JSON:\n${result.stdout}`);
  }
}

function appAssertions(label, config, expected) {
  const service = config.services?.keel;
  check(`${label}: Keel service exists`, Boolean(service));
  for (const [key, value] of Object.entries(expected)) {
    // Compose's canonical config escapes a literal runtime `$` as `$$` even
    // when raw env-file parsing correctly preserved it. Collapse that display
    // escape before comparing the value the container will receive.
    const rendered = service.environment?.[key];
    const runtimeValue = typeof rendered === "string" ? rendered.replaceAll("$$", "$") : rendered;
    check(`${label}: app receives ${key}`, runtimeValue === value);
  }
  check(`${label}: database path is container-owned`, service.environment?.DATABASE_URL === "file:/data/keel.db");
  check(`${label}: internal port cannot be overridden`, service.environment?.PORT === "3000");
  check(`${label}: HOST binds inside the container`, service.environment?.HOST === "0.0.0.0");
  check(`${label}: HOSTNAME binds inside the container`, service.environment?.HOSTNAME === "0.0.0.0");
  check(`${label}: token claim remains required`, service.environment?.KEEL_CLAIM_REQUIRED === "1");
  check(`${label}: backup path stays on persistent storage`, service.environment?.KEEL_BACKUP_DIR === "/data/backups");
  check(`${label}: app does not run as root through Compose`, service.user !== "root" && service.user !== "0");
  check(
    `${label}: Docker daemon socket is not mounted`,
    !(service.volumes ?? []).some((volume) => JSON.stringify(volume).includes("/var/run/docker.sock"))
  );
  check(
    `${label}: persistent data mount uses the keel-data logical volume`,
    (service.volumes ?? []).some((volume) => volume.source === "keel-data" && volume.target === "/data")
  );
  check(
    `${label}: volume remains project-scoped for upgrade compatibility`,
    config.volumes?.["keel-data"]?.name === "keel-compose-check_keel-data"
  );
}

function loopbackPort(service, published) {
  return (service.ports ?? []).some(
    (port) =>
      port.target === 3000 &&
      String(port.published) === published &&
      port.host_ip === "127.0.0.1"
  );
}

const literalSecret = "literal-$not-expanded-${still-literal}-secret";
const expectedApp = {
  KEEL_ALLOWED_EMAILS: "owner@example.test,reader@example.test",
  KEEL_DISABLE_SIGNUP: "1",
  GOOGLE_CLIENT_ID: "google-client.apps.example.test",
  GOOGLE_CLIENT_SECRET: literalSecret,
  MS_CLIENT_ID: "00000000-0000-4000-8000-000000000000",
  MS_CLIENT_SECRET: "microsoft-$literal-secret",
  KEEL_BACKUP_PASSPHRASE: "backup-$literal-passphrase",
  KEEL_PUBLIC_URL: "https://notes.example.test",
};

const files = {
  compose: path.join(scratch, "compose.env"),
  app: path.join(scratch, "app.env"),
  caddy: path.join(scratch, "caddy.env"),
};

try {
  fs.writeFileSync(files.compose, "", { mode: 0o600 });
  fs.writeFileSync(
    files.app,
    [
      ...Object.entries(expectedApp).map(([key, value]) => `${key}=${value}`),
      "DATABASE_URL=postgresql://wrong:wrong@db.example.test/wrong",
      "PORT=9999",
      "HOST=wrong.example.test",
      "HOSTNAME=wrong.example.test",
      "KEEL_CLAIM_REQUIRED=0",
      "KEEL_DOMAINS=must-not-configure-caddy.example.test",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  fs.writeFileSync(files.caddy, "KEEL_DOMAINS=notes.example.test\n", { mode: 0o600 });

  const local = render(["docker-compose.yml"], files);
  appAssertions("local", local, expectedApp);
  check("local: no environment owner override bypasses token claim", local.services.keel.environment?.KEEL_OWNER_EMAIL === undefined);
  check("local: app port is published only on loopback", loopbackPort(local.services.keel, "43123"));
  check(
    "local: no wildcard host port exists",
    !(local.services.keel.ports ?? []).some((port) => !port.host_ip || port.host_ip === "0.0.0.0")
  );

  const production = render(["docker-compose.prod.yml"], files);
  appAssertions("production", production, expectedApp);
  check(
    "production: canonical OAuth/WebAuthn origin remains public HTTPS",
    production.services.keel.environment?.KEEL_PUBLIC_URL === "https://notes.example.test"
  );
  check("production: token claim is not bypassed by an environment owner", production.services.keel.environment?.KEEL_OWNER_EMAIL === undefined);
  check("production: app has no public host port", !(production.services.keel.ports?.length > 0));
  check(
    "production: Caddy receives only KEEL_DOMAINS",
    JSON.stringify(production.services.caddy.environment) ===
      JSON.stringify({ KEEL_DOMAINS: "notes.example.test" })
  );
  const caddyConfig = JSON.stringify(production.services.caddy);
  for (const value of Object.values(expectedApp)) {
    check("production: application secret or setting is absent from Caddy", !caddyConfig.includes(value));
  }
  check(
    "production: the application env cannot replace Caddy's hostname",
    !caddyConfig.includes("must-not-configure-caddy.example.test")
  );

  const bootstrap = render(
    ["docker-compose.prod.yml", "docker-compose.bootstrap.yml"],
    files
  );
  appAssertions("bootstrap", bootstrap, {
    ...expectedApp,
    KEEL_PUBLIC_URL: "http://localhost:43124",
  });
  check(
    "bootstrap: canonical origin follows the SSH-forwarded loopback URL",
    bootstrap.services.keel.environment?.KEEL_PUBLIC_URL === "http://localhost:43124"
  );
  check("bootstrap: token claim is not bypassed by an environment owner", bootstrap.services.keel.environment?.KEEL_OWNER_EMAIL === undefined);
  check(
    "bootstrap: temporary app port is loopback-only",
    loopbackPort(bootstrap.services.keel, "43124")
  );
  check(
    "bootstrap: Caddy still receives only its hostname",
    JSON.stringify(bootstrap.services.caddy.environment) ===
      JSON.stringify({ KEEL_DOMAINS: "notes.example.test" })
  );

  console.log(`\nCompose deployment checks passed (${passed}).`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
